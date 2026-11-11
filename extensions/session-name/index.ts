import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const SESSION_LINK_TYPE = "pi-extensions.session-link";
/** Subagents' persistent model overrides; the `recon` key names the recon subagent's model. */
const SUBAGENT_MODELS_FILE = "subagent-models.json";
const INPUT_LIMIT = 4000;
const TITLE_LIMIT = 80;

export const SYSTEM_PROMPT = [
	"You name coding-agent sessions so they can be found later by search.",
	"Reply with one title of at most 60 characters that says concretely what the task is: name the component, file, feature, bug, or tool involved.",
	"Write it in the same language as the user's request.",
	"Reply with the title only: no quotes, no markdown, no trailing period.",
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

function truncate(text: string): string {
	return text.length <= INPUT_LIMIT ? text : `${text.slice(0, INPUT_LIMIT)}…`;
}

export function buildContext(exchange: { prompt: string; answer: string }): Context {
	const content = `<user-request>\n${truncate(exchange.prompt)}\n</user-request>\n\n<assistant-answer>\n${truncate(exchange.answer)}\n</assistant-answer>`;
	return { systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] };
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

async function generateTitle(ctx: ExtensionContext, exchange: { prompt: string; answer: string }, signal: AbortSignal): Promise<string | undefined> {
	const model = await resolveNamingModel(ctx);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`no credentials for ${model.provider}/${model.id}`);
	const reply = await ctx.modelRegistry.complete(model, buildContext(exchange), { signal });
	if (reply.stopReason === "aborted") return undefined;
	if (reply.stopReason === "error") throw new Error(`${model.provider}/${model.id}: ${reply.errorMessage ?? "request failed"}`);
	return sanitizeTitle(textOf(reply.content));
}

/**
 * Names an unnamed top-level session after its first answered prompt, using the recon subagent's model. Runs in the
 * background once per session; it never touches the conversation or the system prompt.
 */
export default function sessionName(pi: ExtensionAPI): void {
	let controller: AbortController | undefined;

	async function name(ctx: ExtensionContext, exchange: { prompt: string; answer: string }, signal: AbortSignal): Promise<void> {
		try {
			const title = await generateTitle(ctx, exchange, signal);
			// A name set meanwhile (`/name`) wins; after shutdown `pi` is stale.
			if (signal.aborted || !title || pi.getSessionName()) return;
			pi.setSessionName(title);
		} catch (error) {
			if (signal.aborted || !ctx.hasUI) return;
			ctx.ui.notify(`Session naming failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	pi.on("agent_settled", (event, ctx) => {
		if (controller || event.aborted || pi.getSessionName() || isChildSession(ctx)) return;
		const exchange = firstExchange(ctx);
		if (!exchange) return;
		controller = new AbortController();
		void name(ctx, exchange, controller.signal);
	});

	pi.on("session_shutdown", () => {
		controller?.abort();
	});
}
