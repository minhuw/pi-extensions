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
	device: string;
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

export interface Page<T> {
	items: T[];
	nextCursor?: string | null;
}

export interface Facets {
	devices: string[];
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

/**
 * `GET sessions/:id/updates?since=<seq>`: the session's summary and every turn that holds an entry
 * after `since` (the turn that grew and any new ones). Not in spec v1; the UI falls back when absent.
 */
export interface SessionUpdates {
	lastSeq: number;
	session: SessionSummary;
	turns: Turn[];
}

export interface Me {
	authenticated: boolean;
	passwordRequired: boolean;
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
