import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { recallReadTool, recallSearchTool } from "../../recall/index.ts";
import { MemoryServerError, request } from "../client.ts";
import { type Category, type FullAnswer, formatFull, formatNote, type Note, type ScopeKind } from "../format.ts";
import { CATEGORY, firstLine, memoryReadTool, SCOPE } from "../tools.ts";
import { type Change, type CommitAnswer, type DreamRun, MAX_CHANGES, MAX_SOURCES, type Source } from "./run.ts";

/** The tools only dream children get; never registered in top-level sessions. */
export const DREAM_TOOLS = ["dream_save", "dream_forget", "dream_commit"];

export interface StageDetails { position?: number; staged: number; error?: string }
export interface CommitDetails { batchId?: string; changes?: number; discarded?: number; note?: Note; error?: string }

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

const UNSAVED = "Nothing is written until dream_commit; a failed commit or the end of the dream discards every staged change.";

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

/** Explains a failed commit; its staged changes are already discarded. */
function explainCommit(error: unknown, changes: Change[], run: DreamRun): AgentToolResult<CommitDetails> {
	const discarded = changes.length;
	const lost = `Nothing was written, and the ${plural(discarded, "staged change")} ${discarded === 1 ? "was" : "were"} discarded.`;
	if (!(error instanceof MemoryServerError)) return commitFailure(`${errorText(error)} ${lost}`, { discarded });
	const { status, body } = error;
	const code = typeof body.error === "string" ? body.error : undefined;
	if (status === 409 && code === "lease_lost") {
		run.stop("aborted", "lost its lease");
		return commitFailure(`lease_lost: this dream no longer holds its lease, so it ends now. ${lost}`, { discarded });
	}
	if (status === 409 && code === "revision_conflict") {
		const note = body.note && typeof body.note === "object" ? body.note as Note : undefined;
		const index = typeof body.change === "number" ? body.change : undefined;
		const change = index !== undefined ? changes[index] : undefined;
		const which = change ? `change ${index! + 1} (${change.op}${change.id ? ` of note ${change.id}` : ""} at expected revision ${change.expectedRevision})` : "a change";
		const current = note ? ` Note ${note.id} is at revision ${note.revision}; its current state:\n\n${formatNote(note)}\n\n` : " ";
		return commitFailure(`revision_conflict: ${which} no longer matches its note.${current}${lost} Merge with the current state, stage every change again with the current revisions, and commit again.`, { discarded, ...(note ? { note } : {}) });
	}
	if (status === 422) return commitFailure(`${formatFull(body as FullAnswer).replace("Nothing was saved. ", "")} ${lost} Stage the changes again with fewer or shorter notes.`, { discarded });
	if (status === 400) return commitFailure(`the pika server refused the commit (HTTP 400 bad_request): ${typeof body.message === "string" ? body.message : "no reason given"}. ${lost}`, { discarded });
	if (status === 404) return commitFailure(`the pika server has no memory dream API (HTTP 404): it needs a newer pika. ${lost}`, { discarded });
	return commitFailure(`${error.message} ${lost}`, { discarded });
}

export function dreamCommitTool(run: DreamRun) {
	return defineTool({
		name: "dream_commit", label: "Dream Commit",
		description: "Write every staged change as one batch, and mark the sessions you name as consolidated up to the entries this dream was given. "
			+ "Name only sessions you finished; `sessions` may be empty when only staged changes are written. "
			+ "If the commit fails (a note changed meanwhile, the index would be too large, or a change is invalid), nothing is written and every staged change is discarded: read again, stage again, and commit again.",
		parameters: Type.Object({
			sessions: Type.Array(Type.String(), { description: "The ids of the sessions this batch finishes" }),
			summary: Type.Optional(Type.String({ description: "One line on what this batch changes, up to 1000 characters" })),
		}),
		async execute(_id, params, signal): Promise<AgentToolResult<CommitDetails>> {
			if (run.ended) return commitFailure(`the dream has ended (${run.reason}); nothing can be committed.`, {});
			const sessions = params.sessions.map((id) => id.trim()).filter(Boolean);
			const changes = run.takeStaged();
			if (!sessions.length && !changes.length) return commitFailure("nothing to commit: no change is staged and no session is named.", { discarded: 0 });
			const summary = params.summary?.trim();
			const body = { dreamSessionId: run.child?.sessionId, ...(summary ? { summary } : {}), sessions, changes };
			try {
				const answer = await request<CommitAnswer>(run.options.cwd, "POST", `memory/dream/${encodeURIComponent(run.lease.id)}/commit`, { body, signal });
				run.committed(answer.batch);
				const text = [
					`Committed batch ${answer.batch.id}: ${plural(answer.batch.changes.length, "note")} changed${sessions.length ? `, ${plural(sessions.length, "session")} consolidated` : ""}.`,
					...answer.batch.changes.map((change) => `- ${change.action === "forget" ? "forgot" : change.created ? "created" : "updated"} [${change.noteId}] ${oneLine(change.title)} (revision ${change.revision})`),
					`The index is now (${answer.indexBytes} bytes, ${answer.indexLines} lines):`,
					answer.index || "(empty)",
				].join("\n");
				return { content: [{ type: "text", text }], details: { batchId: answer.batch.id, changes: answer.batch.changes.length } };
			} catch (error) {
				run.dropped(changes.length);
				return explainCommit(error, changes, run);
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("dream_commit "))}${theme.fg("muted", `${run.staged.length} staged`)}${theme.fg("dim", ` · ${(args.sessions ?? []).length} sessions`)}`, 0, 0);
		},
		...renderStage("committing"),
	});
}
