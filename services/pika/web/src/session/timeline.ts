import type {
	AssistantMessage,
	BashExecutionMessage,
	ContentBlock,
	Entry,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../lib/types";

interface Base {
	key: string;
	seq: number;
	entry: Entry;
	/** Hidden unless the "show hidden" toggle is on. */
	hidden?: boolean;
}

export type TimelineItem = Base &
	(
		| { kind: "model-call"; message: AssistantMessage }
		| { kind: "text"; text: string }
		| { kind: "thinking"; text: string; redacted: boolean }
		| { kind: "tool"; call: ToolCall; result?: ToolResultMessage; resultEntry?: Entry }
		| { kind: "tool-result"; message: ToolResultMessage }
		| { kind: "assistant-error"; message: AssistantMessage }
		| { kind: "user"; content: string | (TextContent | ImageContent)[] }
		| { kind: "bash-execution"; message: BashExecutionMessage }
		| { kind: "note"; icon: "model" | "sparkle" | "tag" | "pencil" | "info"; text: string }
		| { kind: "compaction"; summary: string; tokensBefore?: number }
		| { kind: "branch-summary"; summary: string }
		| { kind: "custom-message"; customType: string; content: unknown }
		| { kind: "raw"; label: string }
	);

export type TimelineKind = TimelineItem["kind"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is TextContent => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

export function contentImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is ImageContent => isRecord(block) && block.type === "image");
}

/**
 * Builds the timeline for one turn. `promptSeq` is the turn's prompt entry, which the card shows
 * already. Tool results are paired with their calls by `toolCallId`.
 */
export function buildTimeline(entries: Entry[], promptSeq?: number): TimelineItem[] {
	const results = new Map<string, Entry>();
	for (const entry of entries) {
		const message = entry.raw.message;
		if (entry.type === "message" && isRecord(message) && message.role === "toolResult") {
			const id = str(message.toolCallId);
			if (id) results.set(id, entry);
		}
	}
	const paired = new Set<string>();
	const items: TimelineItem[] = [];

	for (const entry of entries) {
		const raw = entry.raw;
		const seq = entry.seq;
		const key = `${seq}`;
		switch (entry.type) {
			case "session":
				break;
			case "message": {
				const message = raw.message;
				if (!isRecord(message)) {
					items.push({ kind: "raw", key, seq, entry, label: "message", hidden: true });
					break;
				}
				const role = str(message.role);
				if (role === "user") {
					if (seq === promptSeq) break;
					items.push({ kind: "user", key, seq, entry, content: message.content as string | (TextContent | ImageContent)[] });
				} else if (role === "assistant") {
					const assistant = message as unknown as AssistantMessage;
					items.push({ kind: "model-call", key: `${seq}:call`, seq, entry, message: assistant });
					const blocks: ContentBlock[] = Array.isArray(assistant.content) ? assistant.content : [];
					blocks.forEach((block, index) => {
						const blockKey = `${seq}:${index}`;
						if (!isRecord(block)) return;
						if (block.type === "text") {
							if (block.text.trim()) items.push({ kind: "text", key: blockKey, seq, entry, text: block.text });
						} else if (block.type === "thinking") {
							items.push({
								kind: "thinking",
								key: blockKey,
								seq,
								entry,
								text: block.thinking ?? "",
								redacted: block.redacted === true,
							});
						} else if (block.type === "toolCall") {
							const resultEntry = results.get(block.id);
							if (resultEntry) paired.add(block.id);
							items.push({
								kind: "tool",
								key: blockKey,
								seq,
								entry,
								call: block,
								result: resultEntry?.raw.message as ToolResultMessage | undefined,
								resultEntry,
							});
						}
					});
					if (assistant.stopReason === "error" || assistant.stopReason === "aborted" || assistant.errorMessage) {
						items.push({ kind: "assistant-error", key: `${seq}:error`, seq, entry, message: assistant });
					}
				} else if (role === "toolResult") {
					const result = message as unknown as ToolResultMessage;
					if (!paired.has(result.toolCallId)) items.push({ kind: "tool-result", key, seq, entry, message: result });
				} else if (role === "bashExecution") {
					items.push({ kind: "bash-execution", key, seq, entry, message: message as unknown as BashExecutionMessage });
				} else if (role === "custom") {
					items.push({
						kind: "custom-message",
						key,
						seq,
						entry,
						customType: str(message.customType) ?? "custom",
						content: message.content,
						hidden: message.display === false,
					});
				} else if (role === "compactionSummary") {
					items.push({ kind: "compaction", key, seq, entry, summary: str(message.summary) ?? "" });
				} else if (role === "branchSummary") {
					items.push({ kind: "branch-summary", key, seq, entry, summary: str(message.summary) ?? "" });
				} else if (role === "system") {
					items.push({ kind: "raw", key, seq, entry, label: "System prompt update", hidden: true });
				} else {
					items.push({ kind: "raw", key, seq, entry, label: `${role ?? "unknown"} message`, hidden: true });
				}
				break;
			}
			case "model_change":
				items.push({
					kind: "note",
					key,
					seq,
					entry,
					icon: "model",
					text: `Switched model to ${[str(raw.provider), str(raw.modelId)].filter(Boolean).join("/")}`,
				});
				break;
			case "thinking_level_change":
				items.push({ kind: "note", key, seq, entry, icon: "sparkle", text: `Thinking level set to ${str(raw.thinkingLevel) ?? "default"}` });
				break;
			case "compaction":
				items.push({
					kind: "compaction",
					key,
					seq,
					entry,
					summary: str(raw.summary) ?? "",
					tokensBefore: typeof raw.tokensBefore === "number" ? raw.tokensBefore : undefined,
				});
				break;
			case "branch_summary":
				items.push({ kind: "branch-summary", key, seq, entry, summary: str(raw.summary) ?? "" });
				break;
			case "label": {
				const label = str(raw.label);
				items.push({
					kind: "note",
					key,
					seq,
					entry,
					icon: "tag",
					text: label ? `Labeled ${str(raw.targetId) ?? "entry"} “${label}”` : `Cleared label on ${str(raw.targetId) ?? "entry"}`,
				});
				break;
			}
			case "session_info":
				items.push({ kind: "note", key, seq, entry, icon: "pencil", text: `Renamed session to “${str(raw.name) ?? ""}”` });
				break;
			case "custom_message":
				items.push({
					kind: "custom-message",
					key,
					seq,
					entry,
					customType: str(raw.customType) ?? "custom",
					content: raw.content,
					hidden: raw.display === false,
				});
				break;
			case "custom":
				items.push({ kind: "raw", key, seq, entry, label: `custom · ${str(raw.customType) ?? "unknown"}`, hidden: true });
				break;
			case "usage":
				items.push({ kind: "raw", key, seq, entry, label: `usage · ${str(raw.kind) ?? "unknown"}`, hidden: true });
				break;
			case "context_edit":
				items.push({ kind: "raw", key, seq, entry, label: "context edit", hidden: true });
				break;
			default:
				items.push({ kind: "raw", key, seq, entry, label: entry.type, hidden: true });
		}
	}
	return items;
}
