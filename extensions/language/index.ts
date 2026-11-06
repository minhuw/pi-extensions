import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type CustomEntry, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

const ENTRY = "language";
const SESSION_LINK_TYPE = "pi-extensions.session-link";
const KEEP_CODE = "Keep code, identifiers, commands, and file paths unchanged.";
const RESET_TEXT = "Ignore earlier language overrides.";

type LanguagePin = { base: string | null; fallback?: string };
/** The pin, written once at a branch's first run, or a switch. A null `active` follows the pin. */
type LanguageEntry = LanguagePin | { active: string | null; reset?: true };

interface LanguageState {
	/** The pin: undefined until the session's first run, null when it pinned no default. */
	base: string | null | undefined;
	/** The default of a session that can never gain a section, sent by message. Fixed with the pin. */
	fallback: string | undefined;
	/** Whether the current branch holds the pin. `/tree` can move to before it. */
	pinned: boolean;
	active: string | undefined;
	resetPending: boolean;
}

const sectionText = (base: string) => `Default response language: ${base}. A later language message overrides it. ${KEEP_CODE}`;
const switchText = (active: string) => `Respond in ${active}, whatever language the user writes in. This overrides the default language. ${KEEP_CODE}`;
const resetText = (base: string | undefined) => `${RESET_TEXT} Respond in ${base ?? "the user's language"}.`;
const hidden = (content: string) => ({ message: { customType: ENTRY, content, display: false } });

const configPath = () => join(getAgentDir(), "language.json");
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sessionDefault = ({ base, fallback }: Pick<LanguageState, "base" | "fallback">) => base ?? fallback;
const isSwitched = ({ active, base }: Pick<LanguageState, "active" | "base">) => active !== undefined && !sameName(active, base ?? "");
const isPin = (entry: SessionEntry): entry is CustomEntry<LanguagePin> => entry.type === "custom" && entry.customType === ENTRY && "base" in (entry.data as LanguageEntry);
const isResetMessage = (entry: SessionEntry) => entry.type === "custom_message" && entry.customType === ENTRY && typeof entry.content === "string" && entry.content.startsWith(RESET_TEXT);
const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

/** The footer label: the active language, or the configured default for a session with no pin yet. */
const statusLabel = ({ base, active }: LanguageState, configured: string | undefined) => active ?? (base === undefined ? configured : undefined);

/** The trimmed name, or undefined when it breaks the name rules. The trim would remove control characters, so they are tested first. */
function validName(value: string): string | undefined {
	if (/\p{Cc}/u.test(value)) return undefined;
	const name = value.trim();
	const length = [...name].length;
	return length >= 1 && length <= 40 && !/^(?:reset|default)$/i.test(name) ? name : undefined;
}

/** The language state of the current branch. */
function readBranch(ctx: ExtensionContext): LanguageState {
	let pin: LanguagePin | undefined;
	let latest: Extract<LanguageEntry, { active: unknown }> | undefined;
	let resetPending = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		// Only the reset's own message ends it: a run already starting can land its switch message after the reset.
		if (isResetMessage(entry)) resetPending = false;
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = entry.data as LanguageEntry;
		if ("base" in data) pin = data;
		else {
			latest = data;
			resetPending = data.reset === true;
		}
	}
	const pinned = pin !== undefined;
	// Off the branch only for this: a session's first run fixes its prompt on every branch, even one that leaves before the pin.
	const { base, fallback }: Partial<LanguagePin> = pin ?? ctx.sessionManager.getEntries().find(isPin)?.data ?? {};
	return { base, fallback, pinned, active: latest?.active ?? sessionDefault({ base, fallback }), resetPending };
}

/**
 * Top-level TUI and RPC sessions. Live children bind extensions with no mode, which Pi runs as print, and persisted
 * children carry a session link when child-session hooks are registered. `parentSession` cannot identify a child: Pi
 * also sets it on forks.
 */
function isEligible(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return !ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

/** The default for new sessions. A missing file means none; a bad one means none and a warning. */
async function readDefault(ctx: ExtensionContext): Promise<string | undefined> {
	const path = configPath();
	try {
		const value = (JSON.parse(await readFile(path, "utf8")) as { default?: unknown } | null)?.default;
		const name = typeof value === "string" ? validName(value) : undefined;
		if (name) return name;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
	}
	ctx.ui.notify(`Ignoring ${path}: expected { "default": "<language>" } with a valid language name.`, "warning");
	return undefined;
}

async function writeDefault(name: string): Promise<void> {
	const path = configPath();
	const temporary = `${path}.${randomUUID()}.tmp`;
	await mkdir(getAgentDir(), { recursive: true });
	try {
		await writeFile(temporary, `${JSON.stringify({ default: name })}\n`, { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }); }
}

function setStatus(ctx: ExtensionContext, label: string | undefined): void {
	try { ctx.ui.setStatus(ENTRY, label); } catch {}
}

function warnInvalidName(ctx: ExtensionContext): void {
	ctx.ui.notify('A language name has 1 to 40 characters and no control characters, and cannot be "reset" or "default".', "warning");
}

/** Applies `/language default <value>` and returns the default for new sessions. */
async function changeDefault(value: string, ctx: ExtensionContext): Promise<string | undefined> {
	const keeps = "Sessions that have had a first run keep their language.";
	if (value.trim().toLowerCase() === "off") {
		await rm(configPath(), { force: true });
		ctx.ui.notify(`Removed the default for new sessions. ${keeps}`, "info");
		return undefined;
	}
	const name = validName(value);
	if (!name) {
		warnInvalidName(ctx);
		return readDefault(ctx);
	}
	await writeDefault(name);
	ctx.ui.notify(`Default for new sessions: ${name}. ${keeps}`, "info");
	return name;
}

/** `/language`: hidden per-run messages switch the response language, so a switch never touches the cached prompt. */
export default function languageExtension(pi: ExtensionAPI): void {
	async function writePin({ base, fallback }: LanguageState, ctx: ExtensionContext): Promise<void> {
		if (base !== undefined) {
			pi.appendEntry<LanguageEntry>(ENTRY, fallback ? { base, fallback } : { base });
			return;
		}
		const configured = await readDefault(ctx);
		// The pin holds across the session, so conversation on any branch counts.
		if (!ctx.sessionManager.getEntries().some(isConversation)) {
			pi.appendEntry<LanguageEntry>(ENTRY, { base: configured ?? null });
			return;
		}
		// The session predates this extension and its prefix may be cached, so it must never gain a section.
		pi.appendEntry<LanguageEntry>(ENTRY, configured ? { base: null, fallback: configured } : { base: null });
	}

	function reset(ctx: ExtensionContext, configured: string | undefined): void {
		const state = readBranch(ctx);
		// Before the first run, the default that run will pin stands in for the pin.
		const base = state.base === undefined ? configured : sessionDefault(state);
		const switched = isSwitched({ active: state.active, base });
		if (state.active === undefined || (state.base !== undefined && !switched)) {
			ctx.ui.notify("No language switch is active.", "info");
			return;
		}
		pi.appendEntry<LanguageEntry>(ENTRY, switched ? { active: null, reset: true } : { active: null });
		ctx.ui.notify(`Language reset${base ? ` to ${base}` : ""}. Takes effect with the next prompt.`, "info");
	}

	function switchTo(value: string, ctx: ExtensionContext, configured: string | undefined): void {
		const name = validName(value);
		if (!name) {
			warnInvalidName(ctx);
			return;
		}
		const base = sessionDefault(readBranch(ctx));
		if (base && sameName(name, base)) {
			reset(ctx, configured);
			return;
		}
		pi.appendEntry<LanguageEntry>(ENTRY, { active: name });
		ctx.ui.notify(`Language switched to ${name}. Takes effect with the next prompt.`, "info");
	}

	function report(ctx: ExtensionContext, configured: string | undefined): void {
		const state = readBranch(ctx);
		const pinned = state.base === undefined ? "not pinned yet" : sessionDefault(state) ?? "none";
		ctx.ui.notify(`Active language: ${statusLabel(state, configured) ?? "none"}\nSession default: ${pinned}\nDefault for new sessions: ${configured ?? "none"}`, "info");
	}

	async function showBranch(_event: unknown, ctx: ExtensionContext): Promise<void> {
		if (!isEligible(ctx)) return;
		const state = readBranch(ctx);
		setStatus(ctx, statusLabel(state, state.base === undefined ? await readDefault(ctx) : undefined));
	}

	pi.on("session_start", showBranch);
	pi.on("session_tree", showBranch);

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isEligible(ctx)) return undefined;
		let state = readBranch(ctx);
		if (!state.pinned) {
			await writePin(state, ctx);
			state = readBranch(ctx);
			setStatus(ctx, state.active);
		}
		// Set on every run: Pi diffs each run's sections against the transcript, so a missing one would be removed.
		if (state.base) event.systemPromptOptions.sections.language = sectionText(state.base);
		if (state.resetPending) return hidden(resetText(sessionDefault(state)));
		if (isSwitched(state)) return hidden(switchText(state.active!));
		return undefined;
	});

	pi.registerCommand("language", {
		description: "Show or switch the response language: /language [<name> | reset | default [<name> | off]]",
		handler: async (args, ctx) => {
			if (!isEligible(ctx)) {
				ctx.ui.notify("/language works only in top-level TUI and RPC sessions.", "warning");
				return;
			}
			const text = args.trim();
			// Names stay untrimmed for `validName`. Whatever follows the one separator belongs to the name.
			const defaultArgs = /^\s*default(?:\s([\s\S]*))?$/i.exec(args);
			const value = defaultArgs?.[1]?.trim() ? defaultArgs[1] : undefined;
			const configured = value ? await changeDefault(value, ctx) : await readDefault(ctx);
			if (defaultArgs) {
				if (!value) ctx.ui.notify(`Default for new sessions: ${configured ?? "none"}.`, "info");
			} else if (!text) report(ctx, configured);
			else if (text.toLowerCase() === "reset") reset(ctx, configured);
			else switchTo(args, ctx, configured);
			setStatus(ctx, statusLabel(readBranch(ctx), configured));
		},
	});
}
