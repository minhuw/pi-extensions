// Read API shapes from the pika spec (`{base}/api/v1/`).

export interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface HerderLink {
	runId: string;
	stepKey: string;
	stepId: string;
	task?: string;
	role: string;
	attempt: number;
	launch: number;
	repo?: string;
}

export interface SessionLink {
	kind: "subagent" | "herder-step" | (string & {});
	parentSessionId?: string;
	parentSessionFile?: string;
	parentToolCallId?: string;
	agentId?: string;
	parentAgentId?: string;
	workflowId?: string;
	agentType?: string;
	description?: string;
	herder?: HerderLink;
}

export interface SessionSummary {
	id: string;
	/** The device id. */
	device: string;
	/** The device's display name; missing from servers older than 0.4, so show the id instead. */
	deviceName?: string;
	project: string;
	cwd: string;
	title: string;
	startedAt: string;
	lastAt: string;
	durationMs: number;
	entryCount: number;
	models: string[];
	tokens: Tokens;
	cost: number;
	parentSessionId?: string;
	link?: SessionLink;
	childCount: number;
	herderRunId?: string;
}

export type ChildSession = SessionSummary & { parentToolCallId?: string };

export interface SessionDetail extends SessionSummary {
	children: ChildSession[];
}

/** A session in its family tree, `depth` hops below the root. */
export type TreeNode = ChildSession & { depth: number };

/** `GET sessions/:id/tree`: the root and its descendants, depth-first in pre-order. */
export interface SessionTree {
	rootId: string;
	nodes: TreeNode[];
	/** Set when the server left sessions out at its node or depth limit. */
	truncated?: boolean;
}

export interface Page<T> {
	items: T[];
	nextCursor?: string | null;
}

/** A device as filters list it: the id is the filter value, the name its label. */
export interface DeviceRef {
	id: string;
	name: string;
}

export interface Facets {
	devices: DeviceRef[];
	projects: string[];
	models: string[];
}

export interface Turn {
	index: number;
	startSeq: number;
	endSeq: number;
	userText: string;
	at: string;
	durationMs: number;
	modelCalls: number;
	toolCalls: number;
	toolErrors: number;
	cost: number;
	tokens: Tokens;
	finalText: string;
	/** The `customType` of the `custom_message` that started the turn, such as `relay-message`; absent for user prompts. */
	customType?: string;
}

export interface Entry {
	seq: number;
	offset: number;
	id: string | null;
	parentId: string | null;
	type: string;
	timestamp: string | null;
	raw: RawEntry;
	requestId?: string;
	truncated?: boolean;
}

export interface ModelRequest {
	id: string;
	sessionId: string;
	fidelity: "payload" | "context";
	provider?: string;
	api?: string;
	model?: string;
	at: string;
	complete: boolean;
	payload: unknown;
}

export interface RunSummary {
	runId: string;
	device: string;
	deviceName?: string;
	repo: string;
	title: string;
	status: string;
	verdict?: string;
	startedAt: string;
	lastAt: string;
	stepCount: number;
}

export interface RunEvent {
	seq: number;
	t: string;
	at: string;
	/** The journal event; field names follow Herder's journal. */
	data: unknown;
}

export interface RunStep {
	key: string;
	id: string;
	task?: string;
	role: string;
	label?: string;
	phase?: string;
	status: string;
	attempts: number;
	sessionId?: string;
	commit?: string;
	startedAt?: string;
	endedAt?: string;
}

export interface RunDetail {
	run: RunSummary;
	goal?: string;
	plan?: string;
	events: RunEvent[];
	steps: RunStep[];
}

export interface SearchHit {
	sessionId: string;
	sessionTitle: string;
	seq: number;
	entryId: string | null;
	kind: "user" | "assistant" | "tool-call" | "tool-result" | "title";
	snippet: string;
	at: string;
}

/** A turn as `GET sessions/:id/trace` lists it; times are epoch milliseconds, omitted when unknown. */
export interface TraceTurn {
	index: number;
	startSeq: number;
	endSeq: number;
	at?: number;
	durationMs: number;
	userText: string;
	customType?: string;
	modelCalls: number;
	toolCalls: number;
	toolErrors: number;
	cost: number;
	tokens: Tokens;
}

/** A model call: `start` is the assistant message's timestamp, `end` its entry's. */
export interface TraceLlmRecord {
	kind: "llm";
	seq: number;
	turn?: number;
	start?: number;
	end?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	error?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	requestId?: string;
	/** The first ≤160 characters of the assistant's text. */
	text?: string;
	thinking?: boolean;
	toolCalls?: number;
}

/** A tool call; `seq` is the assistant entry that made it and `resultSeq` its result's. */
export interface TraceToolRecord {
	kind: "tool";
	seq: number;
	resultSeq?: number;
	turn?: number;
	callId: string;
	/** Omitted when the call was not recorded; `toolName` reads it. */
	name?: string;
	start?: number;
	end?: number;
	durationMs?: number;
	isError: boolean;
	/** Computed from the arguments: a command's first line, a path, a pattern, a URL, … */
	summary?: string;
	outputSize?: number;
	childSessionId?: string;
}

export interface TraceCompactionRecord {
	kind: "compaction";
	seq: number;
	turn?: number;
	at?: number;
	tokensBefore?: number;
}

export interface TraceBranchSummaryRecord {
	kind: "branch-summary";
	seq: number;
	turn?: number;
	at?: number;
}

export type TraceRecord = TraceLlmRecord | TraceToolRecord | TraceCompactionRecord | TraceBranchSummaryRecord;

export interface TraceChild {
	sessionId: string;
	parentToolCallId?: string;
	agentType?: string;
	description?: string;
	kind: "subagent" | "herder-step" | (string & {});
	/** Both omitted while the child has no entries, as a subagent that just started. */
	startedAt?: number;
	lastAt?: number;
	entryCount: number;
	tokens: Tokens;
	cost: number;
	title: string;
}

/**
 * `GET sessions/:id/trace`: the session's shape without its raw entries. Records are sorted by `seq`. The server
 * omits what it does not know, never inventing it: the bounds of a session without entries, a turn's or record's
 * times, a tool's name.
 */
export interface SessionTrace {
	sessionId: string;
	startedAt?: number;
	lastAt?: number;
	turns: TraceTurn[];
	records: TraceRecord[];
	children: TraceChild[];
}

/**
 * `GET sessions/:id/updates?since=<seq>`. `session`, `turns`, and `truncated` are present only when
 * `lastSeq > since`; `turns` holds every turn with `endSeq > since` (at most 50, ascending), and
 * `truncated` is set when more qualified.
 */
export interface SessionUpdates {
	lastSeq: number;
	lastAt?: string | null;
	session?: SessionSummary;
	turns?: Turn[];
	truncated?: boolean;
}

export type AuthMode = "password" | "proxy" | "none";

export interface Me {
	authenticated: boolean;
	passwordRequired: boolean;
	/** Missing from servers older than 0.2. */
	authMode?: AuthMode;
}

/** A signed-in browser, from `GET auth/sessions`. `id` is the first 12 hex characters of the id hash. */
export interface BrowserSession {
	id: string;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
	userAgent?: string;
	ip?: string;
	current: boolean;
}

/** A device with a token, from `GET devices`. `createdAt` and `createdVia` describe its token. */
export interface Device {
	/** Identity; never changes. Legacy devices use their old name. */
	id: string;
	/** Display label; need not be unique. */
	name: string;
	createdAt: string;
	createdVia: "cli" | "pairing" | (string & {});
	lastSeenAt?: string | null;
	lastHost?: string | null;
	/** Whether a device key recognizes the machine when it pairs again. */
	hasKey: boolean;
}

/** The device a pending pairing was recognized as when it started. */
export interface PairingMatch {
	id: string;
	name: string;
	by: "token" | "key";
	/** Whether that device has a token, which approving stops. */
	active: boolean;
}

/** A pending pairing request, from `GET pairings`. */
export interface Pairing {
	code: string;
	/** The requested device name. */
	name: string;
	host?: string | null;
	ip?: string | null;
	pikaVersion?: string | null;
	requestedAt: string;
	expiresAt: string;
	match?: PairingMatch;
}

/** `POST pairings/:code/approve`. */
export interface PairingApproval {
	/** The id the token will belong to. */
	device: string;
	name: string;
	continued: boolean;
}

/** `GET {base}/api/health`. `features` is missing from servers older than 0.3. */
export interface Health {
	ok: boolean;
	version: string;
	basePath: string;
	features?: string[];
	/** The commit the server was built from, 7 hex digits; missing when its build did not record one, as up to 0.3.0. */
	revision?: string;
}

// Relay shapes (docs/RELAY.md).

export type RelaySessionState = "idle" | "busy";

/** A pi session holding an open relay connection, from `GET relay/sessions`. */
export interface OnlineSession {
	id: string;
	device: string;
	deviceName?: string;
	host: string;
	name?: string;
	title?: string;
	cwd: string;
	project: string;
	model?: string;
	state: RelaySessionState;
	piVersion?: string;
	connectedAt: string;
	stateSince: string;
	lastSeenAt: string;
	/** Whether pika has the session's transcript. */
	recorded: boolean;
}

export type RelaySender =
	| { kind: "session"; sessionId: string; device: string; deviceName?: string; name?: string; title?: string; project?: string }
	| { kind: "web" };

export interface RelayTarget {
	sessionId: string;
	device?: string;
	deviceName?: string;
	name?: string;
	title?: string;
	project?: string;
}

export type RelayStatus = "queued" | "delivered" | "expired" | "rejected";

/** Why the server refused a message; `self` and `hop_limit` come only from sessions. */
export type RelayRejection =
	| "invalid"
	| "self"
	| "too_large"
	| "rate_limited"
	| "hop_limit"
	| "unknown_session"
	| "mailbox_full"
	| (string & {});

/** One message on the dashboard, from `GET relay/events`, updated in place as its status changes. */
export interface RelayEvent {
	id: string;
	at: string;
	from: RelaySender;
	to: RelayTarget;
	status: RelayStatus;
	reason?: RelayRejection;
	deliveredAt?: string;
	urgent: boolean;
	replyTo?: string;
	hops: number;
	text: string;
}

/** `POST relay/messages` when the server accepted the message. */
export interface RelaySendResult {
	id: string;
	status: "delivered" | "queued";
	to: RelayTarget;
}

// pi session entry and message shapes (session-format.md, message-types.md).

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
	src?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type ContentBlock = TextContent | ImageContent | ThinkingContent | ToolCall;

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	cost?: { total?: number };
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: ContentBlock[];
	api?: string;
	provider?: string;
	model?: string;
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string;
	thinkingLevel?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
}

export interface OtherMessage {
	role: string;
	[key: string]: unknown;
}

export type AgentMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| BashExecutionMessage
	| OtherMessage;

export interface RawEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	[key: string]: unknown;
}
