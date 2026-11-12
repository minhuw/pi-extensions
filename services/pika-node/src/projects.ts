/**
 * The spike's flat project list, replaced by checkouts (NODE.md §4 "Checkouts") and no longer wired into the daemon.
 * Kept until the checkout implementation lands: its worktree helpers (`worktreeSlug`, `worktreePath`) carry over.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { NodeError } from "./errors.ts";
import { roots, type Config } from "./store.ts";

const run = promisify(execFile);

/** A project of the spike's list; `worktree` is the main checkout's path for a linked git worktree. */
export interface Project { name: string; path: string; repository?: string; named?: true; worktree?: string }

export interface ProjectsOptions {
    config: () => Config;
    save: (config: Config) => void;
    terminalCwds: () => string[];
}

/** The git directory a `.git` file points at, for a linked worktree or a submodule; undefined for a `.git` directory. */
function gitFileTarget(dir: string): string | undefined {
    const dotGit = join(dir, ".git");
    try {
        if (!statSync(dotGit).isFile()) return undefined;
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
        return match ? resolve(dir, match[1]!) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The main checkout of `dir` when it is a linked worktree (its `.git` file points into `<common>/worktrees/<name>`,
 * which holds a `commondir`), read from the files git keeps, without running git. A submodule has no `commondir`.
 */
export function worktreeMain(dir: string): string | undefined {
    const gitDir = gitFileTarget(dir);
    if (!gitDir || basename(dirname(gitDir)) !== "worktrees") return undefined;
    let common: string;
    try { common = readFileSync(join(gitDir, "commondir"), "utf8").trim(); }
    catch { return undefined; }
    const commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
    // A bare repository's worktrees have no main checkout to name; its directory stands for it.
    return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
}

/**
 * Orca's slug for a worktree's folder (`sanitizeWorktreeName`, orca `src/main/ipc/worktree-logic.ts`, MIT): letters,
 * digits, `.`, `_` and `-` stay, every other run becomes one `-`, and no `..` or leading/trailing `.`/`-` is left.
 */
export function worktreeSlug(branch: string): string {
    const slug = branch.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/-+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "");
    if (!slug) throw new NodeError("invalid", `${JSON.stringify(branch)} gives no folder name`);
    return slug;
}

/**
 * Where a new worktree of `main` goes: beside it, as `<parent>/<repo>-<slug>`. This is Orca's layout for a repository on
 * an SSH host (`computeRemoteWorktreePath`, orca `src/main/ipc/worktree-logic.ts`), which a node is to Deck; on its own
 * machine Orca nests them under `~/orca/workspaces/<repo>/<slug>`.
 */
export const worktreePath = (main: string, branch: string): string => join(dirname(main), `${basename(main).replace(/\.git$/, "")}-${worktreeSlug(branch)}`);

const gitError = (error: unknown): string => {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    return stderr || (error as Error).message;
};

async function git(cwd: string, args: string[], timeout = 10_000): Promise<string> {
    return (await run("git", ["-C", cwd, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
}

/** A directory's real path: `not_found` when it does not exist, `not_a_directory` for anything else. */
async function realDirectory(path: string): Promise<string> {
    let real: string;
    try { real = await realpath(path); }
    catch { throw new NodeError("not_found", `no directory ${path}`); }
    if (!(await stat(real)).isDirectory()) throw new NodeError("not_a_directory", `${path} is not a directory`);
    return real;
}

export class Projects {
    #options: ProjectsOptions;
    /** Edits of `config.json` one after another, so two requests cannot drop each other's change. */
    #queue: Promise<unknown> = Promise.resolve();

    constructor(options: ProjectsOptions) { this.#options = options; }

    /** Each listed project, then each one found on its own that is not hidden, by name; duplicates by real path. */
    async list(): Promise<Project[]> {
        const config = this.#options.config();
        const hidden = new Set(config.hiddenProjects ?? []);
        const names = config.projectNames ?? {};
        const seen = new Map<string, Project>();
        for (const candidate of [...(config.projects ?? []), ...(await this.#discovered(config))]) {
            let real: string;
            try { real = await realpath(candidate); }
            catch { continue; }
            if (seen.has(real) || (hidden.has(real) && !(config.projects ?? []).includes(real))) continue;
            const name = names[real];
            const main = worktreeMain(real);
            seen.set(real, { name: name ?? basename(real), path: real, ...(name ? { named: true as const } : {}), ...(main ? { worktree: main } : {}) });
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    }

    /** Projects found without being listed: each repository one level below a root, and each live terminal's. */
    async #discovered(config: Config): Promise<string[]> {
        const found: string[] = [];
        for (const root of roots(config)) {
            let entries;
            try { entries = await readdir(root, { withFileTypes: true }); }
            catch { continue; }
            for (const entry of entries) if (entry.isDirectory() && existsSync(join(root, entry.name, ".git"))) found.push(join(root, entry.name));
        }
        for (const cwd of new Set(this.#options.terminalCwds())) {
            try { found.push(await git(cwd, ["rev-parse", "--show-toplevel"], 2_000)); }
            catch { /* not a repository */ }
        }
        return found;
    }

    async #isDiscovered(real: string, config: Config): Promise<boolean> {
        for (const candidate of await this.#discovered(config)) {
            try { if (await realpath(candidate) === real) return true; }
            catch { /* gone */ }
        }
        return false;
    }

    #edit<T>(change: (config: Config) => Promise<T> | T): Promise<T> {
        const next = this.#queue.then(async () => {
            const config = this.#options.config();
            const result = await change(config);
            if (config.hiddenProjects?.length === 0) delete config.hiddenProjects;
            this.#options.save(config);
            return result;
        });
        this.#queue = next.catch(() => {});
        return next;
    }

    async #project(real: string): Promise<Project> {
        const project = (await this.list()).find(item => item.path === real);
        if (!project) throw new NodeError("not_found", `${real} is not a project`);
        return project;
    }

    /** Lists a directory as a project (and shows it again if it was hidden). Adding a listed one changes nothing. */
    async add(path: string): Promise<Project> {
        const real = await realDirectory(path);
        await this.#edit(config => {
            if (!(config.projects ?? []).includes(real)) config.projects = [...(config.projects ?? []), real];
            if (config.hiddenProjects?.includes(real)) config.hiddenProjects = config.hiddenProjects.filter(item => item !== real);
        });
        return this.#project(real);
    }

    /**
     * Takes a project off the list: out of `projects`, and into `hiddenProjects` when it would still be found on its own.
     * Nothing on disk changes. A path that no longer exists is matched as given.
     */
    async remove(path: string): Promise<{ hidden: boolean }> {
        let real: string;
        try { real = await realpath(path); }
        catch { real = path; }
        return this.#edit(async config => {
            const listed = (config.projects ?? []).filter(item => item === real || item === path);
            const discovered = existsSync(real) && await this.#isDiscovered(real, config);
            if (listed.length === 0 && !discovered) throw new NodeError("not_found", `${path} is not a project`);
            if (listed.length) config.projects = (config.projects ?? []).filter(item => !listed.includes(item));
            if (discovered && !config.hiddenProjects?.includes(real)) config.hiddenProjects = [...(config.hiddenProjects ?? []), real];
            return { hidden: discovered };
        });
    }

    /** Names a project for every browser; `null` gives it its folder's name again. */
    async rename(path: string, name: string | null): Promise<Project> {
        const real = await realDirectory(path);
        await this.#project(real);
        await this.#edit(config => {
            const names = { ...(config.projectNames ?? {}) };
            const trimmed = name?.trim();
            if (trimmed && trimmed !== basename(real)) names[real] = trimmed;
            else delete names[real];
            if (Object.keys(names).length) config.projectNames = names;
            else delete config.projectNames;
        });
        return this.#project(real);
    }

    /**
     * `git worktree add -b <branch> <path> <base>` in `project`'s repository, at `worktreePath` of its main checkout, then
     * lists the new worktree as a project. `base` defaults to the project's `HEAD`.
     */
    async worktreeAdd(project: string, branch: string, base = "HEAD"): Promise<Project> {
        const real = await realDirectory(project);
        let top: string;
        try { top = await realpath(await git(real, ["rev-parse", "--show-toplevel"])); }
        catch { throw new NodeError("not_found", `${project} is not in a git work tree`); }
        if (branch.startsWith("-")) throw new NodeError("invalid", `${JSON.stringify(branch)} is not a valid branch name`);
        try { await git(top, ["check-ref-format", "--branch", branch]); }
        catch { throw new NodeError("invalid", `${JSON.stringify(branch)} is not a valid branch name`); }
        try {
            await git(top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
            throw new NodeError("exists", `a branch named ${branch} already exists`);
        } catch (error) {
            if (error instanceof NodeError) throw error;
        }
        if (base.startsWith("-")) throw new NodeError("invalid", `${JSON.stringify(base)} is not a commit`);
        try { await git(top, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]); }
        catch { throw new NodeError("not_found", `no commit ${base} in ${top}`); }
        const target = worktreePath(worktreeMain(top) ?? top, branch);
        if (existsSync(target)) throw new NodeError("exists", `${target} already exists`);
        try { await git(top, ["worktree", "add", "-b", branch, target, base], 120_000); }
        catch (error) { throw new NodeError("io", `git worktree add failed: ${gitError(error)}`); }
        return this.add(target);
    }

    /**
     * `git worktree remove <path>`, never with `--force`: git refuses a worktree with changes or untracked files, and its
     * message comes back as `conflict`. Only a linked worktree, never a main checkout. The project leaves the list.
     */
    async worktreeRemove(path: string): Promise<void> {
        const real = await realDirectory(path);
        const main = worktreeMain(real);
        if (!main) throw new NodeError("invalid", `${path} is not a linked git worktree`);
        try { await git(main, ["worktree", "remove", real], 60_000); }
        catch (error) { throw new NodeError("conflict", gitError(error)); }
        await this.#edit(config => {
            if (config.projects?.includes(real)) config.projects = config.projects.filter(item => item !== real);
            if (config.hiddenProjects?.includes(real)) config.hiddenProjects = config.hiddenProjects.filter(item => item !== real);
            if (config.projectNames?.[real] !== undefined) {
                const { [real]: _gone, ...rest } = config.projectNames;
                if (Object.keys(rest).length) config.projectNames = rest;
                else delete config.projectNames;
            }
        });
    }
}
