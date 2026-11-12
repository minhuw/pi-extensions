/**
 * The pika nodes v1 wire contract (`services/pika/docs/NODE.md`): routing frames between nodes, browsers, and
 * the server; end-to-end channel bodies; inner messages; and the bridge socket. No imports, no I/O: the daemon,
 * the web UI (by relative path), and tests share this file, and the bridge copies its socket subset.
 */

/** The end-to-end and inner protocol version (`hs1.v`, `welcome.protocolVersion`, bridge `hello`). */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_VERSIONS: readonly number[] = [1];

const KiB = 1024;
const MiB = 1024 * KiB;

export const LIMITS = {
    maxFrameBytes: 2 * MiB,
    maxRecordBytes: 1 * MiB,
    maxRecords: 2 ** 32,
    maxOutputChunkBytes: 64 * KiB,
    maxInputBytes: 64 * KiB,
    /** Scrollback is 1000 rows, oldest dropped to fit; full history is the raw log. */
    maxSnapshotBytes: 512 * KiB,
    /** Overflow drops the client's backlog and resyncs it with a snapshot; the PTY never pauses. */
    maxClientBacklogBytes: 1 * MiB,
    maxReadBytes: 512 * KiB,
    maxReadDirEntries: 5_000,
    /** `fs.list`: at most this many paths, whose UTF-8 bytes together stay under `maxListBytes` (one record). */
    maxListEntries: 50_000,
    maxListBytes: 768 * KiB,
    /** `git.status`: at most this many entries, tracked changes before untracked files. */
    maxStatusEntries: 5_000,
    maxUploadBytes: 256 * MiB,
    maxUploadChunkBytes: 512 * KiB,
    maxWatchesPerChannel: 64,
    maxPendingEnrolments: 16,
    maxBridgeLineBytes: 1 * MiB,
    maxActivities: 128,
    maxActivityCount: 1_024,
    maxEnv: 64,
    maxArgv: 256,
    maxCols: 1_000,
    maxRows: 500,
    maxPathBytes: 4_096,
    /** Shortest client fingerprint prefix `pika-node clients add` accepts, in hex characters. */
    minFingerprintPrefix: 20,
} as const;

/** Timings, mutable so tests can shorten them. */
export const timing = {
    heartbeatMs: 20_000,
    deadAfterMs: 45_000,
    helloTimeoutMs: 10_000,
    handshakeTimeoutMs: 10_000,
    pendingEnrolmentMs: 10 * 60_000,
    outputFlushMs: 16,
    watchCoalesceMs: 100,
    bridgeStatusMs: 100,
    uploadIdleMs: 60_000,
    foregroundPollMs: 2_000,
};

// ---------------------------------------------------------------------------------------------------------------
// Codes

export const SOCKET_CLOSES: ReadonlyMap<number, string> = new Map([
    [1001, "server shutting down, or silent too long"],
    [1008, "outgoing buffer full"],
    [4400, "bad frame"],
    [4401, "credential or session revoked"],
    [4408, "no hello in time"],
    [4410, "replaced by a newer socket for the same node"],
    [4429, "too many nodes, sockets, or channels"],
    [4503, "nodes turned off"],
]);

export const CHANNEL_CLOSE_CODES = [
    "closed", "node_offline", "client_gone", "unknown_node", "too_many_channels", "handshake_timeout",
    "handshake_failed", "unsupported_version", "client_not_allowed", "client_removed", "node_key_changed",
    "replay", "out_of_order", "decrypt_failed", "rekey_required", "too_large", "protocol_error",
] as const;
export type ChannelCloseCode = typeof CHANNEL_CLOSE_CODES[number];

export const ERROR_CODES = [
    "invalid", "unsupported", "not_found", "exists", "conflict", "too_large", "permission_denied",
    "is_a_directory", "not_a_directory", "outside_roots", "exited", "limit", "io",
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

/**
 * What a daemon offers, in `welcome.capabilities`. Past the v1 four, each names requests or notices a client may use
 * only when listed (an older daemon answers `unsupported`, or drops a notice): `projects.edit` (`projects.add`,
 * `projects.remove`, `projects.rename`), `git.worktree` (`git.worktreeAdd`, `git.worktreeRemove`), `term.rename`, and
 * `pane.unread`.
 */
export const CAPABILITIES = ["terminal", "files", "projects", "status", "projects.edit", "git.worktree", "term.rename", "pane.unread"] as const;
export type Capability = typeof CAPABILITIES[number];

// ---------------------------------------------------------------------------------------------------------------
// 1–2. Routing frames (node ↔ server, client ↔ server)

/** A channel body as the server sees it: an object it forwards without reading. */
export type Body = Record<string, unknown>;

export interface RouteFrame { type: "frame"; channel: string; body: Body }
export interface RouteClose { type: "close"; channel: string; code: string; reason?: string }
export interface Ping { type: "ping"; at: number }
export interface Pong { type: "pong" }
export interface Limits { heartbeatSeconds: number; maxFrameBytes: number; maxChannels: number }

export interface NodeHello { type: "hello"; host: string; version: string; protocolVersions: number[]; publicKey: string }
export interface NodeWelcome { type: "welcome"; node: string; nodeName: string; serverVersion: string; limits: Limits }
export interface RouteOpen { type: "open"; channel: string; client: { session: string; userAgent?: string; ip?: string } }

export interface NodeInfo { id: string; name: string; host?: string; online: boolean; version?: string; publicKey?: string; connectedAt?: number; lastSeenAt?: number }
export interface ClientWelcome { type: "welcome"; serverVersion: string; limits: Limits }
export interface NodesFrame { type: "nodes"; items: NodeInfo[] }
export interface ClientOpen { type: "open"; ref: string; node: string }
export interface Opened { type: "opened"; ref: string; channel: string; node: string }
export interface Refused { type: "refused"; ref: string; code: "unknown_node" | "node_offline" | "too_many_channels" }

export type NodeToServer = NodeHello | RouteFrame | RouteClose | Pong;
export type ServerToNode = NodeWelcome | RouteOpen | RouteFrame | RouteClose | Ping;
export type ClientToServer = ClientOpen | RouteFrame | RouteClose | Pong;
export type ServerToClient = ClientWelcome | NodesFrame | Opened | Refused | RouteFrame | RouteClose | Ping;

// ---------------------------------------------------------------------------------------------------------------
// 3. End-to-end channel bodies

export interface Hs1 { t: "hs1"; v: number; clientKey: string; eph: string; label?: string }
export interface Hs2 { t: "hs2"; v: number; nodeKey: string; eph: string; sig: string }
export interface Hs3 { t: "hs3"; sig: string }
export interface HsError { t: "hs_error"; code: string; fingerprint?: string }
export interface Rec { t: "rec"; n: number; ct: string }
export type ChannelBody = Hs1 | Hs2 | Hs3 | HsError | Rec;

/** `clients.json` and `pending.json` on a node. */
export interface ClientKey { fingerprint: string; publicKey: string; label: string; addedAt: number }
export interface ClientsFile { version: 1; clients: ClientKey[] }
export interface PendingClient { fingerprint: string; publicKey: string; label: string; at: number }

// ---------------------------------------------------------------------------------------------------------------
// 4. Inner messages

export interface Activity {
    source: string;
    id: string;
    label: string;
    kind?: "agent" | "workflow" | "step";
    state?: "running" | "waiting";
    startedAt?: number;
    model?: string;
    progress?: { completed: number; total: number };
}
export interface PaneSession { id: string; name?: string; cwd: string; file?: string }
export type PaneState = "idle" | "busy" | "waiting";
export interface BridgeStatus {
    state: PaneState;
    activities: Activity[];
    activityCount: number;
    session?: PaneSession;
    model?: string;
    updatedAt: number;
}
export type ProgramState = "idle" | "working" | "blocked" | "done" | "error";
export interface ProgramStatus { state: ProgramState; app: string; kind?: "question" | "permission" | "auth"; message?: string; at: number }
export interface PaneView { state: PaneState; program?: ProgramStatus; bridge?: BridgeStatus; bridgeConnected: boolean; unread: boolean }

export interface Snapshot { data: string; cols: number; rows: number; outputSequence: number }
export interface TerminalInfo {
    terminalId: string;
    title: string;
    cwd: string;
    cols: number;
    rows: number;
    pid: number;
    createdAt: number;
    argv: string[];
    exited?: { code: number | null; signal: string | null };
    status?: PaneView;
    /** The name a user gave the terminal (`term.rename`); clients show it before any other. */
    label?: string;
}
export interface Stat { size: number; mtimeMs: number; hash?: string }
export interface DirEntry { name: string; kind: "file" | "dir" | "symlink" | "other"; size: number; mtimeMs: number }
/**
 * A project on the node. `name` is the user's name for it (`projects.rename`) when `named`, else its folder's name.
 * `worktree` is the main checkout's path when the project is a linked git worktree.
 */
export interface Project { name: string; path: string; repository?: string; named?: true; worktree?: string }
export type Expected = { hash: string } | { mtimeMs: number; size: number } | { absent: true };
export type Encoding = "utf8" | "base64";
/** `fs.gitShow`'s source: the commit `HEAD`, or the index (the staged content). */
export type GitRef = "HEAD" | "index";
export type Signal = "SIGTERM" | "SIGHUP" | "SIGINT" | "SIGKILL";
/**
 * One path of `git status --porcelain=v2`. `x` is the index's status against `HEAD` and `y` the working tree's against
 * the index, each one of `.` (unchanged) `M T A D R C U`; an untracked file has `?` for both.
 */
export interface GitStatusEntry {
    /** Relative to the work tree's top level, `/`-separated. */
    path: string;
    x: string;
    y: string;
    /** A rename's or copy's source, relative to the top level. */
    from?: string;
    /** Unmerged: a merge, rebase, or cherry-pick left a conflict. */
    conflict?: true;
    submodule?: true;
    /** The index's object id for the path, so a file staged again reads as a change. */
    indexHash?: string;
}
export interface GitStatus {
    /** The work tree's top level, a real path. */
    top: string;
    /** The branch checked out; absent when `HEAD` is detached. */
    branch?: string;
    entries: GitStatusEntry[];
    truncated: boolean;
}

/** Client requests that carry an `id` and get exactly one `reply`. */
export interface Requests {
    "term.create": { cols: number; rows: number; cwd?: string; argv?: string[]; env?: Record<string, string> };
    "term.list": Record<never, never>;
    "term.attach": { terminalId: string };
    "term.detach": { terminalId: string };
    "term.kill": { terminalId: string; signal?: Signal };
    "term.cwd": { terminalId: string };
    "term.rename": { terminalId: string; label: string | null };
    "projects.list": Record<never, never>;
    "projects.add": { path: string };
    "projects.remove": { path: string };
    "projects.rename": { path: string; name: string | null };
    "git.worktreeAdd": { project: string; branch: string; base?: string };
    "git.worktreeRemove": { path: string };
    "fs.readDir": { path: string };
    "fs.read": { path: string };
    "fs.write": { path: string; encoding: Encoding; data: string; expected: Expected; mode?: number };
    "fs.watch": { path: string };
    "fs.unwatch": { watch: string };
    "fs.gitShow": { path: string; ref: GitRef };
    "fs.list": { root: string; limit?: number };
    "git.status": { root: string };
    "fs.uploadStart": { name: string; size: number; dir?: string };
    "fs.uploadChunk": { upload: string; offset: number; data: string };
    "fs.uploadFinish": { upload: string; hash: string };
    "fs.uploadCancel": { upload: string };
}
export interface Results {
    "term.create": { terminal: TerminalInfo };
    "term.list": { terminals: TerminalInfo[] };
    "term.attach": { terminal: TerminalInfo; snapshot: Snapshot };
    "term.detach": Record<never, never>;
    "term.kill": Record<never, never>;
    /** The working directory of the terminal's shell now, which a `cd` changes (`TerminalInfo.cwd` is where it started). */
    "term.cwd": { cwd: string };
    "term.rename": { terminal: TerminalInfo };
    "projects.list": { projects: Project[] };
    "projects.add": { project: Project };
    /** `hidden`: the project was found on its own (a root, a terminal's repository), so the node now hides it. */
    "projects.remove": { hidden: boolean };
    "projects.rename": { project: Project };
    "git.worktreeAdd": { project: Project };
    "git.worktreeRemove": Record<never, never>;
    "fs.readDir": { entries: DirEntry[]; truncated: boolean };
    "fs.read": { encoding: Encoding; data: string; stat: Stat };
    "fs.write": { stat: Stat };
    "fs.watch": { watch: string };
    "fs.unwatch": Record<never, never>;
    "fs.gitShow": { encoding: Encoding; data: string };
    /** Paths relative to `root`, `/`-separated: git's files when `root` is in a work tree, else a walk. */
    "fs.list": { paths: string[]; truncated: boolean; source: "git" | "walk" };
    /** The status of the work tree holding `root`, which may be any directory inside it. */
    "git.status": GitStatus;
    "fs.uploadStart": { upload: string; path: string };
    "fs.uploadChunk": { received: number };
    "fs.uploadFinish": { path: string; stat: Stat };
    "fs.uploadCancel": Record<never, never>;
}
export type RequestType = keyof Requests;
export type Request<K extends RequestType = RequestType> = K extends RequestType ? { type: K; id: string } & Requests[K] : never;

/** Client messages without a reply. */
export type Notice =
    | { type: "term.input"; terminalId: string; data: string }
    | { type: "term.resize"; terminalId: string; cols: number; rows: number; claim?: boolean }
    | { type: "pane.seen"; terminalId: string }
    | { type: "pane.unread"; terminalId: string };
export type ClientMessage = Request | Notice;

export interface ReplyError { code: ErrorCode | string; message: string; current?: Stat }
export type Reply<K extends RequestType = RequestType> =
    | { type: "reply"; id: string; result: Results[K]; error?: undefined }
    | { type: "reply"; id: string; error: ReplyError; result?: undefined };

export interface Welcome {
    type: "welcome";
    node: string;
    name: string;
    host: string;
    home: string;
    version: string;
    protocolVersion: number;
    capabilities: string[];
    limits: { maxRecordBytes: number; maxSnapshotBytes: number; maxReadBytes: number; maxUploadBytes: number; maxUploadChunkBytes: number };
}
export type NodeEvent =
    | Welcome
    | { type: "error"; code: string; message: string; terminalId?: string }
    | { type: "term.created"; terminal: TerminalInfo }
    | { type: "term.removed"; terminalId: string }
    | { type: "term.output"; terminalId: string; seq: number; data: string }
    | { type: "term.snapshot"; terminalId: string; snapshot: Snapshot }
    | { type: "term.resized"; terminalId: string; cols: number; rows: number; owned: boolean }
    | { type: "term.title"; terminalId: string; title: string }
    | { type: "term.renamed"; terminalId: string; label: string | null }
    | { type: "projects.changed" }
    | { type: "term.exit"; terminalId: string; code: number | null; signal: string | null }
    | { type: "fs.changed"; watch: string; path: string; kind: "change" | "rename" | "gone" }
    | { type: "pane.status"; terminalId: string; status: PaneView | null }
    | { type: "pane.open"; terminalId: string; path: string; line?: number; column?: number }
    | { type: "pane.diff"; terminalId: string; path: string; staged: boolean };
export type NodeMessage = Reply | NodeEvent;

// ---------------------------------------------------------------------------------------------------------------
// 5–6. Bridge socket (NDJSON) and `pika-node attach`

export const SOCKET_ENV = "PIKA_NODE_SOCKET";
export const PANE_ENV = "PIKA_NODE_PANE_ID";
export const PROGRAM_STATUS_ENV = "PI_PROGRAM_STATUS";

export type SocketHello =
    | { type: "hello"; role: "bridge"; paneId: string; pid: number; version: string; protocolVersion: number }
    | { type: "hello"; role: "client"; version: string; protocolVersion: number };
export type BridgeMessage =
    | SocketHello
    | { type: "status"; status: BridgeStatus }
    | { type: "open"; id: string; path: string; line?: number; column?: number }
    | { type: "diff"; id: string; path: string; staged?: boolean };
export type DaemonToBridge =
    | { type: "welcome"; version: string; protocolVersion: number }
    | { type: "reply"; id: string; result: { delivered: number }; error?: undefined }
    | { type: "reply"; id: string; error: { code: string; message?: string }; result?: undefined };

// ---------------------------------------------------------------------------------------------------------------
// Field checks

type Check = (value: unknown) => boolean;
/** Field name → check; a name starting with `?` is optional. */
type Spec = Record<string, Check>;
type Refine = (message: Record<string, unknown>) => boolean;

/** An own data property, never an accessor. */
export function data(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** UTF-8 length of a string without encoding it; lone surrogates count as U+FFFD (3 bytes). */
export function utf8Length(text: string): number {
    let length = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) length += 1;
        else if (code < 0x800) length += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { length += 4; i++; }
        else length += 3;
    }
    return length;
}

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SOURCE = /^[A-Za-z0-9_.-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;

const str = (maxBytes: number): Check => value => typeof value === "string" && (value.length <= maxBytes / 3 || utf8Length(value) <= maxBytes);
/** Nonblank single-line text of at most `max` UTF-16 units. */
const label = (max: number): Check => value => typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);
const id: Check = value => typeof value === "string" && ID.test(value);
const requestId: Check = value => typeof value === "string" && REQUEST_ID.test(value);
const int = (min: number, max = Number.MAX_SAFE_INTEGER): Check => value => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const time = int(0);
const bool: Check = value => typeof value === "boolean";
const literal = (...values: unknown[]): Check => value => values.includes(value);
const nullable = (check: Check): Check => value => value === null || check(value);
const hex64: Check = value => typeof value === "string" && HEX64.test(value);
export const isAbsolutePath: Check = value => typeof value === "string" && value.startsWith("/") && !value.includes("\0") && str(LIMITS.maxPathBytes)(value);
/** A file name: no slash, not `.` or `..`. */
const baseName: Check = value => label(255)(value) && !(value as string).includes("/") && value !== "." && value !== "..";
/** Unpadded base64url whose decoded length lies in [min, max] bytes. */
const b64url = (min: number, max: number): Check => value => {
    if (typeof value !== "string" || value.length % 4 === 1 || !B64URL.test(value)) return false;
    const bytes = Math.floor(value.length * 3 / 4);
    return bytes >= min && bytes <= max;
};
const arrayOf = (check: Check, max: number, min = 0): Check => value => Array.isArray(value) && value.length >= min && value.length <= max && value.every(item => check(item));
const object = (spec: Spec, refine?: Refine): Check => value => {
    const parsed = fields(spec, value);
    return parsed !== undefined && (!refine || refine(parsed));
};
const anyObject: Check = isRecord;

/** Copies the fields of `spec` from `value`, dropping unknown ones; undefined when any is missing or invalid. */
function fields(spec: Spec, value: unknown, into: Record<string, unknown> = {}): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    for (const key of Object.keys(spec)) {
        const optional = key.startsWith("?");
        const name = optional ? key.slice(1) : key;
        const field = data(value, name);
        if (field === undefined) {
            if (optional) continue;
            return undefined;
        }
        if (!spec[key]!(field)) return undefined;
        into[name] = field;
    }
    return into;
}

/** A frame of a known type, an unknown type (ignored), or an invalid known one; `id` lets a node answer a request. */
export type Parsed<T> =
    | { ok: true; message: T }
    | { ok: false; reason: "unknown" | "invalid"; type?: string; id?: string };

function parser<T>(specs: Record<string, Spec>, tag = "type", refines: Record<string, Refine> = {}): (value: unknown) => Parsed<T> {
    return value => {
        const type = data(value, tag);
        const rawId = data(value, "id");
        const id = typeof rawId === "string" && REQUEST_ID.test(rawId) ? rawId : undefined;
        if (typeof type !== "string" || !Object.hasOwn(specs, type)) {
            return { ok: false, reason: "unknown", ...(typeof type === "string" ? { type } : {}), ...(id ? { id } : {}) };
        }
        const message = fields(specs[type]!, value, { [tag]: type });
        if (!message || (Object.hasOwn(refines, type) && !refines[type]!(message))) return { ok: false, reason: "invalid", type, ...(id ? { id } : {}) };
        return { ok: true, message: message as T };
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Specs

const channel = id;
const limits = object({ heartbeatSeconds: int(1), maxFrameBytes: int(1), maxChannels: int(1) });
const routeFrame: Spec = { channel, body: anyObject };
const routeClose: Spec = { channel, code: label(64), "?reason": label(200) };
const spki = b64url(64, 200);

const nodeInfo = object({
    id, name: label(64), "?host": label(255), online: bool, "?version": label(64), "?publicKey": spki,
    "?connectedAt": time, "?lastSeenAt": time,
});

export const parseNodeToServer = parser<NodeToServer>({
    hello: { host: label(255), version: label(64), protocolVersions: arrayOf(int(1), 16, 1), publicKey: spki },
    frame: routeFrame,
    close: routeClose,
    pong: {},
});
export const parseServerToNode = parser<ServerToNode>({
    welcome: { node: id, nodeName: label(64), serverVersion: label(64), limits },
    open: { channel, client: object({ session: label(64), "?userAgent": label(512), "?ip": label(64) }) },
    frame: routeFrame,
    close: routeClose,
    ping: { at: time },
});
export const parseClientToServer = parser<ClientToServer>({
    open: { ref: requestId, node: id },
    frame: routeFrame,
    close: routeClose,
    pong: {},
});
export const parseServerToClient = parser<ServerToClient>({
    welcome: { serverVersion: label(64), limits },
    nodes: { items: arrayOf(nodeInfo, 1_000) },
    opened: { ref: requestId, channel, node: id },
    refused: { ref: requestId, code: literal("unknown_node", "node_offline", "too_many_channels") },
    frame: routeFrame,
    close: routeClose,
    ping: { at: time },
});

const P256_RAW = 65;
const SIGNATURE = 64;
export const parseChannelBody = parser<ChannelBody>({
    hs1: { v: int(1), clientKey: spki, eph: b64url(P256_RAW, P256_RAW), "?label": label(64) },
    hs2: { v: int(1), nodeKey: spki, eph: b64url(P256_RAW, P256_RAW), sig: b64url(SIGNATURE, SIGNATURE) },
    hs3: { sig: b64url(SIGNATURE, SIGNATURE) },
    hs_error: { code: label(64), "?fingerprint": hex64 },
    // The ciphertext is the plaintext plus a 16-byte tag.
    rec: { n: int(0, LIMITS.maxRecords - 1), ct: b64url(16, LIMITS.maxRecordBytes + 16) },
}, "t");

const activity = object({
    source: value => typeof value === "string" && SOURCE.test(value),
    id: label(160),
    label: label(240),
    "?kind": literal("agent", "workflow", "step"),
    "?state": literal("running", "waiting"),
    "?startedAt": time,
    "?model": label(240),
    "?progress": object({ completed: int(0), total: int(1) }, progress => (progress.completed as number) <= (progress.total as number)),
});
const paneSession = object({ id: label(160), "?name": label(240), cwd: isAbsolutePath, "?file": isAbsolutePath });
const uniqueActivities = (status: Record<string, unknown>): boolean => {
    const rows = status.activities as Activity[];
    const keys = new Set(rows.map(row => `${row.source}:${row.id}`));
    return keys.size === rows.length && (status.activityCount as number) >= rows.length;
};
const bridgeStatusSpec: Spec = {
    state: literal("idle", "busy", "waiting"),
    activities: arrayOf(activity, LIMITS.maxActivities),
    activityCount: int(0, LIMITS.maxActivityCount),
    "?session": paneSession,
    "?model": label(240),
    updatedAt: time,
};
export const isBridgeStatus: Check = object(bridgeStatusSpec, uniqueActivities);
const programStatus = object({
    state: literal("idle", "working", "blocked", "done", "error"),
    app: label(64),
    "?kind": literal("question", "permission", "auth"),
    "?message": label(240),
    at: time,
});
const paneView = object({ state: literal("idle", "busy", "waiting"), "?program": programStatus, "?bridge": isBridgeStatus, bridgeConnected: bool, unread: bool });

const terminalId = id;
/** The longest name a user may give a terminal or a project, in UTF-16 units. */
export const TERMINAL_LABEL = 120;
export const PROJECT_NAME = 120;
const cols = int(1, LIMITS.maxCols);
const rows = int(1, LIMITS.maxRows);
const env: Check = value => isRecord(value) && Object.keys(value).length <= LIMITS.maxEnv
    && Object.keys(value).every(key => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && str(32 * KiB)(data(value, key)) && !String(data(value, key)).includes("\0"));
const expected: Check = value => fields({ hash: hex64 }, value) !== undefined
    || fields({ mtimeMs: time, size: time }, value) !== undefined
    || data(value, "absent") === true;
const writeData = (message: Record<string, unknown>): boolean => message.encoding === "utf8"
    ? utf8Length(message.data as string) <= LIMITS.maxReadBytes
    : b64url(0, LIMITS.maxReadBytes)(message.data);

export const parseClientMessage = parser<ClientMessage>({
    "term.create": { id: requestId, cols, rows, "?cwd": isAbsolutePath, "?argv": arrayOf(label(4_096), LIMITS.maxArgv, 1), "?env": env },
    "term.list": { id: requestId },
    "term.attach": { id: requestId, terminalId },
    "term.detach": { id: requestId, terminalId },
    "term.kill": { id: requestId, terminalId, "?signal": literal("SIGTERM", "SIGHUP", "SIGINT", "SIGKILL") },
    "term.cwd": { id: requestId, terminalId },
    "term.input": { terminalId, data: str(LIMITS.maxInputBytes) },
    "term.resize": { terminalId, cols, rows, "?claim": bool },
    "pane.seen": { terminalId },
    "pane.unread": { terminalId },
    "term.rename": { id: requestId, terminalId, label: nullable(label(TERMINAL_LABEL)) },
    "projects.list": { id: requestId },
    "projects.add": { id: requestId, path: isAbsolutePath },
    "projects.remove": { id: requestId, path: isAbsolutePath },
    "projects.rename": { id: requestId, path: isAbsolutePath, name: nullable(label(PROJECT_NAME)) },
    "git.worktreeAdd": { id: requestId, project: isAbsolutePath, branch: label(255), "?base": label(255) },
    "git.worktreeRemove": { id: requestId, path: isAbsolutePath },
    "fs.readDir": { id: requestId, path: isAbsolutePath },
    "fs.read": { id: requestId, path: isAbsolutePath },
    "fs.write": { id: requestId, path: isAbsolutePath, encoding: literal("utf8", "base64"), data: value => typeof value === "string", expected, "?mode": int(0, 0o7777) },
    "fs.watch": { id: requestId, path: isAbsolutePath },
    "fs.unwatch": { id: requestId, watch: id },
    "fs.gitShow": { id: requestId, path: isAbsolutePath, ref: literal("HEAD", "index") },
    "fs.list": { id: requestId, root: isAbsolutePath, "?limit": int(1, LIMITS.maxListEntries) },
    "git.status": { id: requestId, root: isAbsolutePath },
    "fs.uploadStart": { id: requestId, name: baseName, size: int(0, LIMITS.maxUploadBytes), "?dir": isAbsolutePath },
    "fs.uploadChunk": { id: requestId, upload: id, offset: int(0, LIMITS.maxUploadBytes), data: b64url(1, LIMITS.maxUploadChunkBytes) },
    "fs.uploadFinish": { id: requestId, upload: id, hash: hex64 },
    "fs.uploadCancel": { id: requestId, upload: id },
}, "type", { "fs.write": writeData });

const snapshot = object({ data: str(LIMITS.maxSnapshotBytes), cols, rows, outputSequence: int(0) });
const terminalInfo = object({
    terminalId, title: str(4 * KiB), cwd: isAbsolutePath, cols, rows, pid: int(0), createdAt: time,
    argv: arrayOf(value => typeof value === "string", LIMITS.maxArgv + 2, 1),
    "?exited": object({ code: nullable(int(-(2 ** 31), 2 ** 31)), signal: nullable(label(32)) }),
    "?status": paneView,
    "?label": label(TERMINAL_LABEL),
});
const replyError = object({ code: label(64), message: str(4 * KiB), "?current": object({ size: time, mtimeMs: time, "?hash": hex64 }) });

/** Validates node messages; `reply.result` is checked only for being an object, its shape is the request's. */
export const parseNodeMessage = parser<NodeMessage>({
    reply: { id: requestId, "?result": anyObject, "?error": replyError },
    welcome: {
        node: id, name: label(64), host: label(255), home: isAbsolutePath, version: label(64), protocolVersion: int(1),
        capabilities: arrayOf(label(64), 64),
        limits: object({ maxRecordBytes: int(1), maxSnapshotBytes: int(1), maxReadBytes: int(1), maxUploadBytes: int(1), maxUploadChunkBytes: int(1) }),
    },
    error: { code: label(64), message: str(4 * KiB), "?terminalId": terminalId },
    "term.created": { terminal: terminalInfo },
    "term.removed": { terminalId },
    "term.output": { terminalId, seq: int(1), data: str(LIMITS.maxOutputChunkBytes) },
    "term.snapshot": { terminalId, snapshot },
    "term.resized": { terminalId, cols, rows, owned: bool },
    "term.title": { terminalId, title: str(4 * KiB) },
    "term.renamed": { terminalId, label: nullable(label(TERMINAL_LABEL)) },
    "projects.changed": {},
    "term.exit": { terminalId, code: nullable(int(-(2 ** 31), 2 ** 31)), signal: nullable(label(32)) },
    "fs.changed": { watch: id, path: isAbsolutePath, kind: literal("change", "rename", "gone") },
    "pane.status": { terminalId, status: nullable(paneView) },
    "pane.open": { terminalId, path: isAbsolutePath, "?line": int(1), "?column": int(1) },
    "pane.diff": { terminalId, path: isAbsolutePath, staged: bool },
}, "type", { reply: message => (message.result === undefined) !== (message.error === undefined) });

export const parseBridgeMessage = parser<BridgeMessage>({
    hello: { role: literal("bridge", "client"), "?paneId": id, "?pid": int(1), version: label(64), protocolVersion: int(1) },
    status: { status: isBridgeStatus },
    open: { id: requestId, path: isAbsolutePath, "?line": int(1), "?column": int(1) },
    diff: { id: requestId, path: isAbsolutePath, "?staged": bool },
}, "type", { hello: message => message.role === "client" || (message.paneId !== undefined && message.pid !== undefined) });

export const parseDaemonToBridge = parser<DaemonToBridge>({
    welcome: { version: label(64), protocolVersion: int(1) },
    reply: { id: requestId, "?result": object({ delivered: int(0) }), "?error": object({ code: label(64), "?message": str(4 * KiB) }) },
}, "type", { reply: message => (message.result === undefined) !== (message.error === undefined) });

// ---------------------------------------------------------------------------------------------------------------
// Pane status

const PROGRAM_STATES = new Set(["idle", "working", "blocked", "done", "error", "clear"]);
const PROGRAM_KINDS = new Set(["question", "permission", "auth"]);

/**
 * The payload of an OSC 7501 sequence after `7501;`, e.g. `state=blocked:app=pi:kind=question:msg=<base64>`.
 * `clear` drops the program status; undefined means the payload is not a status (the `?` query, or malformed).
 */
export function parseProgramStatus(payload: string, at: number): ProgramStatus | "clear" | undefined {
    if (payload.length > 4 * KiB) return undefined;
    const pairs = new Map<string, string>();
    for (const part of payload.split(":")) {
        const eq = part.indexOf("=");
        if (eq <= 0) return undefined;
        const key = part.slice(0, eq);
        if (pairs.has(key)) return undefined;
        pairs.set(key, part.slice(eq + 1));
    }
    const state = pairs.get("state");
    const app = pairs.get("app");
    if (!state || !PROGRAM_STATES.has(state) || !app || !label(64)(app)) return undefined;
    if (state === "clear") return "clear";
    const status: ProgramStatus = { state: state as ProgramState, app, at };
    const kind = pairs.get("kind");
    if (kind !== undefined && PROGRAM_KINDS.has(kind)) status.kind = kind as ProgramStatus["kind"];
    const msg = pairs.get("msg");
    if (msg !== undefined) {
        const message = decodeBase64Text(msg);
        const clean = message === undefined ? "" : sanitize(message).replace(/\s+/g, " ").trim().slice(0, 240);
        if (clean) status.message = clean;
    }
    return status;
}

/** The merged pane state (NODE.md, "Pane status"): program status first, bridge activities keep it busy, waiting wins. */
export function mergeState(program: ProgramStatus | undefined, bridge: BridgeStatus | undefined): PaneState {
    const root: PaneState = program
        ? program.state === "blocked" ? "waiting" : program.state === "working" ? "busy" : "idle"
        : bridge?.state ?? "idle";
    if (root === "waiting" || bridge?.state === "waiting" || bridge?.activities.some(row => row.state === "waiting")) return "waiting";
    if (root === "busy" || (bridge?.activityCount ?? 0) > 0) return "busy";
    return "idle";
}

/** Whether a state change sets the daemon's unread ("done") flag. */
export const becameDone = (previous: PaneState, next: PaneState): boolean => previous !== "idle" && next === "idle";

// ---------------------------------------------------------------------------------------------------------------
// Encoding helpers

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

/** Unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
    let out = "";
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
    }
    if (i + 1 === bytes.length) {
        const n = bytes[i]! << 16;
        out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]!;
    } else if (i + 2 === bytes.length) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
        out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
    }
    return out;
}

/** Decodes unpadded base64url; undefined for any other alphabet, padding, a bad length, or non-zero trailing bits. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
    return decode64(text, DECODE);
}

const DECODE_STD = new Int16Array(128).fill(-1);
for (let i = 0; i < 62; i++) DECODE_STD[ALPHABET.charCodeAt(i)] = i;
DECODE_STD["+".charCodeAt(0)] = 62;
DECODE_STD["/".charCodeAt(0)] = 63;

function decode64(text: string, table: Int16Array): Uint8Array<ArrayBuffer> | undefined {
    if (text.length % 4 === 1) return undefined;
    const out = new Uint8Array(Math.floor(text.length * 3 / 4));
    let bits = 0;
    let value = 0;
    let o = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const digit = code < 128 ? table[code]! : -1;
        if (digit < 0) return undefined;
        value = (value << 6) | digit;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (value >> bits) & 0xff;
        }
    }
    if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return undefined;
    return out;
}

/** Standard or URL-safe base64, padded or not, as UTF-8 text (OSC 7501 `msg`); undefined when malformed. */
function decodeBase64Text(text: string): string | undefined {
    const bytes = decode64(text.replace(/=+$/, ""), text.includes("-") || text.includes("_") ? DECODE : DECODE_STD);
    if (!bytes) return undefined;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------------------------
// Fingerprints

/** `ab12 cd34 …`: the first 32 hex characters of a fingerprint in groups of 4. */
export const displayFingerprint = (fingerprint: string): string => fingerprint.slice(0, 32).match(/.{1,4}/g)?.join(" ") ?? "";

/** The fingerprints that start with `prefix` (spaces and case ignored); none when the prefix is shorter than the minimum. */
export function matchFingerprint(prefix: string, fingerprints: readonly string[]): string[] {
    const normalized = prefix.replace(/\s+/g, "").toLowerCase();
    if (normalized.length < LIMITS.minFingerprintPrefix || !/^[0-9a-f]+$/.test(normalized)) return [];
    return fingerprints.filter(fingerprint => fingerprint.startsWith(normalized));
}

// ---------------------------------------------------------------------------------------------------------------
// NDJSON

export class LineTooLong extends Error {}

/** Splits a UTF-8 text stream into lines; throws `LineTooLong` when a line passes `maxBytes`. */
export class LineDecoder {
    #pending = "";
    #maxBytes: number;
    constructor(maxBytes: number = LIMITS.maxBridgeLineBytes) { this.#maxBytes = maxBytes; }
    push(chunk: string): string[] {
        const parts = (this.#pending + chunk).split("\n");
        this.#pending = parts.pop()!;
        if (utf8Length(this.#pending) > this.#maxBytes) throw new LineTooLong(`line over ${this.#maxBytes} bytes`);
        for (const line of parts) if (utf8Length(line) > this.#maxBytes) throw new LineTooLong(`line over ${this.#maxBytes} bytes`);
        return parts.filter(line => line.trim().length > 0);
    }
}

/** One NDJSON line; JSON.stringify escapes every newline inside strings. */
export const encodeLine = (message: unknown): string => `${JSON.stringify(message)}\n`;

/** Parses JSON without throwing. */
export function parseJson(text: string): unknown {
    try { return JSON.parse(text) as unknown; }
    catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------------------------
// Untrusted text (the same rules as relay's `sanitize`)

const SEQUENCES = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x80-\x9f]*(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]?/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Text without terminal sequences or control characters other than newline and tab. */
export const sanitize = (text: unknown): string => typeof text === "string" ? text.replace(SEQUENCES, "").replace(CONTROLS, "") : "";
