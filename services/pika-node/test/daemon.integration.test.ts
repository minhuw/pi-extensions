/**
 * The real daemon process (`pika-node start` with a temporary PIKA_NODE_HOME) driven over its unix socket by
 * inner-protocol clients, as `pika-node attach` does: shared output, reattach from a snapshot, exactly one query
 * answerer, OSC 7501 pane status, the size owner, the bridge, and the spawn environment.
 */
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeLine, LineDecoder, PROTOCOL_VERSION, type Snapshot, type TerminalInfo } from "../src/protocol.ts";
import { BIN, cli, Inbox, outputAfter, ROOT, Screen, settle, socketClient, tempHome, until } from "./support.ts";

const home = tempHome();
const project = join(home.home, "project");
const fixture = (name: string) => join(ROOT, "test", "fixtures", name);
const node = process.execPath;

beforeAll(() => {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "notes.txt"), "hello\n");
    writeFileSync(home.config, JSON.stringify({ version: 1, roots: [project] }));
    // Profile guards inherited by the daemon must never reach a PTY (a login profile may set its own again).
    expect(cli(home, ["start"], { env: { __ETC_PROFILE_NIX_SOURCED: "1", __PIKA_TEST_GUARD: "1", ORCA_TEST: "1" } })).toMatch(/daemon started/);
});

afterAll(() => {
    try { cli(home, ["stop"]); } finally { home.cleanup(); }
});

type Created = { terminal: TerminalInfo };
type Attached = { terminal: TerminalInfo; snapshot: Snapshot };

describe("pika-node daemon over the unix socket", () => {
    it("reports itself running", () => {
        expect(cli(home, ["status"])).toMatch(/running \(pid \d+/);
    });

    it("streams one login shell to two clients and restores a reattach from the snapshot", async () => {
        const a = await socketClient(home);
        const b = await socketClient(home);
        const { terminal } = await a.request<Created>("term.create", { cols: 100, rows: 30, cwd: project, argv: ["bash", "-l"] });
        const id = terminal.terminalId;
        // Every channel, the creator included, learns of a new terminal without polling.
        expect((await b.inbox.waitFor(m => m.type === "term.created" && (m.terminal as TerminalInfo).terminalId === id)).terminal).toMatchObject({ argv: ["bash", "-l"], cwd: project });
        await a.inbox.waitFor(m => m.type === "term.created" && (m.terminal as TerminalInfo).terminalId === id);
        const [attachA, attachB] = await Promise.all([a.request<Attached>("term.attach", { terminalId: id }), b.request<Attached>("term.attach", { terminalId: id })]);
        // Type only at the prompt: a login profile may read and drop type-ahead while it probes the terminal.
        await settle(a.inbox, id);
        a.send({ type: "term.input", terminalId: id, data: "echo shared-$((40+2))\r" });
        await until(() => outputAfter(a.inbox, id).includes("shared-42") && outputAfter(b.inbox, id).includes("shared-42"), 15_000, "shared output");
        // Both clients render the same screen.
        const screenA = new Screen(attachA.snapshot);
        const screenB = new Screen(attachB.snapshot);
        await until(async () => {
            screenA.apply(a.inbox.messages, id);
            screenB.apply(b.inbox.messages, id);
            return (await screenA.text()).includes("shared-42") && screenA.seq === screenB.seq;
        }, 10_000, "both screens caught up");
        expect(await screenB.text()).toBe(await screenA.text());
        // And the same chunks for every seq both received.
        const both = (inbox: Inbox) => new Map(inbox.messages.filter(m => m.type === "term.output" && m.terminalId === id).map(m => [m.seq, m.data]));
        const seqA = both(a.inbox);
        for (const [seq, data] of both(b.inbox)) if (seqA.has(seq)) expect(data).toBe(seqA.get(seq));

        // B goes away; output continues; B comes back on a new connection and reattaches.
        b.close();
        a.send({ type: "term.input", terminalId: id, data: "printf '\\033[1;32mgreen\\033[0m %s\\n' after-detach; seq 1 3\r" });
        await until(() => outputAfter(a.inbox, id).includes("green\x1b[0m after-detach"), 10_000, "output while detached");
        const b2 = await socketClient(home);
        const reattached = await b2.request<Attached>("term.attach", { terminalId: id });
        const restored = new Screen(reattached.snapshot);
        expect(await restored.text()).toContain("green after-detach");
        await until(async () => {
            screenA.apply(a.inbox.messages, id);
            restored.apply(b2.inbox.messages, id);
            return screenA.seq === restored.seq && (await screenA.text()) === (await restored.text());
        }, 10_000, "reattached screen matches");
        // The snapshot restores colours, not only text.
        const cell = restored.terminal.buffer.active;
        const row = [...Array(restored.terminal.rows).keys()].map(y => cell.getLine(cell.viewportY + y)!).find(line => line.translateToString(true).startsWith("green after"))!;
        expect(row.getCell(0)!.getFgColor()).toBe(2);
        expect(row.getCell(0)!.isBold()).not.toBe(0);

        await a.request("term.kill", { terminalId: id, signal: "SIGKILL" });
        const exit = await b2.inbox.waitFor(m => m.type === "term.exit" && m.terminalId === id);
        expect(exit.signal).toBe("SIGKILL");
        await a.inbox.waitFor(m => m.type === "term.exit" && m.terminalId === id);
        // An exited terminal stays listed and attachable until a second kill removes it.
        const listed = await a.request<{ terminals: TerminalInfo[] }>("term.list");
        expect(listed.terminals.find(t => t.terminalId === id)?.exited?.signal).toBe("SIGKILL");
        expect((await b2.request<Attached>("term.attach", { terminalId: id })).snapshot.data).toContain("after-detach");
        expect((await a.requestError("term.input-does-not-exist")).code).toBe("unsupported");
        await a.request("term.kill", { terminalId: id });
        await b2.inbox.waitFor(m => m.type === "term.removed" && m.terminalId === id);
        expect((await a.request<{ terminals: TerminalInfo[] }>("term.list")).terminals.some(t => t.terminalId === id)).toBe(false);
        for (const screen of [screenA, screenB, restored]) screen.dispose();
        a.close();
        b2.close();
    }, 60_000);

    it("answers DA1 and CPR exactly once, with or without clients attached", async () => {
        const a = await socketClient(home);
        const b = await socketClient(home);
        // No client attached: pi often starts this way.
        const lonely = await a.request<Created>("term.create", { cols: 80, rows: 24, argv: [node, fixture("queries.mjs")] });
        // Two clients attached before the program asks.
        const shared = await a.request<Created>("term.create", { cols: 80, rows: 24, argv: [node, fixture("queries.mjs"), "3000"] });
        await Promise.all([a.request("term.attach", { terminalId: shared.terminal.terminalId }), b.request("term.attach", { terminalId: shared.terminal.terminalId })]);
        for (const { terminal } of [lonely, shared]) {
            const id = terminal.terminalId;
            await until(async () => {
                const attached = await a.request<Attached>("term.attach", { terminalId: id });
                return attached.snapshot.data.includes("REPLIES=");
            }, 15_000, `query replies in ${id}`);
            const text = (await a.request<Attached>("term.attach", { terminalId: id })).snapshot.data + outputAfter(a.inbox, id);
            const replies = JSON.parse(/REPLIES=("(?:[^"\\]|\\.)*")/.exec(text)![1]!) as string;
            expect(replies.match(/\x1b\[\?1;2c/g)).toHaveLength(1);
            expect(replies.match(/\x1b\[\d+;\d+R/g)).toHaveLength(1);
            expect(replies.replace(/\x1b\[\?1;2c|\x1b\[\d+;\d+R/g, "")).toBe("");
        }
        a.close();
        b.close();
    }, 60_000);

    it("derives pane status from OSC 7501, with unread and foreground clearing", async () => {
        const a = await socketClient(home);
        const b = await socketClient(home);
        const { terminal } = await a.request<Created>("term.create", { cols: 80, rows: 24, argv: ["bash", "--noprofile", "--norc"] });
        const id = terminal.terminalId;
        await a.request("term.attach", { terminalId: id });
        await settle(a.inbox, id);
        const status = (state: string, extra: (s: Record<string, unknown>) => boolean = () => true) =>
            (m: Record<string, unknown>) => m.type === "pane.status" && m.terminalId === id && (m.status as { state?: string } | null)?.state === state && extra(m.status as Record<string, unknown>);
        a.send({ type: "term.input", terminalId: id, data: `${node} ${fixture("status.mjs")}\r` });
        await until(() => outputAfter(a.inbox, id).includes("status fixture ready"), 15_000, "fixture start");

        a.send({ type: "term.input", terminalId: id, data: "working\r" });
        // Pane status goes to every client, attached or not.
        await b.inbox.waitFor(status("busy", s => (s.program as { state: string }).state === "working"));
        a.send({ type: "term.input", terminalId: id, data: "blocked Allow rm -rf?\r" });
        const blocked = await b.inbox.waitFor(status("waiting"));
        expect(blocked.status).toMatchObject({ program: { state: "blocked", app: "pi", kind: "question", message: "Allow rm -rf?" }, bridgeConnected: false, unread: false });
        a.send({ type: "term.input", terminalId: id, data: "idle\r" });
        const done = await b.inbox.waitFor(status("idle", s => s.unread === true));
        expect(done.status).toMatchObject({ program: { state: "idle" } });
        expect((await a.request<{ terminals: TerminalInfo[] }>("term.list")).terminals.find(t => t.terminalId === id)?.status?.unread).toBe(true);
        b.send({ type: "pane.seen", terminalId: id });
        await a.inbox.waitFor(status("idle", s => s.unread === false));

        // The program leaves while `working`: the shell is back in front and the status clears.
        a.send({ type: "term.input", terminalId: id, data: "working\r" });
        await a.inbox.waitFor(status("busy"));
        a.send({ type: "term.input", terminalId: id, data: "exit\r" });
        await a.inbox.waitFor(m => m.type === "pane.status" && m.terminalId === id && m.status === null, 10_000, "stale status cleared");
        await a.request("term.kill", { terminalId: id, signal: "SIGKILL" });
        a.close();
        b.close();
    }, 60_000);

    it("lets one size owner resize, and tells the others the size", async () => {
        const a = await socketClient(home);
        const b = await socketClient(home);
        const { terminal } = await a.request<Created>("term.create", { cols: 80, rows: 24, argv: ["bash", "--noprofile", "--norc"] });
        const id = terminal.terminalId;
        await Promise.all([a.request("term.attach", { terminalId: id }), b.request("term.attach", { terminalId: id })]);
        const resized = (inbox: Inbox, cols: number, owned: boolean) => inbox.next(m => m.type === "term.resized" && m.terminalId === id && m.cols === cols && m.owned === owned);
        // The creator owns the size; a passive resize from B does not apply.
        let seenA = resized(a.inbox, 120, true);
        let seenB = resized(b.inbox, 120, false);
        a.send({ type: "term.resize", terminalId: id, cols: 120, rows: 40 });
        await Promise.all([seenA, seenB]);
        seenB = resized(b.inbox, 120, false);
        b.send({ type: "term.resize", terminalId: id, cols: 90, rows: 20 });
        await seenB;
        // A claim moves ownership.
        seenA = resized(a.inbox, 90, false);
        seenB = resized(b.inbox, 90, true);
        b.send({ type: "term.resize", terminalId: id, cols: 90, rows: 20, claim: true });
        await Promise.all([seenA, seenB]);
        a.send({ type: "term.input", terminalId: id, data: "stty size\r" });
        await until(() => outputAfter(a.inbox, id).includes("20 90"), 10_000, "PTY size");
        // The owner leaving clears ownership: the next passive resize claims.
        b.close();
        seenA = resized(a.inbox, 70, true);
        a.send({ type: "term.resize", terminalId: id, cols: 70, rows: 20 });
        await seenA;
        // A claim always answers, even when the size does not change.
        seenA = resized(a.inbox, 70, true);
        a.send({ type: "term.resize", terminalId: id, cols: 70, rows: 20, claim: true });
        await seenA;
        await a.request("term.kill", { terminalId: id, signal: "SIGKILL" });
        a.close();
    }, 30_000);

    it("spawns a clean login environment", async () => {
        const a = await socketClient(home);
        const { terminal } = await a.request<Created>("term.create", { cols: 200, rows: 50, argv: ["env"], env: { EXTRA: "yes" } });
        const id = terminal.terminalId;
        await a.inbox.waitFor(m => m.type === "term.exit" && m.terminalId === id);
        const env = (await a.request<Attached>("term.attach", { terminalId: id })).snapshot.data;
        expect(env).toContain("PI_PROGRAM_STATUS=1");
        expect(env).toContain(`PIKA_NODE_PANE_ID=${id}`);
        expect(env).toContain(`PIKA_NODE_SOCKET=${home.socket}`);
        expect(env).toContain("TERM=xterm-256color");
        expect(env).toContain("TERM_PROGRAM=pika-node");
        expect(env).toContain("EXTRA=yes");
        expect(env).not.toContain("__PIKA_TEST_GUARD");
        expect(env).not.toContain("ORCA_TEST");
        const refused = await a.requestError("term.create", { cols: 80, rows: 24, env: { PIKA_NODE_PANE_ID: "x" } });
        expect(refused.code).toBe("invalid");
        a.close();
    }, 30_000);

    it("serves the bridge socket: status merge, replacement, and contained open/diff", async () => {
        const a = await socketClient(home);
        const { terminal } = await a.request<Created>("term.create", { cols: 80, rows: 24, argv: ["bash", "--noprofile", "--norc"] });
        const id = terminal.terminalId;
        const bridge = async () => {
            const socket = connect(home.socket);
            await new Promise<void>(resolve => socket.once("connect", resolve));
            const inbox = new Inbox();
            const decoder = new LineDecoder();
            socket.setEncoding("utf8");
            socket.on("data", (chunk: string) => { for (const line of decoder.push(chunk)) inbox.push(JSON.parse(line)); });
            const send = (message: object) => socket.write(encodeLine(message));
            send({ type: "hello", role: "bridge", paneId: id, pid: process.pid, version: "test", protocolVersion: PROTOCOL_VERSION });
            await inbox.waitFor(m => m.type === "welcome");
            return { socket, inbox, send };
        };
        const first = await bridge();
        const activity = { source: "subagents", id: "a1", label: "recon", kind: "agent", state: "running" };
        first.send({ type: "status", status: { state: "idle", activities: [activity], activityCount: 1, session: { id: "s1", cwd: project }, updatedAt: Date.now() } });
        const busy = await a.inbox.waitFor(m => m.type === "pane.status" && m.terminalId === id && (m.status as { state: string } | null)?.state === "busy");
        expect(busy.status).toMatchObject({ bridgeConnected: true, bridge: { activityCount: 1, session: { id: "s1" } } });

        const realProject = realpathSync(project);
        const opened = a.inbox.next(m => m.type === "pane.open" && m.terminalId === id);
        first.send({ type: "open", id: "o1", path: join(project, "notes.txt"), line: 3 });
        expect((await first.inbox.waitFor(m => m.type === "reply" && m.id === "o1")).result).toEqual({ delivered: expect.any(Number) });
        expect((await opened).path).toBe(join(realProject, "notes.txt"));
        first.send({ type: "open", id: "o2", path: "/etc/hosts" });
        expect((await first.inbox.waitFor(m => m.type === "reply" && m.id === "o2")).error).toMatchObject({ code: "outside_roots" });
        first.send({ type: "open", id: "o3", path: project });
        expect((await first.inbox.waitFor(m => m.type === "reply" && m.id === "o3")).error).toMatchObject({ code: "is_a_directory" });
        const diffed = a.inbox.next(m => m.type === "pane.diff" && m.terminalId === id);
        first.send({ type: "diff", id: "d1", path: join(project, "deleted.ts"), staged: true });
        expect((await first.inbox.waitFor(m => m.type === "reply" && m.id === "d1")).result).toBeDefined();
        expect(await diffed).toMatchObject({ path: join(realProject, "deleted.ts"), staged: true });

        // A newer bridge replaces the first; the first's close no longer marks the pane disconnected.
        const second = await bridge();
        second.send({ type: "status", status: { state: "waiting", activities: [], activityCount: 0, updatedAt: Date.now() } });
        await a.inbox.waitFor(m => m.type === "pane.status" && m.terminalId === id && (m.status as { state: string } | null)?.state === "waiting");
        first.socket.destroy();
        second.socket.destroy();
        await a.inbox.waitFor(m => m.type === "pane.status" && m.terminalId === id && (m.status as { bridgeConnected: boolean } | null)?.bridgeConnected === false);

        // An unknown pane is refused.
        const stray = connect(home.socket);
        const strayInbox: string[] = [];
        stray.setEncoding("utf8");
        stray.on("data", (chunk: string) => strayInbox.push(chunk));
        await new Promise<void>(resolve => stray.once("connect", resolve));
        stray.write(encodeLine({ type: "hello", role: "bridge", paneId: "nope", pid: 1, version: "test", protocolVersion: PROTOCOL_VERSION }));
        await new Promise<void>(resolve => stray.once("close", resolve));
        expect(JSON.parse(strayInbox.join(""))).toMatchObject({ type: "reply", id: "hello", error: { code: "not_found" } });
        await a.request("term.kill", { terminalId: id, signal: "SIGKILL" });
        a.close();
    }, 30_000);

    it("answers over `pika-node attach` on stdio", async () => {
        const child = spawn(BIN, ["attach"], { env: { ...process.env, PIKA_NODE_HOME: home.home }, stdio: ["pipe", "pipe", "inherit"] });
        const inbox = new Inbox();
        const decoder = new LineDecoder();
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { for (const line of decoder.push(chunk)) inbox.push(JSON.parse(line)); });
        const welcome = await inbox.waitFor(m => m.type === "welcome");
        expect(welcome).toMatchObject({ protocolVersion: 1, capabilities: expect.arrayContaining(["terminal"]) });
        child.stdin.write(encodeLine({ type: "fs.read", id: "f1", path: join(project, "notes.txt") }));
        expect((await inbox.waitFor(m => m.type === "reply" && m.id === "f1")).result).toMatchObject({ encoding: "utf8", data: "hello\n" });
        child.stdin.end();
        await new Promise(resolve => child.once("exit", resolve));
    }, 30_000);
});
