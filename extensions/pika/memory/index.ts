import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveRepository } from "../repository.ts";
import { request, timing } from "./client.ts";
import dreamExtension from "./dream/index.ts";
import { type MemoryView, sectionText } from "./format.ts";
import { cwdOf, memoryForgetTool, memoryReadTool, memorySaveTool, where } from "./tools.ts";

export { timing } from "./client.ts";
export type { ReadDetails, WriteDetails } from "./tools.ts";

/** The custom entry that pins a session's memory index at its first run. */
export const PIN_ENTRY = "pika-memory";
const SESSION_LINK_TYPE = "pi-extensions.session-link";

/** The pin: `index` is null when the fetch failed, timed out, or pika was logged out, so the session never gains a section. */
export interface MemoryPin { index: string | null; fetchedAt: string; project?: string; repository?: string; error?: string }

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const isPin = (entry: SessionEntry): entry is CustomEntry<MemoryPin> => entry.type === "custom" && entry.customType === PIN_ENTRY;
const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

/**
 * Top-level TUI and RPC sessions. Live children bind extensions with no mode, which Pi runs as print, and persisted
 * children carry a session link when child-session hooks are registered.
 */
function isEligible(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return !ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

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
			if (!isEligible(ctx)) return undefined;
			let pin = readPin(ctx);
			if (!pin) {
				// A session with history may have its prompt cached already, so it never gains a section.
				if (ctx.sessionManager.getEntries().some(isConversation)) return undefined;
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
