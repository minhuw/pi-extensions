import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { Daemon, type Peer } from "../src/daemon.ts";
import { Pane } from "../src/pane.ts";
import { ensureDirs } from "../src/paths.ts";
import { LIMITS, utf8Length, type NodeMessage, type Snapshot, type TerminalInfo } from "../src/protocol.ts";
import { restoreSuffix, serializeScreen } from "../src/snapshot.ts";
import { spawnCommand, spawnEnv } from "../src/spawn.ts";
import { addPending, allowPending, readClients, readPending, removeClient, saveConfig } from "../src/store.ts";
import { chunks } from "../src/terminal.ts";
import { UNICODE_VERSION, applyWidths } from "../src/widths.ts";
import { tempHome, until } from "./support.ts";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

function screen(cols = 80, rows = 24, widths = true) {
    const terminal = new Terminal({ cols, rows, scrollback: 1_000, allowProposedApi: true });
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    if (widths) applyWidths(terminal);
    const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
    return { terminal, addon, write };
}

/** The state that decides what keys send and how output lands, read the way `restoreSuffix` reads it. */
function state(terminal: InstanceType<typeof Terminal>) {
    const core = (terminal as unknown as { _core: { coreMouseService: { activeEncoding: string; activeProtocol: string }; coreService: { isCursorHidden: boolean; decPrivateModes: object }; buffer: { scrollTop: number; scrollBottom: number } } })._core;
    return {
        modes: terminal.modes, encoding: core.coreMouseService.activeEncoding, protocol: core.coreMouseService.activeProtocol,
        hidden: core.coreService.isCursorHidden, privateModes: core.coreService.decPrivateModes,
        region: [core.buffer.scrollTop, core.buffer.scrollBottom], cursor: [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY],
        buffer: terminal.buffer.active.type,
    };
}

describe("snapshots", () => {
    const cases = {
        "normal buffer with a scroll region and origin mode": "hello\r\n\x1b[?1h\x1b=\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[3;20r\x1b[?6h\x1b[5;7H\x1b[6 q\x1b[?1004h",
        "alternate buffer with SGR-pixel mouse": "main\r\n\x1b[?1049h\x1b[2;3Halt screen\x1b[?1003h\x1b[?1016h\x1b[4 q\x1b[?2004h",
        "defaults": "plain text\r\nsecond line",
    };
    for (const [name, input] of Object.entries(cases)) {
        it(`restores ${name}`, async () => {
            const source = screen();
            await source.write(input);
            const target = screen();
            await target.write(serializeScreen(source.terminal, source.addon));
            expect(state(target.terminal)).toEqual(state(source.terminal));
        });
    }

    it("needs the suffix: the serialize addon alone drops these modes (fails if a new addon version adds them)", async () => {
        const source = screen();
        await source.write("x\x1b[?1006h\x1b[?25l\x1b[3;20r\x1b[5 q");
        const target = screen();
        await target.write(source.addon.serialize());
        const before = state(target.terminal);
        expect(before.encoding).toBe("DEFAULT");
        expect(before.hidden).toBe(false);
        expect(before.region).toEqual([0, 23]);
        expect(restoreSuffix(source.terminal)).toBe("\x1b[?1006h\x1b[5 q\x1b[3;20r\x1b[1;1H\x1b[?25l");
    });

    it("leaves no kitty keyboard flags to restore: xterm 6.0 does not answer CSI ? u", async () => {
        const source = screen();
        const replies: string[] = [];
        source.terminal.onData(data => replies.push(data));
        await source.write("\x1b[>1u\x1b[?u\x1b[c");
        expect(replies).toEqual(["\x1b[?1;2c"]);
    });

    it("drops scrollback until the snapshot fits 512 KiB and one record", async () => {
        const source = screen(200, 50);
        const line = `\x1b[38;2;1;2;3m${"█".repeat(190)}\x1b[0m\r\n`;
        for (let i = 0; i < 1_100; i++) await source.write(line);
        const data = serializeScreen(source.terminal, source.addon);
        expect(utf8Length(data)).toBeLessThanOrEqual(LIMITS.maxSnapshotBytes);
        expect(utf8Length(JSON.stringify(data))).toBeLessThan(LIMITS.maxRecordBytes);
        expect(utf8Length(source.addon.serialize())).toBeGreaterThan(LIMITS.maxSnapshotBytes);
    });
});

/** Every cell of the buffer (characters and width) and the cursor, to compare two screens exactly. */
function cells(terminal: InstanceType<typeof Terminal>): string {
    const buffer = terminal.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y)!;
        const row: string[] = [];
        for (let x = 0; x < terminal.cols; x++) {
            const cell = line.getCell(x)!;
            row.push(`${cell.getChars()}/${cell.getWidth()}`);
        }
        rows.push(row.join(" "));
    }
    return `${rows.join("\n")}\ncursor ${buffer.cursorX},${buffer.cursorY}`;
}

describe("widths", () => {
    // pi-tui 1.5.2's `visibleWidth` for each string (RGI emoji 2, VS16 and ZWJ sequences one emoji, East Asian Wide 2).
    const PI_WIDTHS: [string, number][] = [
        ["🐝", 2], ["⚡", 2], ["✅", 2], ["🟢", 2], ["⭐", 2], ["⌚", 2],
        ["❤", 1], ["❤\uFE0F", 2], ["✔\uFE0F", 2], ["🖥\uFE0F", 2], ["©", 1], ["#\uFE0F\u20E3", 2],
        ["👍🏽", 2], ["👨\u200D👩\u200D👧", 2], ["🏳\uFE0F\u200D🌈", 2], ["🧑\u200D💻", 2], ["🇨🇭", 2],
        ["中文", 4], ["한", 2], ["ｱ", 1], ["Ａ", 2], ["\uE0B0", 1], ["\u{F0615}", 1], ["▉", 1], ["…", 1], ["e\u0301", 1],
    ];

    it("are pi's for emoji, sequences, CJK and Private Use Area icons", async () => {
        const actual: [string, number][] = [];
        for (const [text] of PI_WIDTHS) {
            const source = screen(40, 3);
            await source.write(text);
            actual.push([text, source.terminal.buffer.active.cursorX]);
        }
        expect(actual).toEqual(PI_WIDTHS);
        expect(screen().terminal.unicode.activeVersion).toBe(UNICODE_VERSION);
    });

    it("are not pi's without the addon: xterm 6 gives emoji one cell (fails if a new version changes its default)", async () => {
        const source = screen(40, 3, false);
        await source.write("🐝⚡✅");
        expect(source.terminal.unicode.activeVersion).toBe("6");
        expect(source.terminal.buffer.active.cursorX).toBe(3);
    });

    it("right-align pi's footer: the line ends at the right edge", async () => {
        // pi pads the footer by its own widths: the left part is 14 cells (🐝 2, the icon 1), the right 10.
        const line = `🐝 swarm  \u{F0615} 0×${" ".repeat(40 - 14 - 10)}▉▉▉▉  0.0%`;
        const source = screen(40, 3);
        await source.write(line);
        expect(source.terminal.buffer.active.cursorX).toBe(40);
        expect(source.terminal.buffer.active.getLine(0)!.translateToString(true)).toBe(line);
    });

    it("survive a snapshot: emoji, sequences and CJK restore cell for cell", async () => {
        const source = screen(30, 4);
        await source.write("🐝 swarm ❤\uFE0F 👨\u200D👩\u200D👧 🇨🇭 中文 e\u0301|\r\n\x1b[1m🧑\u200D💻\x1b[0m ✔\uFE0F #\uFE0F\u20E3 👍🏽 end");
        const target = screen(30, 4);
        await target.write(serializeScreen(source.terminal, source.addon));
        expect(cells(target.terminal)).toEqual(cells(source.terminal));
        expect(state(target.terminal)).toEqual(state(source.terminal));
    });

    it("join a sequence a snapshot cut in two, as the live screen does", async () => {
        const live = screen(30, 3);
        await live.write("x👨");
        const target = screen(30, 3);
        await target.write(serializeScreen(live.terminal, live.addon));
        for (const side of [live, target]) await side.write("\u200D👩 y");
        expect(cells(target.terminal)).toEqual(cells(live.terminal));
        expect(live.terminal.buffer.active.cursorX).toBe(5);
    });
});

describe("output chunks", () => {
    it("cut at the byte limit without splitting characters", () => {
        const text = `${"a".repeat(5)}😀é${"b".repeat(3)}`;
        const pieces = chunks(text, 6);
        expect(pieces.join("")).toBe(text);
        for (const piece of pieces) expect(utf8Length(piece)).toBeLessThanOrEqual(6);
        expect(pieces.some(piece => piece.includes("😀"))).toBe(true);
        expect(chunks("x".repeat(100), 64)).toHaveLength(2);
    });
});

describe("pane status", () => {
    const at = 1;
    it("sets unread when work ends and on error, and clears on seen", () => {
        const pane = new Pane();
        expect(pane.view()).toBeNull();
        expect(pane.setProgram({ state: "working", app: "pi", at }, "node")).toBe(true);
        expect(pane.view()).toMatchObject({ state: "busy", unread: false });
        pane.setProgram({ state: "blocked", app: "pi", kind: "permission", at }, "node");
        expect(pane.view()?.state).toBe("waiting");
        pane.setProgram({ state: "done", app: "pi", at }, "node");
        expect(pane.view()).toMatchObject({ state: "idle", unread: true });
        expect(pane.seen()).toBe(true);
        expect(pane.view()?.unread).toBe(false);
        pane.setProgram({ state: "error", app: "pi", at }, "node");
        expect(pane.view()?.unread).toBe(true);
    });

    it("clears a program status when the foreground process changes", () => {
        const pane = new Pane();
        pane.setProgram({ state: "working", app: "pi", at }, "node");
        expect(pane.foreground("node")).toBe(false);
        expect(pane.foreground("bash")).toBe(true);
        expect(pane.view()).toBeNull();
    });

    it("keeps a pane busy while bridge activities run, and waiting wins", () => {
        const pane = new Pane();
        pane.setProgram({ state: "idle", app: "pi", at }, "node");
        pane.setBridge({ state: "idle", activities: [{ source: "subagents", id: "1", label: "recon" }], activityCount: 1, updatedAt: at });
        expect(pane.view()).toMatchObject({ state: "busy", bridgeConnected: true });
        pane.setBridge({ state: "waiting", activities: [], activityCount: 0, updatedAt: at });
        expect(pane.view()?.state).toBe("waiting");
        pane.bridgeClosed();
        expect(pane.view()).toMatchObject({ state: "idle", bridgeConnected: false, bridge: { state: "waiting" } });
        pane.exit();
        expect(pane.view()).toBeNull();
    });
});

describe("spawning", () => {
    const account = { home: "/home/u", user: "u", shell: "/bin/bash" };
    it("builds a clean environment and refuses reserved names", () => {
        const env = spawnEnv({ account, socket: "/s", paneId: "p1", env: { EDITOR: "vi" }, lang: undefined });
        expect(env).toEqual({
            HOME: "/home/u", USER: "u", LOGNAME: "u", SHELL: "/bin/bash", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8",
            TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "pika-node", PI_PROGRAM_STATUS: "1",
            PIKA_NODE_SOCKET: "/s", PIKA_NODE_PANE_ID: "p1", EDITOR: "vi",
        });
        for (const name of ["PIKA_NODE_X", "PI_PROGRAM_STATUS", "ORCA_PANE", "__ETC_PROFILE_NIX_SOURCED"]) {
            expect(() => spawnEnv({ account, socket: "/s", paneId: "p", env: { [name]: "1" } })).toThrow(name);
        }
    });

    it("runs argv through the login shell", () => {
        expect(spawnCommand("/bin/zsh")).toEqual({ file: "/bin/zsh", args: ["-l"] });
        expect(spawnCommand("/bin/bash", ["pi", "--resume"])).toEqual({ file: "/bin/bash", args: ["-l", "-c", 'exec "$@"', "pika-node", "pi", "--resume"] });
        expect(spawnCommand("/usr/bin/fish", ["pi"])).toEqual({ file: "/usr/bin/fish", args: ["-l", "-c", "exec $argv[2..]", "pika-node", "pi"] });
        expect(spawnCommand("/usr/bin/nu", ["pi"]).file).toBe("/bin/sh");
    });
});

describe("enrolment files", () => {
    const home = tempHome();
    afterAll(() => home.cleanup());
    it("allows exactly one matching pending client, keeps 16, and expires entries", () => {
        ensureDirs(home);
        const now = Date.now();
        const fp = (i: number) => (i % 16).toString(16).repeat(30) + String(i).padStart(34, "0");
        for (let i = 0; i < 18; i++) addPending(home, { fingerprint: fp(i), publicKey: "k", label: `c${i}`, at: now + i });
        // The oldest two went first.
        expect(readPending(home, now + 20).map(row => row.label)).toEqual([...Array(16).keys()].map(i => `c${i + 2}`));
        addPending(home, { fingerprint: "f".repeat(30) + "1".repeat(34), publicKey: "k", label: "twin", at: now + 19 });
        expect(() => allowPending(home, "f".repeat(30), now + 20)).toThrow(/more than one/);
        expect(() => allowPending(home, "f".repeat(19), now + 20)).toThrow(/at least 20/);
        expect(() => allowPending(home, "e".repeat(29) + "1", now + 20)).toThrow(/no pending/);
        const key = allowPending(home, `${"f".repeat(30)}1`, now + 20);
        expect(key.label).toBe("twin");
        expect(readClients(home).clients.map(row => row.fingerprint)).toEqual([key.fingerprint]);
        expect(readPending(home, now + 20)).toHaveLength(15);
        expect(readPending(home, now + 10 * 60_000 + 100)).toHaveLength(0);
        expect(removeClient(home, "f".repeat(24)).fingerprint).toBe(key.fingerprint);
        expect(readClients(home).clients).toEqual([]);
    });
});

describe("backpressure", () => {
    const home = tempHome();
    ensureDirs(home);
    // A root of its own, so the daemon's checkout scan stays out of the real home.
    saveConfig(home, { version: 1, roots: [home.home] });
    const daemon = new Daemon({ paths: home });
    afterAll(async () => {
        await daemon.shutdown();
        home.cleanup();
    });

    class FakePeer implements Peer {
        messages: NodeMessage[] = [];
        stuck = 0;
        closed = false;
        readonly name: string;
        constructor(name: string) { this.name = name; }
        send(message: NodeMessage): void { this.messages.push(message); }
        buffered(): number { return this.stuck; }
        reply<T>(id: string): T | undefined {
            const reply = this.messages.find(m => m.type === "reply" && m.id === id) as { result?: T } | undefined;
            return reply?.result;
        }
        outputs(terminalId: string) { return this.messages.filter(m => m.type === "term.output" && m.terminalId === terminalId) as { seq: number; data: string }[]; }
    }

    it("resyncs a stuck client with a snapshot while a fast one gets every chunk, without pausing the PTY", async () => {
        const fast = new FakePeer("fast");
        const slow = new FakePeer("slow");
        daemon.addPeer(fast);
        daemon.addPeer(slow);
        // 4 MiB of output after a moment, then a marker.
        const script = "setTimeout(() => { const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 4096; i++) process.stdout.write(line); process.stdout.write('END-OF-FLOOD\\n'); setTimeout(() => {}, 60000); }, 500)";
        daemon.handle(fast, { type: "term.create", id: "c", cols: 120, rows: 30, argv: [process.execPath, "-e", script] });
        await until(() => fast.reply<{ terminal: TerminalInfo }>("c") !== undefined, 10_000, "created");
        const id = fast.reply<{ terminal: TerminalInfo }>("c")!.terminal.terminalId;
        daemon.handle(fast, { type: "term.attach", id: "a1", terminalId: id });
        daemon.handle(slow, { type: "term.attach", id: "a2", terminalId: id });
        await until(() => slow.reply("a2") !== undefined && fast.reply("a1") !== undefined, 10_000, "attached");
        slow.stuck = 8 * 1024 * 1024;

        await until(() => fast.outputs(id).some(m => m.data.includes("END-OF-FLOOD")), 30_000, "flood at the fast client");
        const fastSeqs = fast.outputs(id).map(m => m.seq);
        const start = fast.reply<{ snapshot: Snapshot }>("a1")!.snapshot.outputSequence;
        expect(fastSeqs).toEqual(fastSeqs.map((_, i) => start + 1 + i));
        // The stuck client got nothing past its transport limit and no snapshot yet.
        expect(slow.outputs(id).length).toBe(0);
        expect(slow.messages.some(m => m.type === "term.snapshot")).toBe(false);

        slow.stuck = 0;
        await until(() => slow.messages.some(m => m.type === "term.snapshot"), 10_000, "resync snapshot");
        const resync = slow.messages.find(m => m.type === "term.snapshot") as { snapshot: Snapshot };
        expect(resync.snapshot.data).toContain("END-OF-FLOOD");
        expect(resync.snapshot.outputSequence).toBeGreaterThan(start);
        // Streaming resumes right after the snapshot.
        daemon.handle(fast, { type: "term.input", terminalId: id, data: "after\r" });
        await until(() => slow.outputs(id).length > 0, 10_000, "output after resync");
        expect(slow.outputs(id)[0]!.seq).toBe(resync.snapshot.outputSequence + 1);
        daemon.handle(fast, { type: "term.kill", id: "k", terminalId: id, signal: "SIGKILL" });
    }, 60_000);
});
