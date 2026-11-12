import { describe, expect, it } from "vitest";
import {
    becameDone, CAPABILITIES, displayFingerprint, ERROR_CODES, isCheckout, isWorktree, encodeLine, fromBase64Url, LIMITS, LineDecoder, LineTooLong, matchFingerprint, mergeState,
    parseBridgeMessage, parseChannelBody, parseClientMessage, parseClientToServer, parseDaemonToBridge, parseNodeMessage,
    parseNodeToServer, parseProgramStatus, parseServerToClient, parseServerToNode, toBase64Url, utf8Length,
    type BridgeStatus, type ProgramStatus,
} from "../src/protocol.ts";

const b64 = (length: number, fill = 7) => toBase64Url(new Uint8Array(length).fill(fill));
const SPKI = b64(91);
const now = 1_700_000_000_000;
const CID = "0123456789abcdef0123456789abcdef";

describe("routing frames", () => {
    it("parses node and server frames, dropping unknown fields", () => {
        const hello = parseNodeToServer({ type: "hello", host: "node01", version: "0.1.0", protocolVersions: [1], publicKey: SPKI, extra: 1 });
        expect(hello).toEqual({ ok: true, message: { type: "hello", host: "node01", version: "0.1.0", protocolVersions: [1], publicKey: SPKI } });
        expect(parseServerToNode({ type: "open", channel: "c1", client: { session: "abcdef012345" } }).ok).toBe(true);
        expect(parseServerToNode({ type: "frame", channel: "c1", body: { t: "rec" } }).ok).toBe(true);
        expect(parseServerToClient({ type: "nodes", items: [{ id: "n1", name: "node01", online: true }] }).ok).toBe(true);
        expect(parseServerToClient({ type: "refused", ref: "r1", code: "node_offline" }).ok).toBe(true);
        expect(parseClientToServer({ type: "open", ref: "r1", node: "n1" }).ok).toBe(true);
    });

    it("tells unknown types from invalid known ones", () => {
        expect(parseServerToNode({ type: "later", channel: "c1" })).toEqual({ ok: false, reason: "unknown", type: "later" });
        expect(parseServerToNode({ type: "frame", channel: "c1", body: "text" })).toMatchObject({ ok: false, reason: "invalid" });
        expect(parseServerToNode({ type: "frame", channel: "bad id!", body: {} })).toMatchObject({ ok: false, reason: "invalid" });
        expect(parseServerToNode("nope")).toEqual({ ok: false, reason: "unknown" });
        expect(parseClientToServer({ type: "refused", ref: "r", code: "x" })).toMatchObject({ reason: "unknown" });
    });

    it("never invokes accessors", () => {
        const frame = { type: "pong" } as Record<string, unknown>;
        Object.defineProperty(frame, "type", { get: () => { throw new Error("accessor ran"); }, enumerable: true });
        expect(parseNodeToServer(frame)).toEqual({ ok: false, reason: "unknown" });
    });
});

describe("channel bodies", () => {
    it("checks key, ephemeral, and signature sizes", () => {
        expect(parseChannelBody({ t: "hs1", v: 1, clientKey: SPKI, eph: b64(65), label: "Firefox on mbp" }).ok).toBe(true);
        expect(parseChannelBody({ t: "hs1", v: 1, clientKey: SPKI, eph: b64(64) }).ok).toBe(false);
        expect(parseChannelBody({ t: "hs2", v: 1, nodeKey: SPKI, eph: b64(65), sig: b64(64) }).ok).toBe(true);
        expect(parseChannelBody({ t: "hs3", sig: b64(63) }).ok).toBe(false);
        expect(parseChannelBody({ t: "hs1", v: 1, clientKey: SPKI, eph: b64(65), label: "a\nb" }).ok).toBe(false);
        expect(parseChannelBody({ t: "rec", n: 0, ct: b64(17) }).ok).toBe(true);
        expect(parseChannelBody({ t: "rec", n: -1, ct: b64(17) }).ok).toBe(false);
        expect(parseChannelBody({ t: "rec", n: 2 ** 32, ct: b64(17) }).ok).toBe(false);
        expect(parseChannelBody({ t: "rec", n: 0, ct: "a+b/" }).ok).toBe(false);
    });
});

describe("inner messages", () => {
    it("parses client requests and notices", () => {
        expect(parseClientMessage({ type: "term.create", id: "1", cols: 80, rows: 24, argv: ["pi"], env: { FOO: "bar" } }).ok).toBe(true);
        expect(parseClientMessage({ type: "term.input", terminalId: "t1", data: "ls\r" }).ok).toBe(true);
        expect(parseClientMessage({ type: "pane.seen", terminalId: "t1" }).ok).toBe(true);
        expect(parseClientMessage({ type: "fs.write", id: "2", path: "/a", encoding: "utf8", data: "x", expected: { absent: true } }).ok).toBe(true);
        expect(parseClientMessage({ type: "fs.write", id: "2", path: "/a", encoding: "utf8", data: "x", expected: { mtimeMs: 1, size: 1 } }).ok).toBe(true);
        expect(parseClientMessage({ type: "fs.uploadChunk", id: "3", upload: "u1", offset: 0, data: b64(10) }).ok).toBe(true);
    });

    it("rejects bad params and reports the request id", () => {
        expect(parseClientMessage({ type: "term.create", id: "1", cols: 0, rows: 24 })).toEqual({ ok: false, reason: "invalid", type: "term.create", id: "1" });
        expect(parseClientMessage({ type: "fs.read", id: "1", path: "relative/path" }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.read", id: "1", path: "/a\0b" }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.write", id: "2", path: "/a", encoding: "utf8", data: "x", expected: {} }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.write", id: "2", path: "/a", encoding: "base64", data: "not base64!", expected: { absent: true } }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.write", id: "2", path: "/a", encoding: "utf8", data: "x".repeat(LIMITS.maxReadBytes + 1), expected: { absent: true } }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.uploadStart", id: "4", name: "../x", size: 1 }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.gitShow", id: "5", path: "/a", ref: "HEAD" }).ok).toBe(true);
        expect(parseClientMessage({ type: "fs.gitShow", id: "5", path: "/a", ref: "index" }).ok).toBe(true);
        expect(parseClientMessage({ type: "fs.gitShow", id: "5", path: "/a", ref: "main" }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.list", id: "6", root: "/a" }).ok).toBe(true);
        expect(parseClientMessage({ type: "term.cwd", id: "7", terminalId: "t1" }).ok).toBe(true);
        expect(parseClientMessage({ type: "term.cwd", id: "7" }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.list", id: "6", root: "/a", limit: LIMITS.maxListEntries }).ok).toBe(true);
        expect(parseClientMessage({ type: "fs.list", id: "6", root: "/a", limit: LIMITS.maxListEntries + 1 }).ok).toBe(false);
        expect(parseClientMessage({ type: "fs.list", id: "6", root: "a" }).ok).toBe(false);
        expect(parseClientMessage({ type: "git.status", id: "8", root: "/a" }).ok).toBe(true);
        expect(parseClientMessage({ type: "git.status", id: "8", root: "a" }).ok).toBe(false);
        expect(parseClientMessage({ type: "git.status", id: "8" }).ok).toBe(false);
        expect(parseClientMessage({ type: "term.input", terminalId: "t1", data: "é".repeat(LIMITS.maxInputBytes / 2 + 1) }).ok).toBe(false);
        expect(parseClientMessage({ type: "term.create", id: "1", cols: 80, rows: 24, env: { "BAD-NAME": "x" } }).ok).toBe(false);
    });

    it("parses the rail's requests and notices: checkouts, worktrees, names, unread", () => {
        expect(parseClientMessage({ type: "checkouts.list", id: "1" }).ok).toBe(true);
        expect(parseClientMessage({ type: "checkout.add", id: "1", path: "/a" }).ok).toBe(true);
        expect(parseClientMessage({ type: "checkout.add", id: "1", path: "a" }).ok).toBe(false);
        expect(parseClientMessage({ type: "checkout.hide", id: "1", checkoutId: CID }).ok).toBe(true);
        expect(parseClientMessage({ type: "checkout.hide", id: "1", checkoutId: CID.toUpperCase() }).ok).toBe(false);
        expect(parseClientMessage({ type: "checkout.hide", id: "1", checkoutId: CID.slice(1) }).ok).toBe(false);
        expect(parseClientMessage({ type: "checkout.unhide", id: "1", checkoutId: CID }).ok).toBe(true);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID }).ok).toBe(true);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, name: "Mine" }).ok).toBe(true);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, name: null }).ok).toBe(true);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, name: " " }).ok).toBe(false);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, name: "x".repeat(121) }).ok).toBe(false);
        const settings = { worktreeLocation: "/w", worktreeBase: "origin/main", setupScript: "npm ci\nnpm run build" };
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, settings })).toMatchObject({ ok: true, message: { settings } });
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, settings: {} }).ok).toBe(true);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, settings: { worktreeLocation: "w" } }).ok).toBe(false);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, settings: { setupScript: " \n " } }).ok).toBe(false);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, settings: { setupScript: "a\u001bb" } }).ok).toBe(false);
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, settings: { setupScript: "x".repeat(4_097) } }).ok).toBe(false);
        // Settings are stored as given, so an unknown field is refused rather than dropped.
        expect(parseClientMessage({ type: "checkout.update", id: "1", checkoutId: CID, settings: { other: 1 } }).ok).toBe(false);
        expect(parseClientMessage({ type: "worktree.create", id: "1", checkoutId: CID, name: "feat/x" }).ok).toBe(true);
        expect(parseClientMessage({ type: "worktree.create", id: "1", checkoutId: CID, name: "feat/x", base: "main", cols: 120, rows: 40 }).ok).toBe(true);
        expect(parseClientMessage({ type: "worktree.create", id: "1", checkoutId: CID, name: "a\nb" }).ok).toBe(false);
        expect(parseClientMessage({ type: "worktree.create", id: "1", checkoutId: CID, name: "x", cols: 0 }).ok).toBe(false);
        expect(parseClientMessage({ type: "worktree.remove", id: "1", checkoutId: CID, path: "/a" }).ok).toBe(true);
        expect(parseClientMessage({ type: "worktree.remove", id: "1", checkoutId: CID, path: "/a", deleteBranch: true, force: false }).ok).toBe(true);
        expect(parseClientMessage({ type: "worktree.remove", id: "1", checkoutId: CID, path: "/a", force: "yes" }).ok).toBe(false);
        for (const type of ["projects.list", "projects.add", "git.worktreeAdd", "git.worktreeRemove"]) {
            expect(parseClientMessage({ type, id: "1", path: "/a" })).toMatchObject({ ok: false, reason: "unknown" });
        }
        expect(parseClientMessage({ type: "term.rename", id: "1", terminalId: "t1", label: "Reviewer" }).ok).toBe(true);
        expect(parseClientMessage({ type: "term.rename", id: "1", terminalId: "t1", label: null }).ok).toBe(true);
        expect(parseClientMessage({ type: "term.rename", id: "1", terminalId: "t1", label: "a\u001bb" }).ok).toBe(false);
        expect(parseClientMessage({ type: "pane.unread", terminalId: "t1" }).ok).toBe(true);
        expect(parseNodeMessage({ type: "term.renamed", terminalId: "t1", label: "Reviewer" }).ok).toBe(true);
        expect(parseNodeMessage({ type: "term.renamed", terminalId: "t1", label: null }).ok).toBe(true);
        expect(parseNodeMessage({ type: "projects.changed" })).toMatchObject({ ok: false, reason: "unknown" });
        expect(parseNodeMessage({ type: "term.created", terminal: { terminalId: "t1", title: "", cwd: "/", cols: 1, rows: 1, pid: 1, createdAt: 1, argv: ["sh"], label: "Mine" } })).toMatchObject({ ok: true, message: { terminal: { label: "Mine" } } });
        expect(parseNodeMessage({ type: "term.created", terminal: { terminalId: "t1", title: "", cwd: "/", cols: 1, rows: 1, pid: 1, createdAt: 1, argv: ["sh"], label: "" } }).ok).toBe(false);
    });

    it("answers unknown requests by id", () => {
        expect(parseClientMessage({ type: "term.teleport", id: "9" })).toEqual({ ok: false, reason: "unknown", type: "term.teleport", id: "9" });
    });

    it("parses node messages; a reply has exactly one of result and error", () => {
        expect(parseNodeMessage({ type: "reply", id: "1", result: {} }).ok).toBe(true);
        expect(parseNodeMessage({ type: "reply", id: "1", error: { code: "conflict", message: "changed", current: { size: 1, mtimeMs: 2 } } }).ok).toBe(true);
        expect(parseNodeMessage({ type: "reply", id: "1" }).ok).toBe(false);
        expect(parseNodeMessage({ type: "reply", id: "1", result: {}, error: { code: "io", message: "" } }).ok).toBe(false);
        expect(parseNodeMessage({ type: "term.output", terminalId: "t1", seq: 1, data: "hi" }).ok).toBe(true);
        expect(parseNodeMessage({ type: "term.output", terminalId: "t1", seq: 0, data: "hi" }).ok).toBe(false);
        expect(parseNodeMessage({ type: "term.exit", terminalId: "t1", code: null, signal: "SIGHUP" }).ok).toBe(true);
        expect(parseNodeMessage({ type: "pane.status", terminalId: "t1", status: null }).ok).toBe(true);
        expect(parseNodeMessage({
            type: "pane.status", terminalId: "t1",
            status: { state: "waiting", program: { state: "blocked", app: "pi", kind: "question", at: now }, bridgeConnected: false, unread: false },
        }).ok).toBe(true);
    });
});

const bridge = (overrides: Partial<BridgeStatus> = {}): BridgeStatus => ({ state: "idle", activities: [], activityCount: 0, updatedAt: now, ...overrides });

describe("bridge socket", () => {
    it("requires a pane and pid from a bridge but not from attach", () => {
        expect(parseBridgeMessage({ type: "hello", role: "bridge", paneId: "t1", pid: 42, version: "0.1.0", protocolVersion: 1 }).ok).toBe(true);
        expect(parseBridgeMessage({ type: "hello", role: "bridge", version: "0.1.0", protocolVersion: 1 }).ok).toBe(false);
        expect(parseBridgeMessage({ type: "hello", role: "client", version: "0.1.0", protocolVersion: 1 }).ok).toBe(true);
    });

    it("validates statuses like the Orca activity protocol", () => {
        const activity = { source: "subagents", id: "a1", label: "Reviewing", state: "running", progress: { completed: 1, total: 3 } };
        expect(parseBridgeMessage({ type: "status", status: bridge({ activities: [activity as never], activityCount: 1, session: { id: "s1", cwd: "/home/u" } }) }).ok).toBe(true);
        expect(parseBridgeMessage({ type: "status", status: bridge({ activities: [activity, activity] as never, activityCount: 2 }) }).ok).toBe(false);
        expect(parseBridgeMessage({ type: "status", status: bridge({ activities: [activity as never], activityCount: 0 }) }).ok).toBe(false);
        expect(parseBridgeMessage({ type: "status", status: bridge({ activities: [{ ...activity, progress: { completed: 4, total: 3 } }] as never, activityCount: 1 }) }).ok).toBe(false);
        // An older bridge's `title` is an unknown field now, not a reason to drop its status.
        expect(parseBridgeMessage({ type: "status", status: { ...bridge(), title: "old" } }).ok).toBe(true);
        expect(parseBridgeMessage({ type: "open", id: "o1", path: "/home/u/a.ts", line: 3 }).ok).toBe(true);
        expect(parseBridgeMessage({ type: "diff", id: "d1", path: "a.ts" }).ok).toBe(false);
        expect(parseDaemonToBridge({ type: "reply", id: "o1", result: { delivered: 2 } }).ok).toBe(true);
    });
});

describe("pane status", () => {
    const msg = toBase64Url(new TextEncoder().encode("Allow\x1b[31m rm -rf?\nyes"));
    it("parses OSC 7501 payloads", () => {
        expect(parseProgramStatus(`state=blocked:app=pi:kind=permission:msg=${msg}`, now))
            .toEqual({ state: "blocked", app: "pi", kind: "permission", message: "Allow rm -rf? yes", at: now });
        expect(parseProgramStatus("state=working:app=pi", now)).toEqual({ state: "working", app: "pi", at: now });
        expect(parseProgramStatus("state=clear:app=pi", now)).toBe("clear");
        expect(parseProgramStatus("?", now)).toBeUndefined();
        expect(parseProgramStatus("state=dancing:app=pi", now)).toBeUndefined();
        expect(parseProgramStatus("state=idle", now)).toBeUndefined();
        expect(parseProgramStatus("state=idle:state=busy:app=pi", now)).toBeUndefined();
        // Standard padded base64 is accepted too; an unknown kind is dropped.
        expect(parseProgramStatus(`state=blocked:app=pi:kind=other:msg=${btoa("ok?")}`, now)).toEqual({ state: "blocked", app: "pi", message: "ok?", at: now });
    });

    const program = (state: ProgramStatus["state"]): ProgramStatus => ({ state, app: "pi", at: now });
    it("merges program and bridge status", () => {
        expect(mergeState(undefined, undefined)).toBe("idle");
        expect(mergeState(program("working"), undefined)).toBe("busy");
        expect(mergeState(program("blocked"), bridge({ state: "busy" }))).toBe("waiting");
        // The program status is authoritative for the root agent...
        expect(mergeState(program("done"), bridge({ state: "busy" }))).toBe("idle");
        // ...but background activities keep the pane busy, and a bridge dialog still makes it wait.
        expect(mergeState(program("done"), bridge({ activities: [{ source: "s", id: "1", label: "x" }], activityCount: 1 }))).toBe("busy");
        expect(mergeState(program("working"), bridge({ state: "waiting" }))).toBe("waiting");
        expect(mergeState(program("idle"), bridge({ activities: [{ source: "s", id: "1", label: "x", state: "waiting" }], activityCount: 1 }))).toBe("waiting");
        expect(mergeState(undefined, bridge({ state: "busy" }))).toBe("busy");
        expect(becameDone("busy", "idle")).toBe(true);
        expect(becameDone("waiting", "idle")).toBe(true);
        expect(becameDone("idle", "idle")).toBe(false);
        expect(becameDone("busy", "waiting")).toBe(false);
    });
});

describe("helpers", () => {
    it("round-trips base64url and rejects non-canonical input", () => {
        for (let length = 0; length < 70; length++) {
            const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length) & 0xff);
            const text = toBase64Url(bytes);
            expect(text).toBe(Buffer.from(bytes).toString("base64url"));
            expect(fromBase64Url(text)).toEqual(bytes);
        }
        expect(fromBase64Url("AB")).toBeUndefined(); // non-zero trailing bits
        expect(fromBase64Url("A")).toBeUndefined();
        expect(fromBase64Url("AA==")).toBeUndefined();
        expect(fromBase64Url("a+b/")).toBeUndefined();
    });

    it("counts UTF-8 bytes", () => {
        for (const text of ["", "abc", "é", "日本", "😀", "a\ud800b"]) expect(utf8Length(text)).toBe(Buffer.byteLength(text, "utf8"));
    });

    it("matches fingerprints by long prefixes only", () => {
        const a = "ab".repeat(32), b = "ab".repeat(10) + "cd".repeat(22);
        expect(displayFingerprint(a)).toBe("abab abab abab abab abab abab abab abab");
        expect(matchFingerprint("ABAB abab abab abab abab", [a, b])).toEqual([a, b]);
        expect(matchFingerprint("ab".repeat(11), [a, b])).toEqual([a]);
        expect(matchFingerprint("ab".repeat(9), [a, b])).toEqual([]);
        expect(matchFingerprint("zz".repeat(12), [a])).toEqual([]);
    });

    it("splits NDJSON and bounds line length", () => {
        const decoder = new LineDecoder(16);
        expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
        expect(decoder.push(':2}\n\n')).toEqual(['{"b":2}']);
        expect(() => decoder.push("x".repeat(17))).toThrow(LineTooLong);
        expect(encodeLine({ text: "a\nb" })).toBe('{"text":"a\\nb"}\n');
    });
});

describe("checkouts", () => {
    const main = { path: "/w/repo", branch: "main", head: "a".repeat(40), isMain: true, prunable: false, locked: false, detached: false };
    const linked = { path: "/w/repo-fix", head: "b".repeat(64), isMain: false, prunable: true, locked: true, detached: true };
    const git = {
        id: CID, kind: "git", path: "/w/repo", commonDir: "/w/repo/.git", repository: "https://github.com/me/repo", project: "repo",
        name: "Repo", named: true, source: "configured", settings: { worktreeBase: "origin/main" }, worktrees: [main, linked],
    };
    const folder = { id: "f".repeat(32), kind: "folder", path: "/w/notes", project: "notes", name: "notes", source: "discovered", settings: {}, worktrees: [] };
    const changed = (checkouts: unknown[]) => parseNodeMessage({ type: "checkouts.changed", checkouts, truncated: false });

    it("parses a checkouts snapshot with git and folder checkouts", () => {
        expect(changed([git, folder])).toEqual({ ok: true, message: { type: "checkouts.changed", checkouts: [git, folder], truncated: false } });
        expect(changed([])).toMatchObject({ ok: true });
        expect(parseNodeMessage({ type: "checkouts.changed", checkouts: [] }).ok).toBe(false);
        expect(changed([{ ...git, truncated: true }]).ok).toBe(true);
        expect(changed([{ ...git, source: "terminal" }]).ok).toBe(true);
    });

    it("refuses malformed checkouts", () => {
        expect(changed([{ ...git, id: "xyz" }]).ok).toBe(false);
        expect(changed([{ ...git, commonDir: undefined }]).ok).toBe(false);
        expect(changed([{ ...folder, commonDir: "/w/notes/.git" }]).ok).toBe(false);
        expect(changed([{ ...folder, repository: "https://github.com/me/notes" }]).ok).toBe(false);
        expect(changed([{ ...folder, worktrees: [main] }]).ok).toBe(false);
        expect(changed([{ ...git, repository: "git@github.com:me/repo.git" }]).ok).toBe(false);
        expect(changed([{ ...git, project: "" }]).ok).toBe(false);
        expect(changed([{ ...git, source: "found" }]).ok).toBe(false);
        expect(changed([{ ...git, named: false }]).ok).toBe(false);
        expect(changed([{ ...git, settings: { worktreeLocation: "rel" } }]).ok).toBe(false);
        expect(changed([{ ...git, worktrees: [{ ...main, head: "abc" }] }]).ok).toBe(false);
        expect(changed([{ ...git, worktrees: [{ ...main, isMain: undefined }] }]).ok).toBe(false);
        expect(changed([{ ...git, worktrees: Array.from({ length: LIMITS.maxWorktrees + 1 }, () => linked) }]).ok).toBe(false);
        expect(changed(Array.from({ length: LIMITS.maxCheckouts + 1 }, () => folder)).ok).toBe(false);
    });

    it("places terminals in a checkout's worktree", () => {
        const terminal = { terminalId: "t1", title: "", cwd: "/w/repo-fix/src", cols: 1, rows: 1, pid: 1, createdAt: 1, argv: ["sh"], checkoutId: CID, worktreePath: "/w/repo-fix" };
        expect(parseNodeMessage({ type: "term.created", terminal })).toMatchObject({ ok: true, message: { terminal: { checkoutId: CID, worktreePath: "/w/repo-fix" } } });
        expect(parseNodeMessage({ type: "term.created", terminal: { ...terminal, worktreePath: "rel" } }).ok).toBe(false);
        expect(parseNodeMessage({ type: "term.placed", terminalId: "t1", checkoutId: CID, worktreePath: "/w/repo" }).ok).toBe(true);
        expect(parseNodeMessage({ type: "term.placed", terminalId: "t1", checkoutId: null, worktreePath: null }).ok).toBe(true);
        expect(parseNodeMessage({ type: "term.placed", terminalId: "t1", checkoutId: CID }).ok).toBe(false);
    });

    it("validates checkout results with isCheckout and isWorktree", () => {
        expect(isCheckout(git)).toBe(true);
        expect(isCheckout(folder)).toBe(true);
        expect(isCheckout({ ...folder, kind: "dir" })).toBe(false);
        expect(isWorktree(main)).toBe(true);
        expect(isWorktree({ ...main, path: "w" })).toBe(false);
    });

    it("lists the checkouts capability in place of the spike's project capabilities, and the busy error", () => {
        expect(CAPABILITIES).toEqual(["terminal", "files", "status", "checkouts", "term.rename", "pane.unread"]);
        expect(ERROR_CODES).toContain("busy");
    });
});
