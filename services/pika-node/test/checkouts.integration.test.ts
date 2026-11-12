/**
 * Checkouts and worktrees (NODE.md "Checkouts") on the real daemon process, driven over its unix socket: every request,
 * git's refusals (dirty worktree, unmerged branch), busy and force, the setup terminal, and the events.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkoutId } from "../src/checkouts.ts";
import type { Checkout, TerminalInfo, Worktree } from "../src/protocol.ts";
import { cli, settle, socketClient, tempHome } from "./support.ts";

const home = tempHome();
const base = home.home;
const root = join(base, "root");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8" }).trim();
let repo: string;
let id: string;

beforeAll(() => {
    mkdirSync(join(root, "app"), { recursive: true });
    repo = realpathSync(join(root, "app"));
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "git@github.com:me/app.git");
    writeFileSync(join(repo, "README"), "app\n");
    git(repo, "add", "README");
    git(repo, "commit", "-q", "-m", "init");
    id = checkoutId(join(repo, ".git"));
    writeFileSync(home.config, JSON.stringify({ version: 1, roots: [root] }));
    expect(cli(home, ["start"])).toMatch(/daemon started/);
});

afterAll(() => {
    try { cli(home, ["stop"]); } finally { home.cleanup(); }
});

type Listed = { checkouts: Checkout[]; truncated: boolean };
type Created = { terminal: TerminalInfo };
const inRepo = (listed: { checkouts: Checkout[] }) => listed.checkouts.find(c => c.id === id);

describe("checkouts over the unix socket", () => {
    it("lists a discovered repository with its worktrees and repository URL", async () => {
        const a = await socketClient(home);
        expect(a.inbox.messages.find(m => m.type === "welcome")!.capabilities).toContain("checkouts");
        const listed = await a.request<Listed>("checkouts.list");
        expect(listed.truncated).toBe(false);
        expect(inRepo(listed)).toMatchObject({
            kind: "git", path: repo, commonDir: join(repo, ".git"), repository: "https://github.com/me/app", project: "app", name: "app",
            source: "discovered", settings: {}, worktrees: [{ path: repo, branch: "main", isMain: true, prunable: false, locked: false, detached: false }],
        });
        a.close();
    });

    it("adds, names, hides, and unhides, telling every client after the asker's reply", async () => {
        const a = await socketClient(home);
        const b = await socketClient(home);
        const reply = (await a.request<{ checkout: Checkout }>("checkout.add", { path: join(repo, ".git", "..") })).checkout;
        expect(reply).toMatchObject({ id, source: "configured" });
        expect(JSON.parse(readFileSync(home.config, "utf8")).checkouts).toEqual([repo]);
        const changed = await b.inbox.waitFor(m => m.type === "checkouts.changed" && inRepo(m as unknown as Listed)?.source === "configured");
        expect(changed.truncated).toBe(false);
        // On the asker's own socket the reply comes first.
        const own = a.inbox.messages;
        await a.inbox.waitFor(m => m.type === "checkouts.changed" && inRepo(m as unknown as Listed)?.source === "configured");
        expect(own.findIndex(m => m.type === "reply" && (m.result as { checkout?: Checkout })?.checkout?.id === id))
            .toBeLessThan(own.findIndex(m => m.type === "checkouts.changed" && inRepo(m as unknown as Listed)?.source === "configured"));

        expect((await a.request<{ checkout: Checkout }>("checkout.update", { checkoutId: id, name: "App" })).checkout).toMatchObject({ name: "App", named: true, project: "app" });
        await b.inbox.waitFor(m => m.type === "checkouts.changed" && inRepo(m as unknown as Listed)?.name === "App");
        await a.request("checkout.hide", { checkoutId: id });
        await b.inbox.waitFor(m => m.type === "checkouts.changed" && !inRepo(m as unknown as Listed));
        expect(inRepo(await b.request<Listed>("checkouts.list"))).toBeUndefined();
        expect((await a.request<{ checkout: Checkout }>("checkout.unhide", { checkoutId: id })).checkout).toMatchObject({ id, name: "App" });
        expect(await a.requestError("checkout.unhide", { checkoutId: id })).toMatchObject({ code: "not_found" });
        expect(await a.requestError("checkout.hide", { checkoutId: "f".repeat(32) })).toMatchObject({ code: "not_found" });
        expect(await a.requestError("checkout.update", { checkoutId: id, settings: { worktreeLocation: join(base, "nope") } })).toMatchObject({ code: "not_found" });
        expect(await a.requestError("checkout.add", { path: join(base, "missing") })).toMatchObject({ code: "not_found" });
        expect(await a.requestError("checkout.update", { checkoutId: id, settings: { bogus: true } })).toMatchObject({ code: "invalid" });

        // A list that did not change is not sent again.
        await new Promise(resolve => setTimeout(resolve, 700));
        const count = b.inbox.messages.filter(m => m.type === "checkouts.changed").length;
        await a.request("checkouts.list");
        await a.request("checkout.update", { checkoutId: id, name: "App" });
        await new Promise(resolve => setTimeout(resolve, 700));
        expect(b.inbox.messages.filter(m => m.type === "checkouts.changed").length).toBe(count);
        a.close();
        b.close();
    });

    it("creates a worktree with a setup terminal, refuses busy, dirty, and unmerged removals, and forces terminals out", async () => {
        const a = await socketClient(home);
        const b = await socketClient(home);
        const script = 'printf "%s\\n" "$PIKA_WORKTREE_PATH" "$PIKA_CHECKOUT_PATH" "$PIKA_WORKTREE_BRANCH" > .setup-out';
        await a.request("checkout.update", { checkoutId: id, settings: { setupScript: script } });
        expect(await a.requestError("worktree.create", { checkoutId: id, name: "-bad" })).toMatchObject({ code: "invalid" });
        expect(await a.requestError("worktree.create", { checkoutId: id, name: "main" })).toMatchObject({ code: "exists" });
        expect(await a.requestError("worktree.create", { checkoutId: id, name: "x", base: "no-such-ref" })).toMatchObject({ code: "not_found" });

        const created = await a.request<{ checkout: Checkout; worktree: Worktree; setupTerminal?: TerminalInfo }>("worktree.create", { checkoutId: id, name: "feat/one", cols: 100, rows: 30 });
        const wt = join(base, "root", "app-feat-one");
        expect(created.worktree).toMatchObject({ path: realpathSync(wt), branch: "feat/one", isMain: false, detached: false });
        expect(created.checkout.worktrees.map(w => w.path)).toEqual([repo, realpathSync(wt)]);
        const setup = created.setupTerminal!;
        expect(setup).toMatchObject({ cwd: realpathSync(wt), cols: 100, rows: 30, argv: ["sh", "-c", script], checkoutId: id, worktreePath: realpathSync(wt) });
        await b.inbox.waitFor(m => m.type === "term.created" && (m.terminal as TerminalInfo).terminalId === setup.terminalId);
        await b.inbox.waitFor(m => m.type === "checkouts.changed" && inRepo(m as unknown as Listed)?.worktrees.length === 2);
        await a.inbox.waitFor(m => m.type === "term.exit" && m.terminalId === setup.terminalId && m.code === 0, 20_000, "setup exit");
        expect(readFileSync(join(wt, ".setup-out"), "utf8")).toBe(`${realpathSync(wt)}\n${repo}\nfeat/one\n`);

        // A live terminal in the worktree makes it busy; force hangs it up, and then git refuses the untracked file.
        const shell = (await a.request<Created>("term.create", { cols: 80, rows: 24, cwd: join(wt), argv: ["bash", "--noprofile", "--norc"] })).terminal;
        expect(shell).toMatchObject({ checkoutId: id, worktreePath: realpathSync(wt) });
        const busy = await a.requestError("worktree.remove", { checkoutId: id, path: wt });
        expect(busy).toMatchObject({ code: "busy", message: `1 live terminal uses ${realpathSync(wt)}` });
        const forced = await a.requestError("worktree.remove", { checkoutId: id, path: wt, force: true });
        expect(forced.code).toBe("conflict");
        expect(forced.message).toMatch(/untracked|modified/);
        await a.inbox.waitFor(m => m.type === "term.exit" && m.terminalId === shell.terminalId, 10_000, "forced exit");
        expect(existsSync(wt)).toBe(true);
        expect(await a.requestError("worktree.remove", { checkoutId: id, path: repo })).toMatchObject({ code: "invalid" });
        expect(await a.requestError("worktree.remove", { checkoutId: id, path: join(base, "nowhere") })).toMatchObject({ code: "not_found" });

        // An unmerged branch: the worktree goes, the branch stays, and git's refusal comes back.
        rmSync(join(wt, ".setup-out"));
        writeFileSync(join(wt, "work.txt"), "work\n");
        git(wt, "add", "work.txt");
        git(wt, "commit", "-q", "-m", "work");
        const removed = await a.request<{ checkout: Checkout; branch?: { name: string; deleted: boolean; message?: string } }>("worktree.remove", { checkoutId: id, path: wt, deleteBranch: true });
        expect(removed.branch).toMatchObject({ name: "feat/one", deleted: false, message: expect.stringMatching(/not fully merged/) });
        expect(removed.checkout.worktrees.map(w => w.path)).toEqual([repo]);
        expect(existsSync(wt)).toBe(false);
        expect(git(repo, "branch", "--list", "feat/one")).toContain("feat/one");
        await b.inbox.waitFor(m => m.type === "checkouts.changed" && inRepo(m as unknown as Listed)?.worktrees.length === 1);

        // Without deleteBranch nothing is said about the branch; without a setup script there is no setup terminal.
        await a.request("checkout.update", { checkoutId: id, settings: {} });
        const plain = await a.request<{ worktree: Worktree; setupTerminal?: TerminalInfo }>("worktree.create", { checkoutId: id, name: "two", base: "main" });
        expect(plain.setupTerminal).toBeUndefined();
        const gone = await a.request<{ branch?: unknown }>("worktree.remove", { checkoutId: id, path: plain.worktree.path });
        expect(gone.branch).toBeUndefined();
        expect(git(repo, "branch", "--list", "two")).toContain("two");
        await a.request("term.kill", { terminalId: setup.terminalId });
        await a.request("term.kill", { terminalId: shell.terminalId });
        a.close();
        b.close();
    }, 60_000);

    it("places a terminal where its shell goes, and notices worktrees made outside the daemon", async () => {
        const a = await socketClient(home);
        const outside = join(base, "elsewhere");
        mkdirSync(outside, { recursive: true });
        const shell = (await a.request<Created>("term.create", { cols: 80, rows: 24, cwd: outside, argv: ["bash", "--noprofile", "--norc"] })).terminal;
        expect(shell.checkoutId).toBeUndefined();
        await a.request("term.attach", { terminalId: shell.terminalId });
        await settle(a.inbox, shell.terminalId);
        a.send({ type: "term.input", terminalId: shell.terminalId, data: `cd ${repo}\r` });
        await a.inbox.waitFor(m => m.type === "term.placed" && m.terminalId === shell.terminalId && m.checkoutId === id && m.worktreePath === repo, 10_000, "placed in the repo");

        // A repository only this terminal is in is listed for it (source "terminal"), and leaves with it.
        const loose = join(base, "loose");
        mkdirSync(loose);
        git(loose, "init", "-q");
        const looseId = checkoutId(join(realpathSync(loose), ".git"));
        a.send({ type: "term.input", terminalId: shell.terminalId, data: `cd ${loose}\r` });
        const listed = await a.inbox.waitFor(m => m.type === "checkouts.changed" && (m.checkouts as Checkout[]).some(c => c.id === looseId), 10_000, "terminal checkout");
        expect((listed.checkouts as Checkout[]).find(c => c.id === looseId)).toMatchObject({ source: "terminal", worktrees: [{ path: realpathSync(loose), branch: "main", isMain: true }] });
        await a.inbox.waitFor(m => m.type === "term.placed" && m.terminalId === shell.terminalId && m.checkoutId === looseId, 10_000, "placed in the loose repo");

        git(repo, "worktree", "add", "-q", "-b", "outside", join(base, "root", "app-outside"));
        await a.inbox.waitFor(m => m.type === "checkouts.changed" && inRepo(m as unknown as Listed)?.worktrees.some(w => w.branch === "outside") === true, 10_000, "outside worktree");

        await a.request("term.kill", { terminalId: shell.terminalId, signal: "SIGKILL" });
        await a.inbox.waitFor(m => m.type === "checkouts.changed" && !(m.checkouts as Checkout[]).some(c => c.id === looseId), 10_000, "terminal checkout gone");
        // An exited terminal keeps its place only while its checkout is listed.
        await a.inbox.waitFor(m => m.type === "term.placed" && m.terminalId === shell.terminalId && m.checkoutId === null, 10_000, "cleared");
        a.close();
    }, 40_000);
});
