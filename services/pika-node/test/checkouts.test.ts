import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkoutId, Checkouts, listOf, parseWorktrees, place, worktreeSlug, worktreeTarget, type CheckoutList } from "../src/checkouts.ts";
import { asNodeError } from "../src/errors.ts";
import { isCheckout, LIMITS, type Checkout } from "../src/protocol.ts";
import { loadConfig, saveConfig, type Config } from "../src/store.ts";
import { tempHome, until } from "./support.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8" }).trim();
const repo = (path: string, remote?: string) => {
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q");
    git(path, "commit", "-q", "--allow-empty", "-m", "init");
    if (remote) git(path, "remote", "add", "origin", remote);
    return realpathSync(path);
};
const code = async (promise: Promise<unknown>) => {
    try { await promise; return "ok"; }
    catch (error) { return asNodeError(error).code; }
};

describe("pure helpers", () => {
    it("parses git worktree list --porcelain -z, main first, without a bare repository's own entry", () => {
        const sha = "c553c4ec8aac7c7d63db086107fbfbd5fbc8b5bc";
        const output = [
            "worktree /w/r", `HEAD ${sha}`, "branch refs/heads/main", "",
            "worktree /w/r-det", `HEAD ${sha}`, "detached", "",
            "worktree /w/r-feat-x", `HEAD ${sha}`, "branch refs/heads/feat/x", "",
            "worktree /w/r-gone", `HEAD ${sha}`, "branch refs/heads/g", "prunable gitdir file points to non-existent location", "",
            "worktree /w/r-lock", `HEAD ${sha}`, "branch refs/heads/l", "locked why", "",
            "",
        ].join("\0");
        expect(parseWorktrees(output)).toEqual([
            { path: "/w/r", branch: "main", head: sha, isMain: true, prunable: false, locked: false, detached: false },
            { path: "/w/r-det", head: sha, isMain: false, prunable: false, locked: false, detached: true },
            { path: "/w/r-feat-x", branch: "feat/x", head: sha, isMain: false, prunable: false, locked: false, detached: false },
            { path: "/w/r-gone", branch: "g", head: sha, isMain: false, prunable: true, locked: false, detached: false },
            { path: "/w/r-lock", branch: "l", head: sha, isMain: false, prunable: false, locked: true, detached: false },
        ]);
        // A bare repository lists itself first (no main worktree); an unborn branch has no head.
        expect(parseWorktrees(["worktree /w/b.git", "bare", "", "worktree /w/b-z", `HEAD ${sha}`, "branch refs/heads/z", "", ""].join("\0")))
            .toEqual([{ path: "/w/b-z", branch: "z", head: sha, isMain: false, prunable: false, locked: false, detached: false }]);
        expect(parseWorktrees(["worktree /w/u", `HEAD ${"0".repeat(40)}`, "branch refs/heads/master", "", ""].join("\0")))
            .toEqual([{ path: "/w/u", branch: "master", isMain: true, prunable: false, locked: false, detached: false }]);
        expect(parseWorktrees("")).toEqual([]);
    });

    it("slugs a branch name as Orca does and places the worktree beside the main one", () => {
        expect(worktreeSlug("feat/login")).toBe("feat-login");
        expect(worktreeSlug("fix: a  b!")).toBe("fix-a-b");
        expect(worktreeSlug("Ünïcode_ok.v2")).toBe("Ünïcode_ok.v2");
        expect(worktreeSlug(".hidden-")).toBe("hidden");
        expect(worktreeSlug("--x..")).toBe("x");
        expect(() => worktreeSlug("+")).toThrow(/no folder name/);
        expect(asNodeError((() => { try { worktreeSlug("//"); } catch (error) { return error; } })()).code).toBe("invalid");
        expect(worktreeTarget("/w/repo", "feat/login")).toBe("/w/repo-feat-login");
        expect(worktreeTarget("/w/repo", "feat/login", "/trees")).toBe("/trees/repo-feat-login");
    });

    it("ids a checkout by the first 32 hex characters of its real path's SHA-256", () => {
        expect(checkoutId("/w/repo/.git")).toMatch(/^[0-9a-f]{32}$/);
        expect(checkoutId("/w/repo/.git")).toBe(checkoutId("/w/repo/.git"));
        expect(checkoutId("/w/repo/.git")).not.toBe(checkoutId("/w/other/.git"));
    });

    const checkout = (id: string, path: string, worktrees: string[], kind: "git" | "folder" = "git"): Checkout => ({
        id: id.repeat(32), kind, path, ...(kind === "git" ? { commonDir: `${path}/.git` } : {}), project: "p", name: "p", source: "configured", settings: {},
        worktrees: kind === "git" ? worktrees.map((wt, i) => ({ path: wt, isMain: i === 0, prunable: false, locked: false, detached: false })) : [],
    });

    it("places a cwd in the innermost worktree of the innermost checkout", () => {
        const outer = checkout("a", "/w", [], "folder");
        const inner = checkout("b", "/w/repo", ["/w/repo", "/w/repo/.trees/x", "/w/repo-y"]);
        expect(place("/w/notes", [outer, inner])).toEqual({ checkoutId: outer.id, worktreePath: "/w" });
        expect(place("/w/repo/src", [outer, inner])).toEqual({ checkoutId: inner.id, worktreePath: "/w/repo" });
        expect(place("/w/repo/.trees/x/src", [outer, inner])).toEqual({ checkoutId: inner.id, worktreePath: "/w/repo/.trees/x" });
        expect(place("/w/repo-y", [inner])).toEqual({ checkoutId: inner.id, worktreePath: "/w/repo-y" });
        expect(place("/w/repository", [inner])).toBeUndefined();
        expect(place("/elsewhere", [outer, inner])).toBeUndefined();
    });

    it("sorts by name case-insensitively, then path, and cuts the list to its limits", () => {
        const named = (name: string, path: string) => ({ ...checkout("c", path, [], "folder"), name });
        expect(listOf([named("beta", "/b"), named("Alpha", "/z"), named("alpha", "/a")]).checkouts.map(c => c.path)).toEqual(["/a", "/z", "/b"]);
        const many = Array.from({ length: LIMITS.maxCheckouts + 3 }, (_, i) => named(`n${i}`, `/f/${i}`));
        expect(listOf(many)).toMatchObject({ truncated: true });
        expect(listOf(many).checkouts).toHaveLength(LIMITS.maxCheckouts);
        const huge = Array.from({ length: 300 }, (_, i) => named(`n${i}`, `/${"x".repeat(4_000)}/${i}`));
        const cut = listOf(huge);
        expect(cut.truncated).toBe(true);
        expect(JSON.stringify(cut).length).toBeLessThan(LIMITS.maxRecordBytes);
        expect(listOf([named("a", "/a")])).toMatchObject({ truncated: false });
    });
});

describe("config.json", () => {
    const home = tempHome();
    mkdirSync(home.home, { recursive: true });
    afterAll(() => home.cleanup());
    const id = "0123456789abcdef0123456789abcdef";
    const write = (config: object) => writeFileSync(home.config, JSON.stringify({ version: 1, ...config }));

    it("reads the checkout keys and ignores the spike's project keys, dropping them on save", () => {
        write({
            roots: ["/w"], checkouts: ["/w/a"], hiddenCheckouts: [id], checkoutNames: { [id]: "Mine" },
            checkoutSettings: { [id]: { worktreeLocation: "/trees", worktreeBase: "origin/main", setupScript: "npm ci" } },
            projects: ["/w/old"], hiddenProjects: ["/w/older"], projectNames: { "/w/old": "Old" },
        });
        const config = loadConfig(home);
        expect(config).toEqual({
            version: 1, roots: ["/w"], checkouts: ["/w/a"], hiddenCheckouts: [id], checkoutNames: { [id]: "Mine" },
            checkoutSettings: { [id]: { worktreeLocation: "/trees", worktreeBase: "origin/main", setupScript: "npm ci" } },
        });
        saveConfig(home, config);
        expect(JSON.parse(readFileSync(home.config, "utf8"))).not.toHaveProperty("projects");
    });

    it("fails loudly on malformed checkout keys", () => {
        for (const bad of [
            { checkouts: ["relative"] }, { hiddenCheckouts: ["/w/a"] }, { hiddenCheckouts: [id.toUpperCase()] },
            { checkoutNames: { "/w/a": "x" } }, { checkoutNames: { [id]: " " } }, { checkoutNames: { [id]: "a\nb" } },
            { checkoutSettings: { [id]: { other: 1 } } }, { checkoutSettings: { [id]: { worktreeLocation: "rel" } } }, { checkoutSettings: [] },
        ]) {
            write(bad);
            expect(() => loadConfig(home), JSON.stringify(bad)).toThrow(home.config);
        }
    });
});

describe("Checkouts", () => {
    const home = tempHome();
    const base = home.home;
    const root = join(base, "root");
    mkdirSync(root, { recursive: true });
    const a = repo(join(root, "a"), "git@github.com:me/a.git");
    git(a, "worktree", "add", "-q", "-b", "feat/x", join(base, "a-feat-x"));
    const aLinked = realpathSync(join(base, "a-feat-x"));
    mkdirSync(join(a, "src"));
    const clone = join(base, "clones", "a-again");
    mkdirSync(join(base, "clones"));
    git(join(base, "clones"), "clone", "-q", a, clone);
    git(clone, "remote", "set-url", "origin", "https://github.com/me/a");
    symlinkSync(a, join(base, "a-link"));
    const plain = join(base, "plain");
    mkdirSync(join(plain, "inner"), { recursive: true });
    const inner = repo(join(plain, "inner"));
    const loose = repo(join(base, "loose"));
    const bare = join(base, "b.git");
    git(base, "clone", "-q", "--bare", a, bare);

    let config: Config = { version: 1, roots: [root], checkouts: [join(base, "a-link"), aLinked, join(a, "src"), realpathSync(plain), realpathSync(clone), realpathSync(bare)] };
    let cwds: string[] = [];
    const scans: { list: CheckoutList; changed: boolean }[] = [];
    const checkouts = new Checkouts({
        config: () => structuredClone(config),
        save: next => { config = next; },
        terminalCwds: () => cwds,
        scanned: (list, changed) => scans.push({ list, changed }),
        log: () => {},
        debounceMs: 50,
    });
    afterAll(() => {
        checkouts.dispose();
        home.cleanup();
    });
    const byPath = (list: CheckoutList, path: string) => list.checkouts.find(c => c.path === path);

    it("folds configured, symlinked, discovered, linked-worktree, and subdirectory paths into one checkout per common dir", async () => {
        const list = await checkouts.scan();
        for (const checkout of list.checkouts) expect(isCheckout(checkout), JSON.stringify(checkout)).toBe(true);
        const main = list.checkouts.filter(c => c.commonDir === join(a, ".git"));
        expect(main).toHaveLength(1);
        expect(main[0]).toMatchObject({
            id: checkoutId(join(a, ".git")), kind: "git", path: a, repository: "https://github.com/me/a", project: "a", name: "a", source: "configured", settings: {},
        });
        expect(main[0]!.worktrees.map(w => [w.path, w.branch, w.isMain])).toEqual([[a, "main", true], [aLinked, "feat/x", false]]);
        // A second clone of the same remote is a checkout of its own, with the same repository.
        expect(byPath(list, realpathSync(clone))).toMatchObject({ repository: "https://github.com/me/a", project: "a-again" });
        // A folder checkout, and a git checkout found inside it is its own (here not listed: nothing points at it yet).
        expect(byPath(list, realpathSync(plain))).toMatchObject({ kind: "folder", project: "plain", worktrees: [] });
        expect(byPath(list, inner)).toBeUndefined();
        // A bare repository: its directory is the path, it has no main worktree, and its name drops `.git`.
        expect(byPath(list, realpathSync(bare))).toMatchObject({ kind: "git", project: "b", worktrees: [], commonDir: realpathSync(bare) });
        expect(list.truncated).toBe(false);
        expect(list.checkouts).toHaveLength(4);
    });

    it("lists a live terminal's repository, never a terminal's plain folder, and a git checkout inside a folder one", async () => {
        cwds = [join(loose), join(inner), realpathSync(join(base, "clones"))];
        const list = await checkouts.scan();
        expect(byPath(list, loose)).toMatchObject({ source: "terminal", kind: "git" });
        expect(byPath(list, inner)).toMatchObject({ source: "terminal", kind: "git" });
        expect(list.checkouts.some(c => c.path === realpathSync(join(base, "clones")))).toBe(false);
        cwds = [];
        expect(byPath(await checkouts.scan(), loose)).toBeUndefined();
    });

    it("adds a path inside a linked worktree as its main checkout, and a folder inside a work tree as the repository", async () => {
        config = { version: 1, roots: [] };
        expect(await checkouts.add(join(aLinked))).toMatchObject({ path: a, source: "configured" });
        expect(config.checkouts).toEqual([a]);
        expect(await checkouts.add(join(a, "src"))).toMatchObject({ path: a });
        expect(config.checkouts).toEqual([a]);
        expect(await code(checkouts.add(join(base, "missing")))).toBe("not_found");
        writeFileSync(join(base, "file.txt"), "x");
        expect(await code(checkouts.add(join(base, "file.txt")))).toBe("not_a_directory");
    });

    it("hides and unhides by id, names a checkout, and replaces its settings whole", async () => {
        const id = checkoutId(join(a, ".git"));
        await checkouts.hide(id);
        expect(config.hiddenCheckouts).toEqual([id]);
        expect(config.checkouts).toEqual([a]);
        expect(checkouts.list.checkouts.some(c => c.id === id)).toBe(false);
        await checkouts.hide(id);
        expect(await code(checkouts.hide("f".repeat(32)))).toBe("not_found");
        expect(await code(checkouts.update(id, { name: "x" }))).toBe("not_found");
        expect((await checkouts.unhide(id)).id).toBe(id);
        expect(config.hiddenCheckouts).toBeUndefined();
        expect(await code(checkouts.unhide(id))).toBe("not_found");

        expect(await checkouts.update(id, { name: "  Alpha  " })).toMatchObject({ name: "Alpha", named: true, project: "a" });
        expect(config.checkoutNames).toEqual({ [id]: "Alpha" });
        expect(await checkouts.update(id, { name: "a" })).toMatchObject({ name: "a" });
        expect(config.checkoutNames).toBeUndefined();
        const trees = join(base, "trees");
        mkdirSync(trees);
        expect((await checkouts.update(id, { settings: { worktreeLocation: join(trees, "..", "trees"), setupScript: "true" } })).settings).toEqual({ worktreeLocation: realpathSync(trees), setupScript: "true" });
        expect((await checkouts.update(id, { settings: { worktreeBase: "main" } })).settings).toEqual({ worktreeBase: "main" });
        expect(await code(checkouts.update(id, { settings: { worktreeLocation: join(base, "nope") } }))).toBe("not_found");
        expect(await code(checkouts.update(id, { settings: { worktreeLocation: join(base, "file.txt") } }))).toBe("not_a_directory");
        expect((await checkouts.update(id, { settings: {} })).settings).toEqual({});
        expect(config.checkoutSettings).toBeUndefined();
        const folder = await checkouts.add(plain);
        expect(await code(checkouts.update(folder.id, { settings: {} }))).toBe("invalid");
        expect(await checkouts.update(folder.id, { name: "Notes" })).toMatchObject({ name: "Notes", named: true });
    });

    it("reads the repository identity by resolveRepository's rules: project.json, origin, the only remote, insteadOf", async () => {
        const r = repo(join(base, "ident"));
        git(r, "remote", "add", "upstream", "gh:me/up");
        git(r, "config", "url.https://github.com/.insteadOf", "gh:");
        config = { version: 1, roots: [], checkouts: [r] };
        expect(byPath(await checkouts.scan(), r)).toMatchObject({ repository: "https://github.com/me/up", project: "ident" });
        git(r, "remote", "add", "fork", "https://github.com/someone/up");
        // Two remotes, none `origin`: no repository until project.json names one.
        expect(byPath(await checkouts.scan(), r)?.repository).toBeUndefined();
        mkdirSync(join(r, ".pi", "pika"), { recursive: true });
        writeFileSync(join(r, ".pi", "pika", "project.json"), JSON.stringify({ remote: "fork", project: "renamed" }));
        expect(byPath(await checkouts.scan(), r)).toMatchObject({ repository: "https://github.com/someone/up", project: "renamed", name: "renamed" });
        writeFileSync(join(r, ".pi", "pika", "project.json"), JSON.stringify({ remote: null }));
        const pinned = byPath(await checkouts.scan(), r)!;
        expect(pinned.repository).toBeUndefined();
        expect(pinned.project).toBe("ident");
    });

    it("creates worktrees after checking the branch, path, and base, and removes them without --force", async () => {
        const r = repo(join(base, "wt"));
        config = { version: 1, roots: [], checkouts: [r] };
        const id = checkoutId(join(r, ".git"));
        await checkouts.scan();
        for (const name of ["-x", "a..b", "@{-1}", "a b", "x.lock"]) expect(await code(checkouts.createWorktree(id, name)), name).toBe("invalid");
        expect(await code(checkouts.createWorktree(id, "main"))).toBe("exists");
        expect(await code(checkouts.createWorktree(id, "+"))).toBe("invalid");
        expect(await code(checkouts.createWorktree(id, "ok", "nope"))).toBe("not_found");
        expect(await code(checkouts.createWorktree(id, "ok", "-HEAD"))).toBe("invalid");
        mkdirSync(join(base, "wt-taken"));
        expect(await code(checkouts.createWorktree(id, "taken"))).toBe("exists");
        expect(await code(checkouts.createWorktree("f".repeat(32), "ok"))).toBe("not_found");
        const created = await checkouts.createWorktree(id, "feat/new");
        expect(created.worktree).toMatchObject({ path: realpathSync(join(base, "wt-feat-new")), branch: "feat/new", isMain: false });
        expect(created.main).toBe(r);
        expect(git(r, "branch", "--list", "feat/new")).toContain("feat/new");

        writeFileSync(join(created.worktree.path, "untracked.txt"), "x");
        const ready = async () => {};
        expect(await code(checkouts.removeWorktree(id, created.worktree.path, { deleteBranch: false, ready }))).toBe("conflict");
        expect(await code(checkouts.removeWorktree(id, r, { deleteBranch: false, ready }))).toBe("invalid");
        expect(await code(checkouts.removeWorktree(id, join(base, "elsewhere"), { deleteBranch: false, ready }))).toBe("not_found");
        rmSync(join(created.worktree.path, "untracked.txt"));
        const removed = await checkouts.removeWorktree(id, created.worktree.path, { deleteBranch: true, ready });
        expect(removed.branch).toEqual({ name: "feat/new", deleted: true });
        expect(removed.checkout.worktrees.map(w => w.path)).toEqual([r]);
        expect(git(r, "branch", "--list", "feat/new")).toBe("");

        // A prunable entry (its directory is gone) is cleared with git worktree prune; the branch stays without deleteBranch.
        const gone = await checkouts.createWorktree(id, "gone");
        rmSync(gone.worktree.path, { recursive: true });
        await checkouts.scan();
        expect(checkouts.list.checkouts.find(c => c.id === id)!.worktrees.find(w => w.branch === "gone")?.prunable).toBe(true);
        expect((await checkouts.removeWorktree(id, gone.worktree.path, { deleteBranch: false, ready })).branch).toBeUndefined();
        expect(git(r, "worktree", "list")).not.toContain("wt-gone");
        expect(git(r, "branch", "--list", "gone")).toContain("gone");
    });

    it("notices worktrees and branch switches made outside, and reports a list only when it changed", async () => {
        const r = repo(join(base, "watched"));
        config = { version: 1, roots: [], checkouts: [r] };
        await checkouts.scan();
        expect((await checkouts.scan(), scans.at(-1)!.changed)).toBe(false);
        expect(checkouts.watched).toBeGreaterThan(0);
        const before = scans.length;
        git(r, "worktree", "add", "-q", "-b", "outside", join(base, "watched-outside"));
        await until(() => scans.slice(before).some(s => s.changed && byPath(s.list, r)?.worktrees.length === 2), 10_000, "worktree noticed");
        const switched = scans.length;
        git(join(base, "watched-outside"), "checkout", "-q", "-b", "renamed");
        await until(() => scans.slice(switched).some(s => s.changed && byPath(s.list, r)?.worktrees[1]?.branch === "renamed"), 10_000, "linked HEAD noticed");
        const remoted = scans.length;
        git(r, "remote", "add", "origin", "https://example.com/me/watched.git");
        await until(() => scans.slice(remoted).some(s => s.changed && byPath(s.list, r)?.repository === "https://example.com/me/watched"), 10_000, "config noticed");
        const named = scans.length;
        mkdirSync(join(r, ".pi", "pika"), { recursive: true });
        writeFileSync(join(r, ".pi", "pika", "project.json"), JSON.stringify({ project: "seen" }));
        await until(() => scans.slice(named).some(s => s.changed && byPath(s.list, r)?.project === "seen"), 10_000, "project.json noticed");
    });
});
