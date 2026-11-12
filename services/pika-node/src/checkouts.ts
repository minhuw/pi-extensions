/**
 * Checkouts on the node (NODE.md §4 "Checkouts"): every path the daemon considers (configured, a repository under a
 * root, a live terminal's cwd) folded into the checkout of its git common dir's real path, or a configured folder; the
 * list every browser shares, kept fresh by watching git's files; the edits `config.json` keeps (`checkouts`,
 * `hiddenCheckouts`, `checkoutNames`, `checkoutSettings`); and git worktrees made and removed in a checkout.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch as watchPath, type FSWatcher } from "node:fs";
import { access, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep, win32 } from "node:path";
import { NodeError } from "./errors.ts";
import { LIMITS, utf8Length, type BranchRemoval, type Checkout, type CheckoutSettings, type Worktree } from "./protocol.ts";
import { decideRepository, listRemotes, parseProjectConfig, PROJECT_CONFIG, projectFromCommonDir } from "./repository.ts";
import { roots, type Config } from "./store.ts";

export interface CheckoutList { checkouts: Checkout[]; truncated: boolean }

/** Watched changes are folded into one scan this long after the last. */
export const WATCH_DEBOUNCE_MS = 300;
/** Roots (and everything else) are scanned again this often. */
export const RESCAN_MS = 60_000;
/** Room for the reply or event around the checkouts in one record. */
const RECORD_SLACK = 512;
/** git processes one scan runs at once. */
const GIT_CONCURRENCY = 8;

// ---------------------------------------------------------------------------------------------------------------
// git

interface GitResult { code: number | null; stdout: string; stderr: string }

/** The environment for git: no prompts, and nothing that points it at another repository than the cwd's. */
function gitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("GIT_")) env[name] = value;
    env.GIT_TERMINAL_PROMPT = "0";
    return env;
}

/** Runs git in `cwd`; never rejects. `code` is null when git could not run or timed out. */
function git(cwd: string, args: string[], timeout = 10_000): Promise<GitResult> {
    return new Promise(resolvePromise => {
        execFile("git", ["-C", cwd, ...args], { env: gitEnv(), timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
            const code = error ? typeof error.code === "number" ? error.code : null : 0;
            resolvePromise({ code, stdout, stderr });
        });
    });
}

/** What git said when it failed, for an error message. */
const gitMessage = (result: GitResult): string => result.stderr.trim() || (result.code === null ? "git did not run or timed out" : `git exited with ${result.code}`);

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

/** A checkout's id: the first 32 hex characters of the SHA-256 of its common dir's (or folder's) real path. */
export const checkoutId = (realPath: string): string => createHash("sha256").update(realPath, "utf8").digest("hex").slice(0, 32);

const UNBORN = /^0+$/;

/**
 * `git worktree list --porcelain -z`, in git's order: records of NUL-ended `key value` fields, each record ended by an
 * empty field. The main worktree comes first; a bare repository's own entry (`bare`) is no worktree and is left out.
 */
export function parseWorktrees(output: string): Worktree[] {
    const worktrees: Worktree[] = [];
    let record: string[] = [];
    let first = true;
    const flush = () => {
        if (record.length === 0) return;
        const fields = record;
        record = [];
        const main = first;
        first = false;
        const path = fields.find(field => field.startsWith("worktree "))?.slice("worktree ".length);
        if (!path || fields.includes("bare")) return;
        const head = fields.find(field => field.startsWith("HEAD "))?.slice("HEAD ".length);
        const branch = fields.find(field => field.startsWith("branch "))?.slice("branch ".length);
        const flag = (name: string) => fields.some(field => field === name || field.startsWith(`${name} `));
        worktrees.push({
            path,
            ...(branch ? { branch: branch.replace(/^refs\/heads\//, "") } : {}),
            ...(head && !UNBORN.test(head) ? { head } : {}),
            isMain: main, prunable: flag("prunable"), locked: flag("locked"), detached: flag("detached"),
        });
    };
    for (const field of output.split("\0")) {
        if (field === "") flush();
        else record.push(field);
    }
    flush();
    return worktrees;
}

/**
 * Orca's slug for a worktree's folder (`sanitizeWorktreeName`, orca `src/main/ipc/worktree-logic.ts`, MIT), as NODE.md
 * states it: each run of characters other than letters, digits, `.`, `_`, `-` becomes one `-`, and leading and trailing
 * `.` and `-` are dropped. An empty slug is `invalid`.
 */
export function worktreeSlug(name: string): string {
    const slug = name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+|[.-]+$/g, "");
    if (!slug) throw new NodeError("invalid", `${JSON.stringify(name)} gives no folder name`);
    return slug;
}

/**
 * Where a new worktree of the main worktree `main` goes: `<location ?? parent of main>/<repo>-<slug>`, Orca's layout for
 * a repository on an SSH host (`computeRemoteWorktreePath`, orca `src/main/ipc/worktree-logic.ts`), which a node is to
 * Deck.
 */
export const worktreeTarget = (main: string, name: string, location?: string): string => join(location ?? dirname(main), `${basename(main)}-${worktreeSlug(name)}`);

/** Whether `path` is `dir` or lies inside it. */
export const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

export interface Placement { checkoutId: string; worktreePath: string }

/**
 * The checkout and worktree holding `cwd`: of every listed checkout's worktrees (a folder's own path), the innermost
 * that holds it. Undefined when none does.
 */
export function place(cwd: string, checkouts: readonly Checkout[]): Placement | undefined {
    let best: Placement | undefined;
    for (const checkout of checkouts) {
        const paths = checkout.kind === "folder" ? [checkout.path] : checkout.worktrees.map(worktree => worktree.path);
        for (const path of paths) {
            if (inside(cwd, path) && (!best || path.length > best.worktreePath.length)) best = { checkoutId: checkout.id, worktreePath: path };
        }
    }
    return best;
}

/** Sorted by name case-insensitively, then path; at most `maxCheckouts`, and no more than fits one record. */
export function listOf(found: Checkout[]): CheckoutList {
    const key = (checkout: Checkout) => checkout.name.toLowerCase();
    const sorted = [...found].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const checkouts = sorted.slice(0, LIMITS.maxCheckouts);
    const bytes = () => utf8Length(JSON.stringify({ type: "checkouts.changed", checkouts, truncated: true })) + RECORD_SLACK;
    while (checkouts.length && bytes() > LIMITS.maxRecordBytes) checkouts.pop();
    return { checkouts, truncated: checkouts.length < sorted.length };
}

/** The folder name of a repository whose name is no valid project name, so `project` is never empty. */
const rawName = (commonDir: string): string => {
    const base = win32.basename(commonDir);
    return (base === ".git" ? win32.basename(win32.dirname(commonDir)) : base.replace(/\.git$/, "")) || commonDir;
};

// ---------------------------------------------------------------------------------------------------------------
// Locating paths

type Located = { kind: "git"; commonDir: string; at: string } | { kind: "folder"; path: string };

/** A directory's real path: `not_found` when it does not exist, `not_a_directory` for anything else. */
export async function realDirectory(path: string): Promise<string> {
    let real: string;
    try { real = await realpath(path); }
    catch { throw new NodeError("not_found", `no directory ${path}`); }
    if (!(await stat(real)).isDirectory()) throw new NodeError("not_a_directory", `${path} is not a directory`);
    return real;
}

/**
 * What `path` belongs to: the git common dir's real path (`at` is where to ask git about it), else the folder itself.
 * Undefined when the directory is gone or git did not answer. `--git-common-dir` is printed relative to the cwd by git
 * before 2.31 (and sometimes after), so it is resolved against it.
 */
async function locate(path: string): Promise<Located | undefined> {
    let real: string;
    try {
        real = await realpath(path);
        if (!(await stat(real)).isDirectory()) return undefined;
    } catch { return undefined; }
    const result = await git(real, ["rev-parse", "--git-common-dir"], 5_000);
    if (result.code === null) return undefined;
    if (result.code !== 0) return { kind: "folder", path: real };
    const printed = result.stdout.replace(/\r?\n$/, "");
    try { return { kind: "git", commonDir: await realpath(resolve(real, printed)), at: real }; }
    catch { return undefined; }
}

/** Every directory one level below a root that holds `.git` (a symlinked one too). */
async function discover(dirs: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const root of dirs) {
        let entries;
        try { entries = await readdir(root, { withFileTypes: true }); }
        catch { continue; }
        const children = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(root, entry.name));
        const holds = await mapLimit(children, 32, async child => {
            try { await access(join(child, ".git")); return true; }
            catch { return false; }
        });
        children.forEach((child, index) => { if (holds[index]) found.push(child); });
    }
    return found;
}

async function mapLimit<T, R>(items: T[], limit: number, each: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await each(items[index]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/** A scanned checkout and what to watch for it. */
interface Found { checkout: Checkout; watch: Map<string, Set<string> | null> }

async function readProjectJson(checkout: string) {
    try { return parseProjectConfig(await readFile(join(checkout, PROJECT_CONFIG), "utf8")); }
    catch { return undefined; }
}

/** A git checkout from its common dir: worktrees, remotes, and `project.json`, by `resolveRepository`'s rules. */
async function gitCheckout(commonDir: string, at: string, source: Checkout["source"], config: Config, log: (line: string) => void): Promise<Found> {
    const id = checkoutId(commonDir);
    const [listed, remotes] = await Promise.all([
        git(at, ["worktree", "list", "--porcelain", "-z"]),
        git(at, ["config", "-z", "--get-regexp", "^(remote\\..*\\.url|url\\..*\\.insteadof)$"]),
    ]);
    if (listed.code !== 0) log(`checkout ${commonDir}: git worktree list failed: ${gitMessage(listed)}`);
    let all = listed.code === 0 ? parseWorktrees(listed.stdout) : [];
    all = await Promise.all(all.map(async worktree => {
        try { return { ...worktree, path: await realpath(worktree.path) }; }
        catch { return worktree; }
    }));
    const worktrees = all.slice(0, LIMITS.maxWorktrees);
    const main = all.find(worktree => worktree.isMain);
    // The rules of resolveRepository (extensions/pika/repository.ts): `project.json` lives in the main checkout, the
    // common dir's parent for a `.git` dir.
    const checkoutDir = win32.basename(commonDir) === ".git" ? dirname(commonDir) : undefined;
    const projectConfig = checkoutDir ? await readProjectJson(checkoutDir) : undefined;
    const { info } = decideRepository({
        folder: projectFromCommonDir(commonDir),
        ...(checkoutDir ? { checkout: checkoutDir } : {}),
        remotes: remotes.code === 0 ? listRemotes(remotes.stdout) : [],
    }, projectConfig);
    const project = info.project ?? rawName(commonDir);
    const name = config.checkoutNames?.[id];
    const watch = new Map<string, Set<string> | null>([[commonDir, new Set(["HEAD", "config", "worktrees"])]]);
    try {
        const admin = join(commonDir, "worktrees");
        const entries = await readdir(admin, { withFileTypes: true });
        watch.set(admin, null);
        for (const entry of entries) if (entry.isDirectory()) watch.set(join(admin, entry.name), new Set(["HEAD", "locked", "gitdir"]));
    } catch { /* no linked worktrees yet; the common dir's watch sees `worktrees` appear */ }
    if (checkoutDir) {
        // `.pi/pika/project.json`, watched from the deepest directory that exists so its creation is seen too.
        watch.set(checkoutDir, new Set([".pi"]));
        watch.set(join(checkoutDir, ".pi"), new Set(["pika"]));
        watch.set(join(checkoutDir, ".pi", "pika"), new Set(["project.json"]));
    }
    const checkout: Checkout = {
        id, kind: "git", path: main?.path ?? checkoutDir ?? commonDir, commonDir,
        ...(info.repository ? { repository: info.repository } : {}),
        project, name: name ?? project, ...(name ? { named: true as const } : {}),
        source, settings: config.checkoutSettings?.[id] ?? {}, worktrees,
        ...(all.length > worktrees.length ? { truncated: true as const } : {}),
    };
    return { checkout, watch };
}

function folderCheckout(path: string, source: Checkout["source"], config: Config): Found {
    const id = checkoutId(path);
    const project = basename(path) || path;
    const name = config.checkoutNames?.[id];
    return {
        checkout: { id, kind: "folder", path, project, name: name ?? project, ...(name ? { named: true as const } : {}), source, settings: {}, worktrees: [] },
        watch: new Map(),
    };
}

// ---------------------------------------------------------------------------------------------------------------

export interface CheckoutsOptions {
    config: () => Config;
    save: (config: Config) => void;
    /** Live terminals' cwds (live as last seen, else start), real paths. */
    terminalCwds: () => string[];
    /** After every scan, with the list (placement may have changed without the list changing). */
    scanned: (list: CheckoutList, changed: boolean) => void;
    log: (line: string) => void;
    debounceMs?: number;
    rescanMs?: number;
}

export interface WorktreeCreated { checkout: Checkout; worktree: Worktree; main: string }

export class Checkouts {
    #options: CheckoutsOptions;
    /** Every checkout the last scan found, hidden ones included, by id. */
    #all = new Map<string, Checkout>();
    #list: CheckoutList = { checkouts: [], truncated: false };
    /** The last list `scanned` reported as changed, encoded. */
    #sent: string | undefined;
    #current: Promise<CheckoutList> | undefined;
    #next: Promise<CheckoutList> | undefined;
    /** Edits one after another, so two requests cannot drop each other's change. */
    #edits: Promise<unknown> = Promise.resolve();
    #watchers = new Map<string, { watcher: FSWatcher; names: Set<string> | null }>();
    #debounce: NodeJS.Timeout | undefined;
    #rescan: NodeJS.Timeout;
    #disposed = false;

    constructor(options: CheckoutsOptions) {
        this.#options = options;
        this.#rescan = setInterval(() => this.#background(), options.rescanMs ?? RESCAN_MS);
        this.#rescan.unref();
    }

    /** The list as of the last scan. */
    get list(): CheckoutList { return this.#list; }

    /** Scans in the background (a watched change, a terminal moved), WATCH_DEBOUNCE_MS after the last call. */
    poke(): void {
        if (this.#disposed) return;
        if (this.#debounce) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => { this.#debounce = undefined; this.#background(); }, this.#options.debounceMs ?? WATCH_DEBOUNCE_MS);
        this.#debounce.unref();
    }

    #background(): void {
        this.scan().catch((error: Error) => this.#options.log(`checkouts scan failed: ${error.message}`));
    }

    /** A scan that starts after this call (one running already is followed by one more, shared by its callers). */
    scan(): Promise<CheckoutList> {
        if (!this.#current) return this.#start();
        this.#next ??= this.#current.catch(() => {}).then(() => {
            this.#next = undefined;
            return this.#start();
        });
        return this.#next;
    }

    #start(): Promise<CheckoutList> {
        const run = this.#scanOnce().finally(() => { if (this.#current === run) this.#current = undefined; });
        this.#current = run;
        return run;
    }

    async #scanOnce(): Promise<CheckoutList> {
        const config = this.#options.config();
        const candidates: { path: string; source: Checkout["source"] }[] = [
            ...(config.checkouts ?? []).map(path => ({ path, source: "configured" as const })),
            ...(await discover(roots(config))).map(path => ({ path, source: "discovered" as const })),
            ...[...new Set(this.#options.terminalCwds())].map(path => ({ path, source: "terminal" as const })),
        ];
        const located = await mapLimit(candidates, GIT_CONCURRENCY, candidate => locate(candidate.path));
        // Dedupe: every path folds into its common dir's real path (or, configured only, the folder's); the first source wins.
        const groups = new Map<string, { located: Located; source: Checkout["source"] }>();
        candidates.forEach((candidate, index) => {
            const found = located[index];
            if (!found || (found.kind === "folder" && candidate.source !== "configured")) return;
            const key = found.kind === "git" ? found.commonDir : found.path;
            if (!groups.has(key)) groups.set(key, { located: found, source: candidate.source });
        });
        const found = await mapLimit([...groups.values()], GIT_CONCURRENCY, async ({ located, source }) => located.kind === "git"
            ? gitCheckout(located.commonDir, located.at, source, config, this.#options.log)
            : folderCheckout(located.path, source, config));
        if (this.#disposed) return this.#list;
        this.#all = new Map(found.map(item => [item.checkout.id, item.checkout]));
        const hidden = new Set(config.hiddenCheckouts ?? []);
        const visible = found.filter(item => !hidden.has(item.checkout.id));
        this.#list = listOf(visible.map(item => item.checkout));
        const listed = new Set(this.#list.checkouts.map(checkout => checkout.id));
        this.#watch(visible.filter(item => listed.has(item.checkout.id)));
        const encoded = JSON.stringify(this.#list);
        const changed = encoded !== this.#sent;
        this.#sent = encoded;
        this.#options.scanned(this.#list, changed);
        return this.#list;
    }

    /** Watches each listed git checkout's files; closes watches no longer wanted. */
    #watch(found: Found[]): void {
        const wanted = new Map<string, Set<string> | null>();
        for (const item of found) for (const [dir, names] of item.watch) wanted.set(dir, names);
        for (const [dir, entry] of this.#watchers) {
            if (wanted.has(dir)) continue;
            entry.watcher.close();
            this.#watchers.delete(dir);
        }
        for (const [dir, names] of wanted) {
            const current = this.#watchers.get(dir);
            if (current) { current.names = names; continue; }
            let watcher: FSWatcher;
            try {
                watcher = watchPath(dir, { persistent: false }, (_event, filename) => {
                    const entry = this.#watchers.get(dir);
                    if (!entry || entry.watcher !== watcher) return;
                    if (entry.names === null || !filename || entry.names.has(String(filename))) this.poke();
                });
            } catch { continue; /* absent (a `.pi` not yet made); the parent's watch sees it appear */ }
            watcher.on("error", () => {
                watcher.close();
                if (this.#watchers.get(dir)?.watcher === watcher) this.#watchers.delete(dir);
                this.poke();
            });
            this.#watchers.set(dir, { watcher, names });
        }
    }

    /** The number of directories watched (tests). */
    get watched(): number { return this.#watchers.size; }

    dispose(): void {
        this.#disposed = true;
        clearInterval(this.#rescan);
        if (this.#debounce) clearTimeout(this.#debounce);
        for (const entry of this.#watchers.values()) entry.watcher.close();
        this.#watchers.clear();
    }

    // -----------------------------------------------------------------------------------------------------------
    // Edits

    #edit<T>(change: () => Promise<T>): Promise<T> {
        const next = this.#edits.then(change);
        this.#edits = next.catch(() => {});
        return next;
    }

    /** Applies `change` to `config.json` and saves it, dropping emptied keys. */
    #change(change: (config: Config) => void): void {
        const config = this.#options.config();
        change(config);
        if (config.checkouts?.length === 0) delete config.checkouts;
        if (config.hiddenCheckouts?.length === 0) delete config.hiddenCheckouts;
        if (config.checkoutNames && Object.keys(config.checkoutNames).length === 0) delete config.checkoutNames;
        if (config.checkoutSettings && Object.keys(config.checkoutSettings).length === 0) delete config.checkoutSettings;
        this.#options.save(config);
    }

    /** A listed checkout, scanning again once when the last scan does not list it. */
    async #listed(id: string): Promise<Checkout> {
        const find = () => this.#list.checkouts.find(checkout => checkout.id === id);
        const checkout = find() ?? (await this.scan(), find());
        if (!checkout) throw new NodeError("not_found", `no checkout ${id}`);
        return checkout;
    }

    #listedNow(id: string): Checkout {
        const checkout = this.#list.checkouts.find(item => item.id === id) ?? this.#all.get(id);
        if (!checkout) throw new NodeError("not_found", `no checkout ${id}`);
        return checkout;
    }

    /** `checkout.add`: records the main worktree (a bare repository's directory) or the folder; it leaves `hiddenCheckouts`. */
    add(path: string): Promise<Checkout> {
        return this.#edit(async () => {
            const real = await realDirectory(path);
            const located = await locate(real);
            if (!located) throw new NodeError("io", `git did not answer for ${real}`);
            let record: string;
            let id: string;
            if (located.kind === "git") {
                id = checkoutId(located.commonDir);
                const listed = await git(located.at, ["worktree", "list", "--porcelain", "-z"]);
                if (listed.code !== 0) throw new NodeError("io", `git worktree list failed: ${gitMessage(listed)}`);
                const main = parseWorktrees(listed.stdout).find(worktree => worktree.isMain);
                record = main ? await realpath(main.path) : located.commonDir;
            } else {
                id = checkoutId(located.path);
                record = located.path;
            }
            this.#change(config => {
                if (!(config.checkouts ?? []).includes(record)) config.checkouts = [...(config.checkouts ?? []), record];
                config.hiddenCheckouts = config.hiddenCheckouts?.filter(item => item !== id);
            });
            await this.scan();
            return this.#listedNow(id);
        });
    }

    /** `checkout.hide`: the id joins `hiddenCheckouts`; `checkouts` is left alone, so `unhide` undoes it exactly. */
    hide(id: string): Promise<void> {
        return this.#edit(async () => {
            const hidden = () => (this.#options.config().hiddenCheckouts ?? []).includes(id);
            if (hidden()) return;
            if (!this.#all.has(id)) await this.scan();
            if (!this.#all.has(id)) throw new NodeError("not_found", `no checkout ${id}`);
            this.#change(config => { config.hiddenCheckouts = [...(config.hiddenCheckouts ?? []), id]; });
            await this.scan();
        });
    }

    /** `checkout.unhide`: the id leaves `hiddenCheckouts`; `not_found` when it was not hidden or is no longer found. */
    unhide(id: string): Promise<Checkout> {
        return this.#edit(async () => {
            if (!(this.#options.config().hiddenCheckouts ?? []).includes(id)) throw new NodeError("not_found", `checkout ${id} is not hidden`);
            this.#change(config => { config.hiddenCheckouts = config.hiddenCheckouts?.filter(item => item !== id); });
            await this.scan();
            return this.#listedNow(id);
        });
    }

    /** `checkout.update`: the node's name for a listed checkout, and its settings replaced whole. */
    update(id: string, change: { name?: string | null; settings?: CheckoutSettings }): Promise<Checkout> {
        return this.#edit(async () => {
            const checkout = await this.#listed(id);
            let settings: CheckoutSettings | undefined;
            if (change.settings !== undefined) {
                if (checkout.kind === "folder") throw new NodeError("invalid", "a folder checkout takes no settings");
                settings = { ...change.settings };
                if (settings.worktreeLocation !== undefined) settings.worktreeLocation = await realDirectory(settings.worktreeLocation);
            }
            this.#change(config => {
                if (change.name !== undefined) {
                    const names = { ...(config.checkoutNames ?? {}) };
                    const name = change.name?.trim();
                    if (name && name !== checkout.project) names[id] = name;
                    else delete names[id];
                    config.checkoutNames = names;
                }
                if (settings !== undefined) {
                    const all = { ...(config.checkoutSettings ?? {}) };
                    if (Object.keys(settings).length) all[id] = settings;
                    else delete all[id];
                    config.checkoutSettings = all;
                }
            });
            await this.scan();
            return this.#listedNow(id);
        });
    }

    /**
     * `worktree.create`'s git part: checks the branch, the path, and the base, then `git worktree add -b <name> <path>
     * <base>` in the main worktree. The daemon starts the setup terminal.
     */
    createWorktree(id: string, name: string, base?: string): Promise<WorktreeCreated> {
        return this.#edit(async () => {
            const checkout = await this.#listed(id);
            if (checkout.kind === "folder") throw new NodeError("invalid", "a folder checkout has no worktrees");
            const main = checkout.worktrees.find(worktree => worktree.isMain);
            if (!main) throw new NodeError("invalid", "a bare repository has no main worktree to branch from");
            // `--branch` also expands `@{-1}`, so the name must come back as given.
            const format = name.startsWith("-") ? undefined : await git(main.path, ["check-ref-format", "--branch", name]);
            if (!format || format.code !== 0 || format.stdout.replace(/\r?\n$/, "") !== name) throw new NodeError("invalid", `${JSON.stringify(name)} is not a valid branch name`);
            const branch = await git(main.path, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
            if (branch.code === 0) throw new NodeError("exists", `a branch named ${name} already exists`);
            const target = worktreeTarget(main.path, name, checkout.settings.worktreeLocation);
            if (await lstat(target).then(() => true, () => false)) throw new NodeError("exists", `${target} already exists`);
            const from = base ?? checkout.settings.worktreeBase ?? "HEAD";
            if (from.startsWith("-")) throw new NodeError("invalid", `${JSON.stringify(from)} is not a commit`);
            const commit = await git(main.path, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`]);
            if (commit.code !== 0) throw new NodeError("not_found", `no commit ${from} in ${main.path}`);
            const added = await git(main.path, ["worktree", "add", "-b", name, target, from], 120_000);
            if (added.code !== 0) throw new NodeError("io", `git worktree add failed: ${gitMessage(added)}`);
            const real = await realpath(target);
            await this.scan();
            const fresh = this.#listedNow(id);
            const worktree = fresh.worktrees.find(item => item.path === real);
            if (!worktree) throw new NodeError("io", `git worktree list does not show ${real}`);
            return { checkout: fresh, worktree, main: main.path };
        });
    }

    /**
     * `worktree.remove`'s git part: `git worktree remove <path>` (never `--force`; git's refusal is `conflict`), or `git
     * worktree prune` for a prunable entry, then `git branch -d` with `deleteBranch`. `ready` runs first, inside the edit
     * (the daemon's busy check).
     */
    removeWorktree(id: string, path: string, options: { deleteBranch: boolean; ready: (checkout: Checkout, worktree: Worktree) => Promise<void> }): Promise<{ checkout: Checkout; branch?: BranchRemoval }> {
        return this.#edit(async () => {
            const checkout = await this.#listed(id);
            const real = await realpath(path).catch(() => path);
            const worktree = checkout.worktrees.find(item => item.path === real || item.path === path);
            if (!worktree) throw new NodeError("not_found", `${path} is no worktree of ${checkout.path}`);
            if (worktree.isMain) throw new NodeError("invalid", `${path} is the main worktree`);
            await options.ready(checkout, worktree);
            if (worktree.prunable) {
                const pruned = await git(checkout.path, ["worktree", "prune"]);
                if (pruned.code !== 0) throw new NodeError("io", `git worktree prune failed: ${gitMessage(pruned)}`);
            } else {
                const removed = await git(checkout.path, ["worktree", "remove", worktree.path], 60_000);
                if (removed.code !== 0) throw new NodeError("conflict", gitMessage(removed));
            }
            let branch: BranchRemoval | undefined;
            if (options.deleteBranch && worktree.branch) {
                const deleted = await git(checkout.path, ["branch", "-d", worktree.branch]);
                branch = deleted.code === 0 ? { name: worktree.branch, deleted: true } : { name: worktree.branch, deleted: false, message: gitMessage(deleted) };
            }
            await this.scan();
            return { checkout: this.#listedNow(id), ...(branch ? { branch } : {}) };
        });
    }
}
