import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const SESSION_LINK_TYPE = "pi-extensions.session-link";
/** Subagents' persistent model overrides; the `recon` key names the recon subagent's model. */
const SUBAGENT_MODELS_FILE = "subagent-models.json";
const INPUT_LIMIT = 4000;
const TITLE_LIMIT = 80;
/** Records each name this extension set, with the context tokens at that time; never part of the LLM context. */
export const AUTO_ENTRY = "session-name.auto";
/** A refresh is due after this share of the context window has grown since the last automatic naming, capped below. */
const REFRESH_SHARE = 1 / 4;
const REFRESH_CAP = 256_000;
const RECENT_LIMIT = 8000;
const KEEP = "KEEP";

export const SYSTEM_PROMPT = [
	"You name coding-agent sessions so they can be found later by search.",
	"Reply with one title of at most 60 characters that says concretely what the task is: name the component, file, feature, bug, or tool involved.",
	"Write it in the same language as the user's request.",
	"Reply with the title only: no quotes, no markdown, no trailing period.",
].join("\n");

export const REFRESH_SYSTEM_PROMPT = [
	"You keep the titles of coding-agent sessions current so they can be found later by search.",
	"You get the session's first request, its current title, a summary of earlier work if the conversation was compacted, and the most recent messages.",
	`If the current title still describes the session's main work, reply exactly ${KEEP}.`,
	"Otherwise reply one new title of at most 60 characters that says concretely what the session's main work is: name the component, file, feature, bug, or tool involved.",
	"Write it in the same language as the user's messages.",
	`Reply with ${KEEP} or the title only: no quotes, no markdown, no trailing period.`,
].join("\n");

type Message = { role?: unknown; content?: unknown; stopReason?: unknown };

/**
 * Top-level TUI and RPC sessions. Live children (subagents, Herder steps, council advisors, dreams) bind extensions
 * with no mode, which Pi runs as print, and persisted children carry a session link. `parentSession` cannot identify a
 * child: Pi also sets it on forks.
 */
export function isChildSession(ctx: Pick<ExtensionContext, "mode" | "sessionManager">): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return true;
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** The first user prompt and the first final assistant answer on the current branch, or undefined before both exist. */
export function firstExchange(ctx: Pick<ExtensionContext, "sessionManager">): { prompt: string; answer: string } | undefined {
	let prompt: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as Message;
		if (prompt === undefined) {
			if (message.role === "user") prompt = textOf(message.content).trim() || undefined;
			continue;
		}
		if (message.role !== "assistant" || message.stopReason !== "stop") continue;
		const answer = textOf(message.content).trim();
		if (answer) return { prompt, answer };
	}
	return undefined;
}

/** The latest automatic naming on the current branch; `tokens` is null when the context size was unknown then. */
export function lastAutoName(ctx: Pick<ExtensionContext, "sessionManager">): { name: string; tokens: number | null } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== AUTO_ENTRY) continue;
		const data = entry.data as { name?: unknown; tokens?: unknown } | undefined;
		if (typeof data?.name !== "string") continue;
		return { name: data.name, tokens: typeof data.tokens === "number" ? data.tokens : null };
	}
	return undefined;
}

export type RefreshInput = { name: string; prompt: string; summary?: string; recent: string };

/**
 * What a refresh sends: the first user prompt, the latest compaction summary, and the newest user and assistant text on
 * the branch, about 8000 characters with the newest kept.
 */
export function refreshInput(ctx: Pick<ExtensionContext, "sessionManager">, name: string): RefreshInput | undefined {
	const branch = ctx.sessionManager.getBranch();
	let prompt: string | undefined;
	let summary: string | undefined;
	for (const entry of branch) {
		if (entry.type === "compaction") summary = entry.summary.trim() || undefined;
		else if (prompt === undefined && entry.type === "message" && (entry.message as Message).role === "user") {
			prompt = textOf((entry.message as Message).content).trim() || undefined;
		}
	}
	if (prompt === undefined) return undefined;
	const recent: string[] = [];
	let length = 0;
	for (let index = branch.length - 1; index >= 0 && length < RECENT_LIMIT; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message as Message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textOf(message.content).trim();
		if (!text) continue;
		const room = RECENT_LIMIT - length;
		const kept = text.length <= room ? text : `…${text.slice(text.length - room)}`;
		recent.unshift(`[${message.role}] ${kept}`);
		length += kept.length;
	}
	return { name, prompt, summary, recent: recent.join("\n\n") };
}

function truncate(text: string): string {
	return text.length <= INPUT_LIMIT ? text : `${text.slice(0, INPUT_LIMIT)}…`;
}

export function buildContext(exchange: { prompt: string; answer: string }): Context {
	const content = `<user-request>\n${truncate(exchange.prompt)}\n</user-request>\n\n<assistant-answer>\n${truncate(exchange.answer)}\n</assistant-answer>`;
	return { systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] };
}

export function buildRefreshContext(input: RefreshInput): Context {
	const sections = [
		`<first-request>\n${truncate(input.prompt)}\n</first-request>`,
		`<current-title>\n${input.name}\n</current-title>`,
		...(input.summary ? [`<earlier-work-summary>\n${truncate(input.summary)}\n</earlier-work-summary>`] : []),
		`<recent-messages>\n${input.recent}\n</recent-messages>`,
	];
	return { systemPrompt: REFRESH_SYSTEM_PROMPT, messages: [{ role: "user", content: sections.join("\n\n"), timestamp: Date.now() }] };
}

/** The first non-empty line without quotes, markdown, a `Title:` label, or a trailing period, cut to 80 characters. */
export function sanitizeTitle(raw: string): string {
	const line = raw.split(/\r?\n/).map((candidate) => candidate.trim()).find(Boolean) ?? "";
	const title = line
		.replace(/^(?:#+|[-*>]|\d+[.)])\s+/, "")
		.replace(/^\*{0,2}title\*{0,2}\s*[:：]\s*/i, "")
		.replace(/[*_`]+/g, "")
		.replace(/^["'“”‘’「『«]+|["'“”‘’」』»]+$/g, "")
		.replace(/[.。]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
	return [...title].slice(0, TITLE_LIMIT).join("").trim();
}

/** The recon subagent's model spec from `<agentDir>/subagent-models.json`; undefined when it inherits the session model. */
async function reconModelSpec(): Promise<string | undefined> {
	const path = join(getAgentDir(), SUBAGENT_MODELS_FILE);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`cannot read ${path}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).recon : undefined;
	if (typeof value !== "string" || value.trim() === "inherit") return undefined;
	return value.trim();
}

export async function resolveNamingModel(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): Promise<Model<Api>> {
	const spec = await reconModelSpec();
	if (spec === undefined) {
		if (!ctx.model) throw new Error("the session has no model");
		return ctx.model;
	}
	const slash = spec.indexOf("/");
	const model = slash > 0 ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
	if (!model) throw new Error(`recon model "${spec}" was not found`);
	return model;
}

async function generateTitle(ctx: ExtensionContext, context: Context, signal: AbortSignal): Promise<string | undefined> {
	const model = await resolveNamingModel(ctx);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`no credentials for ${model.provider}/${model.id}`);
	const reply = await ctx.modelRegistry.complete(model, context, { signal });
	if (reply.stopReason === "aborted") return undefined;
	if (reply.stopReason === "error") throw new Error(`${model.provider}/${model.id}: ${reply.errorMessage ?? "request failed"}`);
	return sanitizeTitle(textOf(reply.content));
}

/** Context tokens now, or undefined when unknown (normal right after compaction). */
function contextTokens(ctx: ExtensionContext): { tokens: number; step: number } | undefined {
	const usage = ctx.getContextUsage();
	if (usage?.tokens == null || !(usage.contextWindow > 0)) return undefined;
	return { tokens: usage.tokens, step: Math.min(usage.contextWindow * REFRESH_SHARE, REFRESH_CAP) };
}

/**
 * Names an unnamed top-level session after its first answered prompt, using the recon subagent's model, then refreshes
 * that name each time the context has grown by a quarter of the window (at most 256K tokens). Runs in the background;
 * it never touches the conversation or the system prompt. Only names recorded in its own `session-name.auto` entries
 * are refreshed, so a name from `/name` or `--name` is never replaced.
 */
export default function sessionName(pi: ExtensionAPI): void {
	let controller: AbortController | undefined;
	/** The first naming is tried once per session load, as before refreshes existed. */
	let firstTried = false;
	/**
	 * Context tokens at the last failed refresh. A failure advances no baseline, so the next attempt would come on the
	 * very next run; instead it waits for another step of growth past this point (or a reload, which clears it).
	 */
	let failedAt: number | undefined;

	function record(name: string, tokens: number | null): void {
		pi.appendEntry(AUTO_ENTRY, { name, tokens });
	}

	function warn(ctx: ExtensionContext, error: unknown): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(`Session naming failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}

	async function name(ctx: ExtensionContext, exchange: { prompt: string; answer: string }, tokens: number | null, signal: AbortSignal): Promise<void> {
		try {
			const title = await generateTitle(ctx, buildContext(exchange), signal);
			// A name set meanwhile (`/name`) wins; after shutdown `pi` is stale.
			if (signal.aborted || !title || pi.getSessionName()) return;
			pi.setSessionName(title);
			record(title, tokens);
		} catch (error) {
			if (!signal.aborted) warn(ctx, error);
		} finally {
			if (!signal.aborted) controller = undefined;
		}
	}

	async function refresh(ctx: ExtensionContext, input: RefreshInput, tokens: number, signal: AbortSignal): Promise<void> {
		try {
			const title = await generateTitle(ctx, buildRefreshContext(input), signal);
			// Aborted, or the user renamed the session meanwhile: that name is theirs from now on.
			if (signal.aborted || title === undefined || pi.getSessionName() !== input.name) return;
			failedAt = undefined;
			// KEEP, the same title, or an empty reply keeps the name; the new entry still advances the baseline.
			const next = !title || title === KEEP ? input.name : title;
			if (next !== input.name) pi.setSessionName(next);
			record(next, tokens);
		} catch (error) {
			if (signal.aborted) return;
			failedAt = tokens;
			warn(ctx, error);
		} finally {
			if (!signal.aborted) controller = undefined;
		}
	}

	function checkRefresh(ctx: ExtensionContext, current: string): void {
		const last = lastAutoName(ctx);
		if (!last || last.name !== current) return;
		const usage = contextTokens(ctx);
		if (!usage) return;
		const { tokens, step } = usage;
		if (last.tokens === null || tokens < last.tokens) {
			// Compaction shrank the context (or its size was unknown at the naming): growth counts from here.
			failedAt = undefined;
			record(last.name, tokens);
			return;
		}
		if (tokens < last.tokens + step || (failedAt !== undefined && tokens < failedAt + step)) return;
		const input = refreshInput(ctx, current);
		if (!input) return;
		controller = new AbortController();
		void refresh(ctx, input, tokens, controller.signal);
	}

	pi.on("agent_settled", (event, ctx) => {
		if (controller || event.aborted || isChildSession(ctx)) return;
		const current = pi.getSessionName();
		if (current) {
			checkRefresh(ctx, current);
			return;
		}
		if (firstTried) return;
		const exchange = firstExchange(ctx);
		if (!exchange) return;
		firstTried = true;
		controller = new AbortController();
		void name(ctx, exchange, contextTokens(ctx)?.tokens ?? null, controller.signal);
	});

	pi.on("session_shutdown", () => {
		controller?.abort();
	});
}
