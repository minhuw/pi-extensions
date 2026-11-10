import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveRepository } from "../repository.ts";
import { request, timing } from "./client.ts";
import dreamExtension from "./dream/index.ts";
import { type MemoryPin, PIN_ENTRY } from "./entries.ts";
import { type MemoryView, sectionText } from "./format.ts";
import { cwdOf, memoryForgetTool, memoryReadTool, memorySaveTool, where } from "./tools.ts";

export { timing } from "./client.ts";
export { DREAM_ENTRY, type DreamRecord, type MemoryPin, PIN_ENTRY } from "./entries.ts";
export type { ReadDetails, WriteDetails } from "./tools.ts";

const SESSION_LINK_TYPE = "pi-extensions.session-link";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const isPin = (entry: SessionEntry): entry is CustomEntry<MemoryPin> => entry.type === "custom" && entry.customType === PIN_ENTRY;
/**
 * Whether an entry shows that a provider request may have sent the session's prompt already: the messages of a run,
 * a compaction, or a branch summary. `!` commands and custom messages appended while idle precede any request.
 */
const isRequested = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult"
	: entry.type === "compaction" || entry.type === "branch_summary";

/** Persisted children carry a session link when child-session hooks are registered; they never show a section. */
const isChild = (ctx: ExtensionContext) => ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
/** Only top-level TUI and RPC sessions create a pin. Live children bind extensions with no mode, which Pi runs as print. */
const mayPin = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";

/** The pin of the current branch, else of the session: its first run fixes the prompt on every branch. */
function readPin(ctx: ExtensionContext): MemoryPin | undefined {
	return (ctx.sessionManager.getBranch().find(isPin) ?? ctx.sessionManager.getEntries().find(isPin))?.data;
}

/** memory: durable notes per user and per project on the user's pika server, their index pinned in the system prompt, and dreams that consolidate them. */
export default function memoryExtension(pi: ExtensionAPI): void {
	pi.registerTool(memoryReadTool());
	pi.registerTool(memorySaveTool());
	pi.registerTool(memoryForgetTool());

	/** Fetches the index for a fresh session's pin, within `timing.indexTimeoutMs` in all; every failure pins no index. */
	async function fetchPin(cwd: string): Promise<MemoryPin> {
		const fetchedAt = new Date().toISOString();
		const deadline = Date.now() + timing.indexTimeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const late = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`no repository within ${timing.indexTimeoutMs / 1000} s`)), timing.indexTimeoutMs);
				timer.unref?.();
			});
			const repository = where(await Promise.race([resolveRepository(cwd), late]));
			clearTimeout(timer);
			const view = await request<MemoryView>(cwd, "GET", `memory?${new URLSearchParams({ ...repository })}`, { timeoutMs: Math.max(1, deadline - Date.now()) });
			return { index: typeof view.index === "string" ? view.index : null, fetchedAt, ...repository };
		} catch (error) {
			return { index: null, fetchedAt, error: errorText(error) };
		} finally {
			clearTimeout(timer);
		}
	}

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (isChild(ctx)) return undefined;
			// An existing pin applies in every mode, so a print or JSON resume keeps the section and its cache.
			let pin = readPin(ctx);
			if (!pin) {
				if (!mayPin(ctx)) return undefined;
				// A session with history may have its prompt cached already, so it never gains a section.
				if (ctx.sessionManager.getEntries().some(isRequested)) return undefined;
				pin = await fetchPin(cwdOf(ctx));
				pi.appendEntry<MemoryPin>(PIN_ENTRY, pin);
			}
			// Set on every run: Pi diffs each run's sections against the transcript, so a missing one would be removed.
			if (pin.index) event.systemPromptOptions.sections.memory = sectionText(pin.index);
		} catch { /* memory never fails a turn */ }
		return undefined;
	});

	dreamExtension(pi);
}

export { memoryExtension };
