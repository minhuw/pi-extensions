/**
 * `/memory log`: the memory activity of the current branch in the shared log viewer, oldest first: the index pinned
 * at the session's start, every `memory_read`, `memory_save`, and `memory_forget` call with its result, and how the
 * dreams this session asked for ended. Every string shown is stripped of terminal sequences and control characters.
 */
import type { ExtensionCommandContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { localTime, type LogView, type LogViewItem, showLog, size } from "../log-viewer.ts";
import { headerField, sanitize } from "../relay/protocol.ts";
import type { DreamMode, Outcome } from "./dream/run.ts";
import { DREAM_ENTRY, type DreamRecord, type MemoryPin, PIN_ENTRY } from "./entries.ts";
import { firstLine, type ReadDetails, readFilters, saveAction, writeSummary } from "./tools.ts";

export type MemoryTool = "memory_read" | "memory_save" | "memory_forget";
const TOOLS: ReadonlySet<string> = new Set<MemoryTool>(["memory_read", "memory_save", "memory_forget"]);

export interface CallResult { text: string; isError: boolean; details?: unknown }
/** A dream entry as read; a change may carry the note's title, which the entries pika writes leave out. */
export type DreamItem = Omit<DreamRecord, "changes"> & { changes: (DreamRecord["changes"][number] & { title?: string })[] };
export type MemoryLogItem =
	| { kind: "pin"; at: string; pin: MemoryPin }
	/** A tool call; `result` is missing while it runs, or when it was aborted before it had one. */
	| { kind: "call"; at: string; tool: MemoryTool; id: string; args: Record<string, unknown>; result?: CallResult }
	| { kind: "dream"; at: string; dream: DreamItem };
type Call = Extract<MemoryLogItem, { kind: "call" }>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const text = (value: unknown) => isString(value) ? value : "";
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

function readPin(data: unknown): MemoryPin | undefined {
	if (!isObject(data) || (!isString(data.index) && data.index !== null)) return undefined;
	return {
		index: data.index, fetchedAt: text(data.fetchedAt),
		...(isString(data.project) ? { project: data.project } : {}), ...(isString(data.repository) ? { repository: data.repository } : {}), ...(isString(data.error) ? { error: data.error } : {}),
	};
}

function readDream(data: unknown): DreamItem | undefined {
	if (!isObject(data) || !isString(data.outcome)) return undefined;
	return {
		leaseId: text(data.leaseId), mode: text(data.mode) as DreamMode, outcome: data.outcome as Outcome, reason: text(data.reason), startedAt: text(data.startedAt), endedAt: text(data.endedAt),
		...(isString(data.scope) ? { scope: data.scope } : {}),
		sessions: Array.isArray(data.sessions) ? data.sessions.filter(isString) : [],
		batches: count(data.batches), notesChanged: count(data.notesChanged), discarded: count(data.discarded), uncertain: count(data.uncertain), turns: count(data.turns), tokens: count(data.tokens),
		...(isString(data.childSessionId) ? { childSessionId: data.childSessionId } : {}),
		model: text(data.model),
		changes: Array.isArray(data.changes)
			? data.changes.filter(isObject).map((change) => ({
				noteId: text(change.noteId), revision: count(change.revision), action: change.action === "forget" ? "forget" as const : "save" as const, created: change.created === true,
				...(isString(change.title) ? { title: change.title } : {}),
			}))
			: [],
	};
}

const contentText = (content: unknown) => Array.isArray(content)
	? content.map((part) => isObject(part) ? part.type === "text" ? text(part.text) : part.type === "image" ? "[image]" : "" : "").join("\n")
	: text(content);

/** The memory activity of `entries` in order; entries it cannot read are left out. */
export function memoryLogItems(entries: readonly SessionEntry[]): MemoryLogItem[] {
	const items: MemoryLogItem[] = [];
	const calls = new Map<string, Call>();
	for (const entry of entries) {
		if (entry.type === "custom") {
			if (entry.customType === PIN_ENTRY) {
				const pin = readPin(entry.data);
				if (pin) items.push({ kind: "pin", at: pin.fetchedAt || entry.timestamp, pin });
			} else if (entry.customType === DREAM_ENTRY) {
				const dream = readDream(entry.data);
				if (dream) items.push({ kind: "dream", at: dream.endedAt || entry.timestamp, dream });
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isObject(block) || block.type !== "toolCall" || !isString(block.name) || !TOOLS.has(block.name) || !isString(block.id) || !block.id) continue;
				const call: Call = { kind: "call", at: entry.timestamp, tool: block.name as MemoryTool, id: block.id, args: isObject(block.arguments) ? block.arguments : {} };
				calls.set(call.id, call);
				items.push(call);
			}
		} else if (message.role === "toolResult" && isString(message.toolCallId)) {
			const call = calls.get(message.toolCallId);
			if (!call || call.result) continue;
			call.result = { text: contentText(message.content), isError: message.isError === true, ...(message.details !== undefined ? { details: message.details } : {}) };
		}
	}
	return items;
}

/** How many notes an index lists: the server writes one `- title — hook [id]` line per note, under `#` and `##` headings. */
export const indexNotes = (index: string): number => index.split("\n").filter((line) => line.startsWith("- ")).length;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const OUTCOME_COLOR: Record<string, "success" | "warning" | "error"> = { completed: "success", aborted: "warning", failed: "error" };
const NO_RESULT = "the call was aborted, or is still running";

/** An argument on one line, in full; nothing for an empty one. */
function argument(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (isString(value)) return headerField(value) || undefined;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(argument).filter(Boolean).join(", ") || undefined;
	return headerField(JSON.stringify(value)) || undefined;
}

/** Each kind's arguments in the order its page lists them; a save's body goes under them, in full. */
const ARGUMENTS: Record<MemoryTool, [key: string, name: string][]> = {
	memory_read: [["ids", "Ids"], ["query", "Query"], ["category", "Category"], ["scope", "Scope"]],
	memory_save: [["scope", "Scope"], ["category", "Category"], ["title", "Title"], ["hook", "Hook"], ["reason", "Reason"], ["id", "Id"], ["expectedRevision", "Expected revision"]],
	memory_forget: [["id", "Id"], ["expectedRevision", "Expected revision"], ["reason", "Reason"]],
};

/** What a call came to: on its row briefly, on its page with the scope. */
function outcome(theme: Theme, call: Call, full: boolean): string {
	const { result } = call;
	if (!result) return theme.fg("warning", full ? `no result: ${NO_RESULT}` : "no result");
	const body = sanitize(result.text);
	if (result.isError) return theme.fg("error", headerField(firstLine(body)) || "failed");
	if (call.tool === "memory_read") {
		const ids = (result.details as ReadDetails | undefined)?.noteIds;
		if (!Array.isArray(ids)) return theme.fg("success", headerField(firstLine(body)));
		return ids.length ? theme.fg("success", plural(ids.length, "note")) : theme.fg("dim", "no notes");
	}
	const action = call.tool === "memory_forget" ? "forgot" : saveAction(call.args);
	return theme.fg("success", headerField(writeSummary(action, result.details, body, full)));
}

function callView(theme: Theme, call: Call): LogViewItem {
	const { args, tool } = call;
	const one = (key: string) => isString(args[key]) ? headerField(args[key]) : "";
	let what: string;
	if (tool === "memory_read") {
		const ids = Array.isArray(args.ids) ? args.ids.filter(isString).map(headerField).filter(Boolean) : [];
		what = theme.fg("muted", readFilters({ ids, query: one("query"), category: one("category"), scope: one("scope") }) || "all notes");
	} else if (tool === "memory_save") {
		what = `${theme.fg("muted", one("title"))}${theme.fg("dim", ` · ${one("scope") || "?"} · ${one("id") ? `update ${one("id")}` : "new"}`)}`;
	} else what = theme.fg("muted", one("id"));
	const line = `${theme.bold(tool)} ${what}`;
	const known = new Set([...ARGUMENTS[tool].map(([key]) => key), "body"]);
	const sections = tool === "memory_save" ? [`${theme.fg("dim", "Body:")}\n${sanitize(args.body) || "(empty)"}`] : [];
	sections.push(`${theme.fg("dim", "Result:")}\n${call.result ? sanitize(call.result.text) || "(empty)" : `None: ${NO_RESULT}.`}`);
	return {
		at: call.at,
		parts: [line, outcome(theme, call, false)],
		heading: line,
		fields: [
			["Time", localTime(call.at, true)],
			...ARGUMENTS[tool].map(([key, name]): [string, string | undefined] => [name, argument(args[key])]),
			// Arguments the tool does not define, as the model sent them.
			...Object.keys(args).filter((key) => !known.has(key)).map((key): [string, string | undefined] => [headerField(key), argument(args[key])]),
			["Outcome", outcome(theme, call, true)],
		],
		text: sections.join("\n\n"),
	};
}

function pinView(theme: Theme, at: string, pin: MemoryPin): LogViewItem {
	const index = isString(pin.index) ? sanitize(pin.index) : null;
	const notes = index === null ? 0 : indexNotes(index);
	const summary = index === null ? theme.fg("warning", "· no memory section")
		: index ? theme.fg("dim", `· ${plural(notes, "note")} · ${size(index)}`)
		: theme.fg("dim", "· empty index, no memory section");
	return {
		at,
		parts: [`${theme.bold("session start")} ${summary}`],
		heading: index === null ? `${theme.bold("No memory section")}: no index was pinned when the session started`
			: index ? `${theme.bold("Memory index")} pinned when the session started` : `${theme.bold("Empty memory index")} pinned when the session started, which adds no section`,
		fields: [
			["Fetched", localTime(at, true)],
			["Project", headerField(pin.project)],
			["Repository", headerField(pin.repository)],
			["Notes", index === null ? undefined : String(notes)],
			["Size", index === null ? undefined : size(index)],
			["Error", headerField(pin.error)],
		],
		text: index === null ? "This session's system prompt has no memory section: pika pinned no index when it started, and it never gains one." : index.trimEnd() || "(empty)",
	};
}

function dreamView(theme: Theme, at: string, dream: DreamItem): LogViewItem {
	const result = headerField(dream.outcome) || "ended";
	const head = `${theme.bold("dream")} ${theme.fg(OUTCOME_COLOR[result] ?? "muted", result)}`;
	const changes = dream.changes.map((change) => {
		const action = change.action === "forget" ? "forgot" : change.created ? "created" : "updated";
		const title = headerField(change.title);
		return `- ${action} [${headerField(change.noteId)}]${title ? ` ${title}` : ""} · rev ${change.revision}`;
	});
	const sessions = dream.sessions.map((id) => `- ${headerField(id)}`);
	return {
		at,
		parts: [`${head} ${theme.fg("dim", `· ${plural(dream.notesChanged, "note")} changed`)}`],
		heading: head,
		fields: [
			["Started", dream.startedAt ? localTime(dream.startedAt, true) : undefined],
			["Ended", localTime(at, true)],
			["Reason", headerField(dream.reason)],
			["Mode", headerField(dream.mode)],
			["Project", headerField(dream.scope)],
			["Lease", headerField(dream.leaseId)],
			["Sessions reviewed", String(dream.sessions.length)],
			["Batches committed", String(dream.batches)],
			["Notes changed", String(dream.notesChanged)],
			["Discarded changes", String(dream.discarded)],
			["Changes with unknown outcome", String(dream.uncertain)],
			["Turns", String(dream.turns)],
			["Budget tokens", String(dream.tokens)],
			["Dream session", headerField(dream.childSessionId)],
			["Model", headerField(dream.model)],
		],
		text: [
			`${theme.fg("dim", "Changes:")}\n${changes.join("\n") || "none"}`,
			`${theme.fg("dim", "Sessions reviewed:")}\n${sessions.join("\n") || "none"}`,
		].join("\n\n"),
	};
}

/** The memory log's items as the log viewer shows them. */
export function memoryView(theme: Theme, items: readonly MemoryLogItem[]): LogView {
	return {
		title: "memory log",
		noun: ["event", "events"],
		items: items.map((item) => item.kind === "pin" ? pinView(theme, item.at, item.pin) : item.kind === "dream" ? dreamView(theme, item.at, item.dream) : callView(theme, item)),
	};
}

/** Opens the memory log over the transcript until Esc or q closes it. */
export async function showMemoryLog(context: ExtensionCommandContext, items: readonly MemoryLogItem[]): Promise<void> {
	await showLog(context, (theme) => memoryView(theme, items));
}
