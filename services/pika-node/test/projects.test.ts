import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { asNodeError } from "../src/errors.ts";
import { Projects, worktreeMain, worktreePath, worktreeSlug } from "../src/projects.ts";
import { loadConfig, saveConfig, type Config } from "../src/store.ts";
import { tempHome } from "./support.ts";

const home = tempHome();
mkdirSync(home.home, { recursive: true });
const root = join(home.home, "root");
const outside = join(home.home, "outside");
mkdirSync(join(root, "found", ".git"), { recursive: true });
mkdirSync(join(outside, "plain"), { recursive: true });
writeFileSync(join(outside, "file.txt"), "x");
saveConfig(home, { version: 1, roots: [root] });
let cwds: string[] = [];
const projects = new Projects({ config: () => loadConfig(home), save: config => saveConfig(home, config), terminalCwds: () => cwds });
afterAll(() => home.cleanup());

const code = async (promise: Promise<unknown>) => {
    try { await promise; return "ok"; }
    catch (error) { return asNodeError(error).code; }
};
const message = async (promise: Promise<unknown>) => {
    try { await promise; return ""; }
    catch (error) { return (error as Error).message; }
};
const paths = async () => (await projects.list()).map(project => project.path);
const config = (): Config => JSON.parse(readFileSync(home.config, "utf8"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

describe("projects", () => {
    const found = realpathSync(join(root, "found"));
    const plain = realpathSync(join(outside, "plain"));

    it("adds a directory by its real path, once, and refuses what is not one", async () => {
        expect(await paths()).toEqual([found]);
        const added = await projects.add(join(outside, "..", "outside", "plain"));
        expect(added).toEqual({ name: "plain", path: plain });
        await projects.add(plain);
        expect(config().projects).toEqual([plain]);
        expect(await paths()).toEqual([found, plain]);
        expect(await code(projects.add(join(outside, "missing")))).toBe("not_found");
        expect(await code(projects.add(join(outside, "file.txt")))).toBe("not_a_directory");
    });

    it("removes a listed project from the list, and hides one found on its own; adding shows it again", async () => {
        expect(await projects.remove(plain)).toEqual({ hidden: false });
        expect(config().projects).toEqual([]);
        expect(existsSync(plain)).toBe(true);
        expect(await projects.remove(found)).toEqual({ hidden: true });
        expect(config().hiddenProjects).toEqual([found]);
        expect(await paths()).toEqual([]);
        expect(existsSync(found)).toBe(true);
        expect(await code(projects.remove(plain))).toBe("not_found");
        // Undo.
        await projects.add(found);
        expect(config().hiddenProjects).toBeUndefined();
        expect(await paths()).toEqual([found]);
    });

    it("hides a terminal's repository too, so its terminals fall to Other", async () => {
        const repo = join(outside, "termrepo");
        mkdirSync(repo);
        git(repo, "init", "-q");
        cwds = [repo];
        const real = realpathSync(repo);
        expect(await paths()).toContain(real);
        expect(await projects.remove(real)).toEqual({ hidden: true });
        expect(await paths()).not.toContain(real);
        cwds = [];
    });

    it("renames a project for everyone, and a null name gives its folder's name back", async () => {
        expect(await projects.rename(found, "  Found it  ")).toEqual({ name: "Found it", path: found, named: true });
        expect(config().projectNames).toEqual({ [found]: "Found it" });
        expect((await projects.list()).find(project => project.path === found)?.name).toBe("Found it");
        expect(await projects.rename(found, null)).toEqual({ name: "found", path: found });
        expect(config().projectNames).toBeUndefined();
        expect(await code(projects.rename(plain, "x"))).toBe("not_found");
    });

    it("keeps every edit when several arrive at once", async () => {
        const dirs = ["a", "b", "c", "d"].map(name => {
            mkdirSync(join(outside, name));
            return realpathSync(join(outside, name));
        });
        await Promise.all(dirs.map(dir => projects.add(dir)));
        // The undo above listed "found".
        expect([...config().projects!].sort()).toEqual([...dirs, found].sort());
        await Promise.all(dirs.map(dir => projects.remove(dir)));
        expect(config().projects).toEqual([found]);
    });

    it("refuses a config.json whose new fields are malformed", () => {
        writeFileSync(home.config, JSON.stringify({ version: 1, projectNames: { relative: "x" } }));
        expect(() => loadConfig(home)).toThrow(/projectNames/);
        writeFileSync(home.config, JSON.stringify({ version: 1, hiddenProjects: ["relative"] }));
        expect(() => loadConfig(home)).toThrow(/hiddenProjects/);
        saveConfig(home, { version: 1, roots: [root] });
    });
});

describe("worktrees", () => {
    const repo = join(outside, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "first");
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, "commit", "-qam", "second");
    const real = realpathSync(repo);

    it("names folders as Orca does, beside the main checkout", () => {
        expect(worktreeSlug("feature/Big idea!")).toBe("feature-Big-idea");
        expect(worktreeSlug("..a..b-")).toBe("a.b");
        expect(() => worktreeSlug("///")).toThrow();
        expect(worktreePath("/w/repo", "fix/x")).toBe("/w/repo-fix-x");
        expect(worktreePath("/w/repo.git", "x")).toBe("/w/repo-x");
    });

    it("adds a worktree on a new branch from HEAD or a base, as a project", async () => {
        const project = await projects.worktreeAdd(real, "feature/one");
        const target = join(realpathSync(outside), "repo-feature-one");
        expect(project).toEqual({ name: "repo-feature-one", path: target, worktree: real });
        expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/one");
        expect(git(target, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
        expect(config().projects).toContain(target);
        expect(worktreeMain(target)).toBe(real);
        expect(worktreeMain(real)).toBeUndefined();

        // From a worktree, the next one still goes beside the main checkout; a base picks the commit.
        const second = await projects.worktreeAdd(target, "two", first);
        expect(second.path).toBe(join(realpathSync(outside), "repo-two"));
        expect(git(second.path, "rev-parse", "HEAD")).toBe(first);
    });

    it("refuses bad branch names, taken branches, unknown bases, and a taken folder", async () => {
        expect(await code(projects.worktreeAdd(real, "bad..name"))).toBe("invalid");
        expect(await code(projects.worktreeAdd(real, "-x"))).toBe("invalid");
        expect(await code(projects.worktreeAdd(real, "has space"))).toBe("invalid");
        expect(await code(projects.worktreeAdd(real, "feature/one"))).toBe("exists");
        expect(await code(projects.worktreeAdd(real, "three", "no-such-ref"))).toBe("not_found");
        expect(await code(projects.worktreeAdd(real, "three", "--orphan"))).toBe("invalid");
        mkdirSync(join(outside, "repo-taken"));
        expect(await code(projects.worktreeAdd(real, "taken"))).toBe("exists");
        expect(await code(projects.worktreeAdd(plainDir(), "x"))).toBe("not_found");
    });

    it("removes a clean worktree, refuses a dirty one with git's words, and never a main checkout", async () => {
        const target = join(realpathSync(outside), "repo-feature-one");
        writeFileSync(join(target, "new.txt"), "untracked\n");
        const refusal = await message(projects.worktreeRemove(target));
        expect(refusal).toMatch(/modified or untracked files/);
        expect(await code(projects.worktreeRemove(target))).toBe("conflict");
        expect(existsSync(join(target, "new.txt"))).toBe(true);
        expect(await code(projects.worktreeRemove(real))).toBe("invalid");

        await projects.rename(join(realpathSync(outside), "repo-two"), "Two");
        await projects.worktreeRemove(join(realpathSync(outside), "repo-two"));
        expect(existsSync(join(outside, "repo-two"))).toBe(false);
        expect(config().projects).not.toContain(join(realpathSync(outside), "repo-two"));
        expect(config().projectNames).toBeUndefined();
    });
});

function plainDir(): string {
    const dir = join(outside, "not-a-repo");
    mkdirSync(dir, { recursive: true });
    return dir;
}
