import { randomUUID } from "node:crypto";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { recallReadTool, recallSearchTool } from "../../recall/index.ts";
import { MemoryServerError } from "../client.ts";
import { type Category, type FullAnswer, formatFull, formatNote, type Note, type ScopeKind } from "../format.ts";
import { CATEGORY, firstLine, memoryReadTool, SCOPE } from "../tools.ts";
import { type Change, type CommitAnswer, type CommitBody, type DreamRun, MAX_CHANGES, MAX_SOURCES, type Source } from "./run.ts";
import { outcomeUnknown, send } from "./server.ts";

/** The tools only dream children get; never registered in top-level sessions. */
export const DREAM_TOOLS = ["dream_save", "dream_forget", "dream_commit"];

export interface StageDetails { position?: number; staged: number; error?: string }
/** `unknown`: the commit got no definite answer, so the server may have written it; its changes stay staged. */
export interface CommitDetails { batchId?: string; changes?: number; discarded?: number; unknown?: boolean; note?: Note; error?: string }

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");
const cleanId = (id: string) => id.trim().replace(/^\[|\]$/g, "");

function stageFailure(text: string, details: StageDetails): AgentToolResult<StageDetails> {
	return { content: [{ type: "text", text }], details: { ...details, error: text }, isError: true };
}

function commitFailure(text: string, details: CommitDetails): AgentToolResult<CommitDetails> {
	return { content: [{ type: "text", text }], details: { ...details, error: text }, isError: true };
}

const SOURCE = Type.Object({
	sessionId: Type.String({ description: "A session id, as recall_read shows it" }),
	seq: Type.Integer({ minimum: 0, description: "The seq of the entry in that session" }),
});
const SOURCES = (minItems: number) => Type.Array(SOURCE, { minItems, maxItems: MAX_SOURCES, description: `The session entries that support the change, ${minItems} to ${MAX_SOURCES}` });

const UNSAVED = "Nothing is written until dream_commit; a commit the server refuses discards its staged changes, and so does the end of the dream.";

/** The tools of a dream child: reading past sessions and notes, and staging and committing changes for `run`. */
export function dreamTools(run: DreamRun): ToolDefinition[] {
	return [recallSearchTool(), recallReadTool(), memoryReadTool(), dreamSaveTool(run), dreamForgetTool(run), dreamCommitTool(run)];
}

/** Why a change cannot be staged now, if it cannot. */
function refusal(run: DreamRun): string | undefined {
	if (run.ended) return `the dream has ended (${run.reason}); nothing more can be staged.`;
	if (run.staged.length >= MAX_CHANGES) return `${MAX_CHANGES} changes are staged already, the most one commit takes; call dream_commit first.`;
	return undefined;
}

const renderStage = (verb: string) => ({
	renderResult(result: AgentToolResult<unknown>, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: { fg(color: "dim" | "error" | "success", text: string): string }, context: { isError: boolean }) {
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		if (isPartial) return new Text(theme.fg("dim", `${verb}…`), 0, 0);
		if (context.isError) return new Text(theme.fg("error", expanded ? text : firstLine(text)), 0, 0);
		return new Text(expanded ? text : theme.fg("success", firstLine(text)), 0, 0);
	},
});

export function dreamSaveTool(run: DreamRun) {
	return defineTool({
		name: "dream_save", label: "Dream Save",
		description: "Stage a note to create or update in the user's memory; dream_commit writes the staged changes. "
			+ "Create: leave out `id` and pass `expectedRevision: 0`. Update: pass the note's `id` and the `revision` memory_read showed; the whole note is replaced. "
			+ "`scope: \"user\"` applies to every project, `scope: \"project\"` to the dream's project. "
			+ `Every note needs \`sources\`: 1 to ${MAX_SOURCES} session entries ({ sessionId, seq }) that support it. `
			+ "Limits: title up to 120 characters, hook one line up to 150, body up to 8 KiB. " + UNSAVED,
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "The note to update; leave out to create one" })),
			expectedRevision: Type.Integer({ minimum: 0, description: "0 to create; the note's current revision to update" }),
			scope: SCOPE,
			category: CATEGORY,
			title: Type.String({ description: "A short title, up to 120 characters" }),
			hook: Type.String({ description: "One line, up to 150 characters, saying when the note matters; the index lists it" }),
			body: Type.String({ description: "The note itself, up to 8 KiB; may be empty" }),
			reason: Type.Optional(Type.String({ description: "Why it is saved or changed, kept in the note's history" })),
			sources: SOURCES(1),
		}),
		async execute(_id, params): Promise<AgentToolResult<StageDetails>> {
			const refused = refusal(run);
			if (refused) return stageFailure(refused, { staged: run.staged.length });
			if (!params.sources.length || params.sources.length > MAX_SOURCES) return stageFailure(`dream_save needs 1 to ${MAX_SOURCES} sources.`, { staged: run.staged.length });
			const id = params.id ? cleanId(params.id) : "";
			const change: Change = {
				op: "save", ...(id ? { id } : {}), expectedRevision: params.expectedRevision, scope: params.scope as ScopeKind, category: params.category as Category,
				title: params.title, hook: params.hook, body: params.body, ...(params.reason ? { reason: params.reason } : {}), sources: params.sources as Source[],
			};
			const position = run.stage(change);
			const what = id ? `update of note ${id} at revision ${params.expectedRevision}` : "new note";
			const text = `Staged change ${position} (${what}) in the ${params.scope} scope: ${oneLine(params.title)} — ${oneLine(params.hook)}, with ${plural(params.sources.length, "source")}. ${plural(run.staged.length, "change")} staged. ${UNSAVED}`;
			return { content: [{ type: "text", text }], details: { position, staged: run.staged.length } };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("dream_save "))}${theme.fg("muted", String(args.title ?? ""))}${theme.fg("dim", ` · ${args.scope ?? "?"} · ${args.id ? `update ${args.id}` : "new"}`)}`, 0, 0);
		},
		...renderStage("staging"),
	});
}

export function dreamForgetTool(run: DreamRun) {
	return defineTool({
		name: "dream_forget", label: "Dream Forget",
		description: "Stage a note to forget, by its id and current revision from memory_read; dream_commit writes the staged changes. "
			+ `\`sources\` may name up to ${MAX_SOURCES} session entries ({ sessionId, seq }) showing why it goes. ` + UNSAVED,
		parameters: Type.Object({
			id: Type.String({ description: "The note to forget" }),
			expectedRevision: Type.Integer({ minimum: 1, description: "The note's current revision" }),
			reason: Type.Optional(Type.String({ description: "Why it is forgotten, kept in the note's history" })),
			sources: Type.Optional(SOURCES(0)),
		}),
		async execute(_id, params): Promise<AgentToolResult<StageDetails>> {
			const refused = refusal(run);
			if (refused) return stageFailure(refused, { staged: run.staged.length });
			const id = cleanId(params.id);
			if (!id) return stageFailure("dream_forget needs the id of a note; memory_read lists them.", { staged: run.staged.length });
			const sources = (params.sources ?? []) as Source[];
			if (sources.length > MAX_SOURCES) return stageFailure(`dream_forget takes at most ${MAX_SOURCES} sources.`, { staged: run.staged.length });
			const position = run.stage({ op: "forget", id, expectedRevision: params.expectedRevision, ...(params.reason ? { reason: params.reason } : {}), ...(sources.length ? { sources } : {}) });
			const text = `Staged change ${position} (forget note ${id} at revision ${params.expectedRevision}). ${plural(run.staged.length, "change")} staged. ${UNSAVED}`;
			return { content: [{ type: "text", text }], details: { position, staged: run.staged.length } };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("dream_forget "))}${theme.fg("muted", String(args.id ?? ""))}`, 0, 0);
		},
		...renderStage("staging"),
	});
}

/** A commit's answer: a batch, a definite refusal (nothing was written), or none definite (the server may have written it). */
type Attempt = { answer: CommitAnswer } | { failed: unknown } | { unknown: unknown };

async function attempt(run: DreamRun, body: CommitBody): Promise<Attempt> {
	try {
		// Never aborted with the child: a commit in flight gets its answer, or times out, even when the dream is stopped.
		return { answer: await send<CommitAnswer>(run.options.server, "POST", `memory/dream/${encodeURIComponent(run.lease.id)}/commit`, { body }) };
	} catch (error) {
		return outcomeUnknown(error) ? { unknown: error } : { failed: error };
	}
}

function committedText(answer: CommitAnswer, sessions: string[]): string {
	return [
		`Committed batch ${answer.batch.id}: ${plural(answer.batch.changes.length, "note")} changed${sessions.length ? `, ${plural(sessions.length, "session")} consolidated` : ""}.`,
		...answer.batch.changes.map((change) => `- ${change.action === "forget" ? "forgot" : change.created ? "created" : "updated"} [${change.noteId}] ${oneLine(change.title)} (revision ${change.revision})`),
		`The index is now (${answer.indexBytes} bytes, ${answer.indexLines} lines):`,
		answer.index || "(empty)",
	].join("\n");
}

const others = (kept: number) => kept ? ` ${plural(kept, "other staged change")} ${kept === 1 ? "is" : "are"} still staged.` : "";

/** Explains a refused commit: nothing was written, and its own changes are discarded; `kept` others stay staged. */
function explainCommit(error: unknown, changes: Change[], run: DreamRun, kept: number, before: string[]): AgentToolResult<CommitDetails> {
	const discarded = changes.length;
	const lost = `Nothing was written, and the ${plural(discarded, "staged change")} ${discarded === 1 ? "was" : "were"} discarded.${others(kept)}`;
	const failure = (text: string, details: CommitDetails = {}) => commitFailure([...before, text].join("\n\n"), { discarded, ...details });
	if (!(error instanceof MemoryServerError)) return failure(`${errorText(error)} ${lost}`);
	const { status, body } = error;
	const code = typeof body.error === "string" ? body.error : undefined;
	if (status === 409 && code === "lease_lost") {
		run.stop("stopped", "lost its lease");
		return failure(`lease_lost: this dream no longer holds its lease, so it ends now. ${lost}`);
	}
	if (status === 409 && code === "revision_conflict") {
		const note = body.note && typeof body.note === "object" ? body.note as Note : undefined;
		const index = typeof body.change === "number" ? body.change : undefined;
		const change = index !== undefined ? changes[index] : undefined;
		const which = change ? `change ${index! + 1} (${change.op}${change.id ? ` of note ${change.id}` : ""} at expected revision ${change.expectedRevision})` : "a change";
		const current = note ? ` Note ${note.id} is at revision ${note.revision}; its current state:\n\n${formatNote(note)}\n\n` : " ";
		return failure(`revision_conflict: ${which} no longer matches its note.${current}${lost} Merge with the current state, stage every change again with the current revisions, and commit again.`, note ? { note } : {});
	}
	if (status === 422) return failure(`${formatFull(body as FullAnswer).replace("Nothing was saved. ", "")} ${lost} Stage the changes again with fewer or shorter notes.`);
	if (status === 400) return failure(`the pika server refused the commit (HTTP 400 bad_request): ${typeof body.message === "string" ? body.message : "no reason given"}. ${lost}`);
	if (status === 404) return failure(`the pika server has no memory dream API (HTTP 404): it needs a newer pika. ${lost}`);
	return failure(`${error.message} ${lost}`);
}

/** Explains a commit without a definite answer: its changes stay staged, and a retry resends it with the same commit id. */
function unknownCommit(error: unknown, body: CommitBody, kept: number, before: string[]): AgentToolResult<CommitDetails> {
	const count = body.changes.length;
	const what = [count ? plural(count, "change") : "", body.sessions.length ? plural(body.sessions.length, "session") : ""].filter(Boolean).join(" and ");
	const text = `${errorText(error)} The outcome of this commit (${what}) is unknown: the server may or may not have written it.`
		+ `${count ? ` Its ${plural(count, "change")} ${count === 1 ? "is" : "are"} still staged, as sent.` : ""}${others(kept)}`
		+ " Call dream_commit again to retry it: that is safe, since the retry carries the same commit id and the server writes a commit at most once. Do not stage these changes again.";
	return { content: [{ type: "text", text: [...before, text].join("\n\n") }], details: { unknown: true, error: text }, isError: true };
}

/**
 * Commits for `run`: first the commit whose outcome is unknown, if any, resent exactly as it was; then the changes
 * staged besides it and the sessions not consolidated yet, under a new commit id.
 */
async function commit(run: DreamRun, sessions: string[], summary: string | undefined): Promise<AgentToolResult<CommitDetails>> {
	const texts: string[] = [];
	let changes = run.takeStaged();
	let left = sessions;
	const pending = run.pending;
	if (pending) {
		const own = changes.slice(0, pending.body.changes.length);
		const rest = changes.slice(own.length);
		const result = await attempt(run, pending.body);
		if ("unknown" in result) {
			run.restage(changes);
			return unknownCommit(result.unknown, pending.body, rest.length, texts);
		}
		run.pending = undefined;
		if ("failed" in result) {
			// Counted as failed already, when its outcome became unknown.
			run.restage(rest);
			run.dropped(own.length);
			return explainCommit(result.failed, own, run, run.staged.length, texts);
		}
		run.committed(result.answer.batch);
		texts.push(committedText(result.answer, pending.body.sessions));
		changes = rest;
		left = sessions.filter((id) => !pending.body.sessions.includes(id));
		if (!changes.length && !left.length) return committedResult(texts, run);
		if (run.ended) {
			run.restage(changes);
			return committedResult([...texts, `The dream has ended (${run.reason}); nothing more was committed.`], run);
		}
	}
	if (!left.length && !changes.length) return commitFailure("nothing to commit: no change is staged and no session is named.", { discarded: 0 });
	const body: CommitBody = { commitId: randomUUID(), ...(run.child ? { dreamSessionId: run.child.sessionId } : {}), ...(summary ? { summary } : {}), sessions: left, changes };
	const result = await attempt(run, body);
	if ("unknown" in result) {
		run.pending = { body };
		run.commitFailed();
		const kept = run.staged.length;
		run.restage(changes);
		return unknownCommit(result.unknown, body, kept, texts);
	}
	if ("failed" in result) {
		run.dropped(changes.length);
		run.commitFailed();
		return explainCommit(result.failed, changes, run, run.staged.length, texts);
	}
	run.committed(result.answer.batch);
	texts.push(committedText(result.answer, left));
	return committedResult(texts, run);
}

function committedResult(texts: string[], run: DreamRun): AgentToolResult<CommitDetails> {
	const last = run.batches.at(-1);
	const kept = run.staged.length;
	const text = texts.join("\n\n") + (kept ? `\n${others(kept).trim()}` : "");
	return { content: [{ type: "text", text }], details: { ...(last ? { batchId: last.id, changes: last.changes.length } : {}) } };
}

export function dreamCommitTool(run: DreamRun) {
	return defineTool({
		name: "dream_commit", label: "Dream Commit",
		description: "Write every staged change as one batch, and mark the sessions you name as consolidated up to the entries this dream was given. "
			+ "Name only sessions you finished, from the task message; `sessions` may be empty when only staged changes are written, and a commit may name sessions with no change. "
			+ "If the server refuses the commit (a note changed meanwhile, the index would be too large, or a change is invalid), nothing is written and its staged changes are discarded: read again, stage again, and commit again. "
			+ "If its outcome is unknown (no answer in time, or a server error), its changes stay staged: call dream_commit again, which never writes a commit twice.",
		parameters: Type.Object({
			sessions: Type.Array(Type.String(), { description: "The ids of the sessions this batch finishes" }),
			summary: Type.Optional(Type.String({ description: "One line on what this batch changes, up to 1000 characters" })),
		}),
		// Its whole answer's tool calls then run one by one, so a change staged beside a commit never races it.
		executionMode: "sequential",
		async execute(_id, params): Promise<AgentToolResult<CommitDetails>> {
			if (run.ended) return commitFailure(`the dream has ended (${run.reason}); nothing can be committed.`, {});
			if (run.committing) return commitFailure("another dream_commit is still running; call dream_commit again once it has returned.", {});
			const sessions = [...new Set(params.sessions.map((id) => id.trim()).filter(Boolean))];
			const foreign = sessions.filter((id) => !run.sessions.some((session) => session.id === id));
			if (foreign.length) {
				const staged = run.staged.length;
				return commitFailure(`${foreign.join(", ")} ${foreign.length === 1 ? "is not one of" : "are not among"} this dream's sessions (${run.sessions.map((session) => session.id).join(", ") || "it has none"}). `
					+ `Nothing was sent${staged ? `, and the ${plural(staged, "staged change")} ${staged === 1 ? "is" : "are"} still staged` : ""}: name only sessions the task message lists, and commit again.`, { discarded: 0 });
			}
			const done = run.beginCommit();
			try {
				return await commit(run, sessions, params.summary?.trim() || undefined);
			} finally {
				done();
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("dream_commit "))}${theme.fg("muted", `${run.staged.length} staged`)}${theme.fg("dim", ` · ${(args.sessions ?? []).length} sessions`)}`, 0, 0);
		},
		...renderStage("committing"),
	});
}
