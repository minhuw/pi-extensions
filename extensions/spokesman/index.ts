import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	buildSpokesmanPrompt,
	evaluateProseForSpokesman,
	stripNonProse,
	type ProseEvaluation,
	type SpokesmanMode,
	type SpokesmanPromptInput,
	type TurnWorkItem,
} from "./filter.ts";
import {
	createSpokesmanEntryRenderer,
	formatSpokesmanSeparator,
	hasNerdFonts,
	type SpokesmanRewriteData,
} from "./ui.ts";

export const SPOKESMAN_STATE_ENTRY = "spokesman";
export const SPOKESMAN_REWRITE_ENTRY = "spokesman-rewrite";
export const HIDDEN_ORIGINAL_MARKER = "<!-- spokesman:rewritten -->\n";

export {
	buildSpokesmanPrompt,
	evaluateProseForSpokesman,
	stripNonProse,
	type ProseEvaluation,
	type SpokesmanMode,
	type SpokesmanPromptInput,
	type TurnWorkItem,
} from "./filter.ts";
export {
	createSpokesmanEntryRenderer,
	formatSpokesmanSeparator,
	hasNerdFonts,
	type SpokesmanRewriteData,
} from "./ui.ts";

const SESSION_LINK_TYPE = "pi-extensions.session-link";
const RESERVED_SUBCOMMANDS = new Set([
	"off",
	"reset",
	"default",
	"status",
	"mode",
	"auto",
	"always",
	"rewrite",
	"now",
	"for",
]);

type SpokesmanPin = {
	base: string | null;
	baseMode?: SpokesmanMode;
};

type SpokesmanSwitch = {
	active?: string | null;
	mode?: SpokesmanMode;
	reset?: true;
};

type SpokesmanEntry = SpokesmanPin | SpokesmanSwitch;

interface SpokesmanBranchState {
	base: string | null | undefined;
	baseMode: SpokesmanMode | undefined;
	pinned: boolean;
	switchedOff: boolean;
	switchActive: string | undefined;
	switchMode: SpokesmanMode | undefined;
}

interface SpokesmanConfig {
	default: string | undefined;
	mode: SpokesmanMode;
	/** Main-model patterns spokesman runs for; undefined means every main model. */
	mainModels: string[] | undefined;
}

interface TrackedWorkItem extends TurnWorkItem {
	toolCallId?: string;
}

const configPath = () => join(getAgentDir(), "spokesman.json");

function isMode(value: unknown): value is SpokesmanMode {
	return value === "auto" || value === "always";
}

function validModelSpec(value: string): string | undefined {
	if (/\p{Cc}/u.test(value)) return undefined;
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 120) return undefined;
	if (/\s/.test(trimmed)) return undefined;
	if (RESERVED_SUBCOMMANDS.has(trimmed.toLowerCase())) return undefined;
	return trimmed;
}

function validModelPattern(value: string): string | undefined {
	if (/\p{Cc}/u.test(value)) return undefined;
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 120) return undefined;
	if (/\s/.test(trimmed)) return undefined;
	return trimmed;
}

function parseMainModels(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const patterns: string[] = [];
	for (const item of value) {
		const pattern = typeof item === "string" ? validModelPattern(item) : undefined;
		if (!pattern) return undefined;
		if (!patterns.includes(pattern)) patterns.push(pattern);
	}
	return patterns;
}

/**
 * Matches a main-model pattern case-insensitively, with `*` as a wildcard. A pattern with a
 * slash matches `provider/id` (or an id that itself contains a slash); otherwise it matches the id.
 */
export function matchesModelPattern(
	pattern: string,
	model: { id?: string; provider?: string },
): boolean {
	if (!model.id) return false;
	const lowerPattern = pattern.trim().toLowerCase();
	const regex = new RegExp(
		`^${lowerPattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	);
	const targets = lowerPattern.includes("/")
		? [`${model.provider ?? ""}/${model.id}`, model.id]
		: [model.id];
	return targets.some((target) => regex.test(target.toLowerCase()));
}

function formatMainModels(mainModels: readonly string[] | undefined): string {
	return mainModels?.length ? mainModels.join(", ") : "all";
}

export function isMainModelEnabled(
	mainModels: readonly string[] | undefined,
	model: { id?: string; provider?: string } | undefined,
): boolean {
	if (!mainModels || mainModels.length === 0) return true;
	if (!model?.id) return false;
	return mainModels.some((pattern) => matchesModelPattern(pattern, model));
}

export function shortModelName(spec: string): string {
	const trimmed = spec.trim();
	const slashIndex = trimmed.indexOf("/");
	return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

export function isSameAsMainModel(
	activeSpec: string | undefined,
	ctx: ExtensionContext,
	mainModel?: { id?: string; provider?: string },
): boolean {
	if (!activeSpec) return false;
	const targetMain = mainModel ?? ctx.model;
	if (!targetMain?.id) return false;

	const resolved = resolveSpokesmanModel(activeSpec, ctx);
	if (resolved) {
		if (resolved.id.toLowerCase() !== targetMain.id.toLowerCase()) return false;
		if (targetMain.provider && resolved.provider) {
			return resolved.provider.toLowerCase() === targetMain.provider.toLowerCase();
		}
		return true;
	}

	const trimmed = activeSpec.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex >= 0) {
		const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
		const modelId = trimmed.slice(slashIndex + 1).trim().toLowerCase();
		if (modelId !== targetMain.id.toLowerCase()) return false;
		return !targetMain.provider || provider === targetMain.provider.toLowerCase();
	}
	return trimmed.toLowerCase() === targetMain.id.toLowerCase();
}

function formatStatusLabel(
	activeModel: string | undefined,
	mode: SpokesmanMode,
	mainModels: readonly string[] | undefined,
	ctx: ExtensionContext,
	rewriting = false,
): string | undefined {
	if (!activeModel || isSameAsMainModel(activeModel, ctx)) return undefined;
	if (!isMainModelEnabled(mainModels, ctx.model)) return undefined;
	const short = shortModelName(activeModel);
	if (rewriting) return `${short} · rewriting…`;
	return mode === "always" ? `${short} · always` : short;
}

function setStatus(ctx: ExtensionContext, label: string | undefined): void {
	try {
		ctx.ui.setStatus(SPOKESMAN_STATE_ENTRY, label);
	} catch {}
}

function isPinEntry(entry: SessionEntry): entry is CustomEntry<SpokesmanPin> {
	return (
		entry.type === "custom" &&
		entry.customType === SPOKESMAN_STATE_ENTRY &&
		Boolean(entry.data) &&
		typeof entry.data === "object" &&
		"base" in (entry.data as SpokesmanEntry)
	);
}

function readBranch(ctx: ExtensionContext): SpokesmanBranchState {
	let pin: SpokesmanPin | undefined;
	let latestActive: SpokesmanSwitch | undefined;
	let latestMode: SpokesmanMode | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SPOKESMAN_STATE_ENTRY) continue;
		const data = entry.data as SpokesmanEntry | undefined;
		if (!data || typeof data !== "object") continue;
		if ("base" in data) {
			pin = data;
		} else {
			if (data.reset) {
				latestActive = undefined;
				latestMode = undefined;
			} else {
				if ("active" in data) {
					latestActive = data;
				}
				if (isMode(data.mode)) {
					latestMode = data.mode;
				}
			}
		}
	}

	const pinned = pin !== undefined;
	const sessionPin = pin ?? ctx.sessionManager.getEntries().find(isPinEntry)?.data;
	const base = sessionPin?.base;
	const baseMode = sessionPin?.baseMode;

	const switchedOff =
		latestActive !== undefined && !latestActive.reset && latestActive.active === null;
	const switchActive =
		latestActive !== undefined &&
		!latestActive.reset &&
		typeof latestActive.active === "string"
			? latestActive.active
			: undefined;

	return {
		base,
		baseMode,
		pinned,
		switchedOff,
		switchActive,
		switchMode: latestMode,
	};
}

function effectiveActive(
	state: SpokesmanBranchState,
	configured: SpokesmanConfig,
): string | undefined {
	if (state.switchedOff) return undefined;
	if (state.switchActive !== undefined) return state.switchActive;
	if (state.base !== undefined) return state.base ?? undefined;
	return configured.default;
}

function effectiveMode(
	state: SpokesmanBranchState,
	configured: SpokesmanConfig,
): SpokesmanMode {
	return state.switchMode ?? state.baseMode ?? configured.mode ?? "auto";
}

function isEligible(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return !ctx.sessionManager
		.getEntries()
		.some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

async function readConfig(ctx: ExtensionContext): Promise<SpokesmanConfig> {
	const path = configPath();
	try {
		const rawText = await readFile(path, "utf8");
		const parsed = JSON.parse(rawText) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as { default?: unknown; mode?: unknown; mainModels?: unknown };
			const hasDefault = record.default !== undefined;
			const hasMode = record.mode !== undefined;
			const hasMainModels = record.mainModels !== undefined;
			const validDefault =
				typeof record.default === "string" ? validModelSpec(record.default) : undefined;
			const validMode = isMode(record.mode) ? record.mode : undefined;
			const validMainModels = parseMainModels(record.mainModels);

			if (
				(hasDefault || hasMode || hasMainModels) &&
				(!hasDefault || validDefault !== undefined) &&
				(!hasMode || validMode !== undefined) &&
				(!hasMainModels || validMainModels !== undefined)
			) {
				return {
					default: validDefault,
					mode: validMode ?? "auto",
					mainModels: validMainModels?.length ? validMainModels : undefined,
				};
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { default: undefined, mode: "auto", mainModels: undefined };
		}
	}
	ctx.ui.notify(
		`Ignoring ${path}: expected { "default"?: "<model>", "mode"?: "auto" | "always", "mainModels"?: ["<pattern>", ...] }.`,
		"warning",
	);
	return { default: undefined, mode: "auto", mainModels: undefined };
}

async function writeConfig(next: {
	default?: string;
	mode?: SpokesmanMode;
	mainModels?: string[];
}): Promise<void> {
	const path = configPath();
	if (!next.default && (!next.mode || next.mode === "auto") && !next.mainModels?.length) {
		await rm(path, { force: true });
		return;
	}
	const payload: { default?: string; mode?: SpokesmanMode; mainModels?: string[] } = {};
	if (next.default) payload.default = next.default;
	if (next.mode) payload.mode = next.mode;
	if (next.mainModels?.length) payload.mainModels = next.mainModels;

	const temporary = `${path}.${randomUUID()}.tmp`;
	await mkdir(getAgentDir(), { recursive: true });
	try {
		await writeFile(temporary, `${JSON.stringify(payload)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

type LanguagePin = { base: string | null; fallback?: string };
type LanguageEntry = LanguagePin | { active: string | null; reset?: true };

const isLanguagePin = (entry: SessionEntry): entry is CustomEntry<LanguagePin> =>
	entry.type === "custom" &&
	entry.customType === "language" &&
	typeof entry.data === "object" &&
	entry.data !== null &&
	"base" in entry.data;

/**
 * The language in effect, as the language extension computes it: the latest switch on the current branch, else the
 * branch's pin, else the session's first pin, since a branch `/tree` moved to before the pin keeps the session's default.
 * A reset or a null `active` follows the pin. Mirrors `readBranch` in extensions/language/index.ts, the source of truth.
 */
function readActiveLanguage(ctx: ExtensionContext): string | undefined {
	let pin: LanguagePin | undefined;
	let latest: Extract<LanguageEntry, { active: unknown }> | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "language") continue;
		const data = entry.data as LanguageEntry | undefined;
		if (!data || typeof data !== "object") continue;
		if ("base" in data) pin = data;
		else latest = data;
	}
	const { base, fallback }: Partial<LanguagePin> = pin ?? ctx.sessionManager.getEntries().find(isLanguagePin)?.data ?? {};
	return latest?.active ?? base ?? fallback;
}

export function resolveSpokesmanModel(
	spec: string,
	ctx: ExtensionContext,
): Model<Api> | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;

	const registry = ctx.modelRegistry;
	const scoped = (ctx.scopedModels ?? []).map((entry) => entry.model);
	const available = typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
	const all = typeof registry?.getAll === "function" ? registry.getAll() : [];
	const candidates = [...scoped, ...available, ...all];

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex >= 0) {
		const provider = trimmed.slice(0, slashIndex).trim();
		const modelId = trimmed.slice(slashIndex + 1).trim();
		if (!provider || !modelId) return undefined;

		if (typeof registry?.find === "function") {
			const exact = registry.find(provider, modelId);
			if (exact) return exact;
		}
		const lowerProvider = provider.toLowerCase();
		const lowerId = modelId.toLowerCase();
		return candidates.find(
			(m) => m.provider.toLowerCase() === lowerProvider && m.id.toLowerCase() === lowerId,
		);
	}

	const lowerSpec = trimmed.toLowerCase();
	const exactMatch = candidates.find((m) => m.id === trimmed);
	if (exactMatch) return exactMatch;

	const caseMatch = candidates.find((m) => m.id.toLowerCase() === lowerSpec);
	if (caseMatch) return caseMatch;

	if (ctx.model?.provider && typeof registry?.find === "function") {
		const sameProvider = registry.find(ctx.model.provider, trimmed);
		if (sameProvider) return sameProvider;
	}

	return undefined;
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				Boolean(part) &&
				typeof part === "object" &&
				(part as { type?: string }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n\n");
}

function stripHiddenOriginalMarker(text: string): string {
	if (text.startsWith(HIDDEN_ORIGINAL_MARKER)) {
		return text.slice(HIDDEN_ORIGINAL_MARKER.length);
	}
	if (text.startsWith(HIDDEN_ORIGINAL_MARKER.trim())) {
		return text.slice(HIDDEN_ORIGINAL_MARKER.trim().length).replace(/^\n/, "");
	}
	return text;
}

function summarizeToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") {
		return typeof args === "string" ? args.slice(0, 120) : toolName;
	}
	const record = args as Record<string, unknown>;
	if (typeof record.command === "string") {
		return record.command.replace(/\s+/g, " ").trim().slice(0, 140);
	}
	if (typeof record.path === "string") {
		return record.path.trim().slice(0, 140);
	}
	if (typeof record.pattern === "string") {
		const pathSuffix = typeof record.path === "string" ? ` in ${record.path}` : "";
		return `${record.pattern}${pathSuffix}`.slice(0, 140);
	}
	if (typeof record.query === "string") {
		return record.query.trim().slice(0, 140);
	}
	if (typeof record.url === "string") {
		return record.url.trim().slice(0, 140);
	}
	try {
		return JSON.stringify(args).slice(0, 140);
	} catch {
		return toolName;
	}
}

function compactExcerpt(text: string, maxChars = 220): string | undefined {
	const cleaned = text.replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

function extractDialogueAndWorkFromBranch(
	ctx: ExtensionContext,
	upToEntryId?: string,
): {
	userRequest: string;
	recentDialogue?: string;
	workItems: TurnWorkItem[];
} {
	const branch = ctx.sessionManager.getBranch();
	const endIndex = upToEntryId
		? branch.findIndex((entry) => entry.id === upToEntryId)
		: branch.length - 1;
	const relevantEntries = endIndex >= 0 ? branch.slice(0, endIndex + 1) : branch;

	let lastUserIndex = -1;
	let userRequest = "";
	for (let i = relevantEntries.length - 1; i >= 0; i--) {
		const entry = relevantEntries[i]!;
		if (entry.type === "message" && entry.message.role === "user") {
			userRequest = extractTextFromContent(entry.message.content).trim();
			lastUserIndex = i;
			break;
		}
		if (entry.type === "custom_message" && entry.display) {
			userRequest = extractTextFromContent(entry.content).trim();
			lastUserIndex = i;
			break;
		}
	}

	const dialogueLines: string[] = [];
	const dialogueEnd = lastUserIndex >= 0 ? lastUserIndex : relevantEntries.length;
	for (let i = Math.max(0, dialogueEnd - 8); i < dialogueEnd; i++) {
		const entry = relevantEntries[i]!;
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			const text = compactExcerpt(extractTextFromContent(entry.message.content), 260);
			if (text) dialogueLines.push(`User: ${text}`);
		} else if (entry.message.role === "assistant") {
			const raw = stripHiddenOriginalMarker(extractTextFromContent(entry.message.content));
			const text = compactExcerpt(raw, 260);
			if (text) dialogueLines.push(`Assistant: ${text}`);
		}
	}

	const toolArgsById = new Map<string, { name: string; summary: string }>();
	const workItems: TurnWorkItem[] = [];
	const workStart = lastUserIndex >= 0 ? lastUserIndex + 1 : 0;

	for (let i = workStart; i < relevantEntries.length; i++) {
		const entry = relevantEntries[i]!;
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block && typeof block === "object" && (block as ToolCall).type === "toolCall") {
					const tc = block as ToolCall;
					toolArgsById.set(tc.id, {
						name: tc.name,
						summary: summarizeToolArgs(tc.name, tc.arguments),
					});
				}
			}
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const callInfo = toolArgsById.get(tr.toolCallId);
			const outputText = extractTextFromContent(tr.content);
			workItems.push({
				toolName: tr.toolName || callInfo?.name || "tool",
				summary: callInfo?.summary ?? tr.toolName,
				outputExcerpt: compactExcerpt(outputText),
				isError: tr.isError,
			});
		}
	}

	return {
		userRequest,
		recentDialogue: dialogueLines.length > 0 ? dialogueLines.slice(-4).join("\n") : undefined,
		workItems,
	};
}

async function callSpokesmanModel(
	model: Model<Api>,
	prompt: { systemPrompt: string; userPrompt: string },
	ctx: ExtensionContext,
): Promise<{ text: string; usage?: Usage; provider?: string } | undefined> {
	const context: Context = {
		systemPrompt: prompt.systemPrompt,
		messages: [
			{
				role: "user",
				content: prompt.userPrompt,
				timestamp: Date.now(),
			},
		],
	};

	const registry = ctx.modelRegistry;
	if (typeof registry?.streamSimple === "function") {
		const stream = registry.streamSimple(model, context, { signal: ctx.signal });
		let streamedText = "";
		try {
			for await (const event of stream) {
				if (event.type === "text_delta" && typeof event.delta === "string") {
					streamedText += event.delta;
					if (ctx.mode === "tui" && streamedText.trim()) {
						try {
							const previewLines = streamedText.trim().split("\n").slice(-6);
							ctx.ui.setWidget("spokesman-live", [
								`─── Spokesman · ${model.id} (rewriting…) ───`,
								...previewLines,
							]);
						} catch {}
					}
				}
			}
		} finally {
			if (ctx.mode === "tui") {
				try {
					ctx.ui.setWidget("spokesman-live", undefined);
				} catch {}
			}
		}
		const finalMessage = await stream.result();
		if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
			return undefined;
		}
		const finalText = extractTextFromContent(finalMessage.content).trim() || streamedText.trim();
		if (!finalText) return undefined;
		return {
			text: finalText,
			usage: finalMessage.usage,
			provider: finalMessage.provider ?? model.provider,
		};
	}

	if (typeof registry?.complete === "function") {
		const finalMessage = await registry.complete(model, context, { signal: ctx.signal });
		if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
			return undefined;
		}
		const finalText = extractTextFromContent(finalMessage.content).trim();
		if (!finalText) return undefined;
		return {
			text: finalText,
			usage: finalMessage.usage,
			provider: finalMessage.provider ?? model.provider,
		};
	}

	return undefined;
}

function collectSessionStats(ctx: ExtensionContext): {
	rewrites: number;
	turns: number;
	inTokens: number;
	outTokens: number;
	cost: number;
} {
	let fallbackRewriteCount = 0;
	const rewrittenTargets = new Set<string>();
	let turns = 0;
	let inTokens = 0;
	let outTokens = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const msg = entry.message as AssistantMessage;
			const hasToolCall =
				Array.isArray(msg.content) && msg.content.some((part) => part.type === "toolCall");
			if (msg.stopReason === "stop" && !hasToolCall) {
				turns++;
			}
		} else if (entry.type === "custom" && entry.customType === SPOKESMAN_REWRITE_ENTRY) {
			const data = entry.data as SpokesmanRewriteData | undefined;
			if (!data) continue;
			if (data.targetEntryId) rewrittenTargets.add(data.targetEntryId);
			else fallbackRewriteCount++;
			if (data.usage) {
				inTokens +=
					(data.usage.input ?? 0) +
					(data.usage.cacheRead ?? 0) +
					(data.usage.cacheWrite ?? 0);
				outTokens += data.usage.output ?? 0;
				cost += data.usage.cost?.total ?? 0;
			}
		}
	}

	const rewrites = rewrittenTargets.size + fallbackRewriteCount;
	return { rewrites, turns, inTokens, outTokens, cost };
}

export default function spokesmanExtension(pi: ExtensionAPI): void {
	const rewrittenTargetIds = new Set<string>();
	const latestRewriteByTargetId = new Map<string, { entryId: string; data: SpokesmanRewriteData }>();
	const supersededRewriteEntryIds = new Set<string>();
	const warnedMissingModels = new Set<string>();
	let currentTurnWorkItems: TrackedWorkItem[] = [];
	let pendingRewrite: Omit<SpokesmanRewriteData, "targetEntryId"> | undefined;

	function syncRewriteRecordsFromBranch(ctx: ExtensionContext): void {
		rewrittenTargetIds.clear();
		latestRewriteByTargetId.clear();
		supersededRewriteEntryIds.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SPOKESMAN_REWRITE_ENTRY) continue;
			const data = entry.data as SpokesmanRewriteData | undefined;
			if (!data) continue;
			if (data.targetEntryId) {
				rewrittenTargetIds.add(data.targetEntryId);
				const previous = latestRewriteByTargetId.get(data.targetEntryId);
				if (previous) {
					supersededRewriteEntryIds.add(previous.entryId);
				}
				latestRewriteByTargetId.set(data.targetEntryId, { entryId: entry.id, data });
			}
		}
	}

	async function syncBranchStatus(ctx: ExtensionContext): Promise<void> {
		syncRewriteRecordsFromBranch(ctx);
		if (!isEligible(ctx)) return;
		const state = readBranch(ctx);
		const configured = await readConfig(ctx);
		const active = effectiveActive(state, configured);
		const mode = effectiveMode(state, configured);
		setStatus(ctx, formatStatusLabel(active, mode, configured.mainModels, ctx));
	}

	pi.registerEntryRenderer(
		SPOKESMAN_REWRITE_ENTRY,
		createSpokesmanEntryRenderer(1, (entryId) => supersededRewriteEntryIds.has(entryId)),
	);

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "assistant") {
			if (
				markdown.startsWith(HIDDEN_ORIGINAL_MARKER) ||
				markdown.startsWith(HIDDEN_ORIGINAL_MARKER.trim())
			) {
				return "";
			}
			if (context.messageId && rewrittenTargetIds.has(context.messageId)) {
				return "";
			}
		}
		return markdown;
	});

	pi.on("session_start", async (_event, ctx) => {
		currentTurnWorkItems = [];
		pendingRewrite = undefined;
		await syncBranchStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentTurnWorkItems = [];
		pendingRewrite = undefined;
		await syncBranchStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await syncBranchStatus(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentTurnWorkItems = [];
		pendingRewrite = undefined;
		if (!isEligible(ctx)) return undefined;

		let state = readBranch(ctx);
		const configured = await readConfig(ctx);
		if (!state.pinned) {
			const pinBase = state.base !== undefined ? state.base : (configured.default ?? null);
			const pinMode = state.baseMode ?? configured.mode ?? "auto";
			pi.appendEntry<SpokesmanEntry>(SPOKESMAN_STATE_ENTRY, {
				base: pinBase,
				baseMode: pinMode,
			});
			state = readBranch(ctx);
		}
		const active = effectiveActive(state, configured);
		const mode = effectiveMode(state, configured);
		setStatus(ctx, formatStatusLabel(active, mode, configured.mainModels, ctx));
		return undefined;
	});

	pi.on("tool_execution_start", (event) => {
		currentTurnWorkItems.push({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			summary: summarizeToolArgs(event.toolName, event.args),
		});
	});

	pi.on("tool_execution_end", (event) => {
		const resultText =
			event.result && typeof event.result === "object"
				? extractTextFromContent((event.result as { content?: unknown }).content)
				: typeof event.result === "string"
					? event.result
					: "";
		const existing = currentTurnWorkItems.find((item) => item.toolCallId === event.toolCallId);
		if (existing) {
			existing.outputExcerpt = compactExcerpt(resultText);
			existing.isError = event.isError;
		} else {
			currentTurnWorkItems.push({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				summary: event.toolName,
				outputExcerpt: compactExcerpt(resultText),
				isError: event.isError,
			});
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isEligible(ctx)) return undefined;
		if (event.message.role !== "assistant") return undefined;

		const msg = event.message as AssistantMessage;
		if (msg.stopReason !== "stop") return undefined;
		if (!Array.isArray(msg.content)) return undefined;
		if (msg.content.some((part) => part.type === "toolCall")) return undefined;

		const rawText = extractTextFromContent(msg.content).trim();
		if (!rawText) return undefined;
		if (
			rawText.startsWith(HIDDEN_ORIGINAL_MARKER) ||
			rawText.startsWith(HIDDEN_ORIGINAL_MARKER.trim())
		) {
			return undefined;
		}

		const state = readBranch(ctx);
		const configured = await readConfig(ctx);
		const activeSpec = effectiveActive(state, configured);
		const mode = effectiveMode(state, configured);
		if (!activeSpec) return undefined;

		const originalModelId = msg.model || ctx.model?.id || "assistant";
		const originalProvider = msg.provider || ctx.model?.provider;
		if (
			!isMainModelEnabled(configured.mainModels, {
				id: msg.model || ctx.model?.id,
				provider: originalProvider,
			})
		) {
			return undefined;
		}

		const spokesmanModel = resolveSpokesmanModel(activeSpec, ctx);
		if (!spokesmanModel) {
			if (!warnedMissingModels.has(activeSpec)) {
				warnedMissingModels.add(activeSpec);
				ctx.ui.notify(
					`Spokesman model "${activeSpec}" was not found. Skipping rewrite.`,
					"warning",
				);
			}
			return undefined;
		}

		if (
			typeof ctx.modelRegistry?.hasConfiguredAuth === "function" &&
			!ctx.modelRegistry.hasConfiguredAuth(spokesmanModel)
		) {
			const authKey = `auth:${spokesmanModel.provider}/${spokesmanModel.id}`;
			if (!warnedMissingModels.has(authKey)) {
				warnedMissingModels.add(authKey);
				ctx.ui.notify(
					`No credentials configured for spokesman model "${spokesmanModel.provider}/${spokesmanModel.id}". Skipping rewrite.`,
					"warning",
				);
			}
			return undefined;
		}

		if (isSameAsMainModel(activeSpec, ctx, { id: originalModelId, provider: originalProvider })) {
			return undefined;
		}

		const branchContext = extractDialogueAndWorkFromBranch(ctx);
		const workItems: TurnWorkItem[] =
			currentTurnWorkItems.length > 0 ? currentTurnWorkItems : branchContext.workItems;

		const evaluation = evaluateProseForSpokesman(rawText, workItems);
		if (mode === "auto" && !evaluation.rewrite) {
			return undefined;
		}

		const prompt = buildSpokesmanPrompt({
			userRequest: branchContext.userRequest,
			recentDialogue: branchContext.recentDialogue,
			workItems,
			draftReply: rawText,
			originalModel: originalModelId,
			language: readActiveLanguage(ctx),
		});

		const startTime = Date.now();
		setStatus(ctx, formatStatusLabel(activeSpec, mode, configured.mainModels, ctx, true));
		try {
			ctx.ui.setWorkingMessage(`Spokesman (${spokesmanModel.id}) rewriting…`);
		} catch {}

		try {
			const result = await callSpokesmanModel(spokesmanModel, prompt, ctx);
			const rewrittenText = result?.text.trim();
			if (!rewrittenText) {
				return undefined;
			}

			pendingRewrite = {
				originalText: rawText,
				rewrittenText,
				originalModel: originalModelId,
				spokesmanModel: spokesmanModel.id,
				spokesmanProvider: spokesmanModel.provider,
				mode,
				signals:
					mode === "always" && evaluation.signals.length === 0
						? ["always"]
						: evaluation.signals,
				usage: result?.usage,
				provider: result?.provider ?? spokesmanModel.provider,
				durationMs: Date.now() - startTime,
				timestamp: Date.now(),
			};
			const nonTextBlocks = msg.content.filter((part) => part.type !== "text");
			const replacedTextBlock: TextContent = {
				type: "text",
				text: `${HIDDEN_ORIGINAL_MARKER}${rewrittenText}`,
			};

			return {
				message: {
					...msg,
					content: [...nonTextBlocks, replacedTextBlock],
				},
			};
		} catch {
			return undefined;
		} finally {
			try {
				ctx.ui.setWorkingMessage();
			} catch {}
			setStatus(ctx, formatStatusLabel(activeSpec, mode, configured.mainModels, ctx, false));
		}
	});

	pi.on("turn_end", async (event) => {
		const msg = event.message as Partial<AssistantMessage> | undefined;
		if (msg?.role === "assistant" && msg.stopReason !== "toolUse") {
			currentTurnWorkItems = [];
		}
		if (!pendingRewrite) return undefined;

		const rewrite = pendingRewrite;
		pendingRewrite = undefined;
		if (event.messageEntryId) {
			rewrittenTargetIds.add(event.messageEntryId);
		}
		const data: SpokesmanRewriteData = {
			...rewrite,
			targetEntryId: event.messageEntryId,
		};
		return {
			entries: [
				...event.entries,
				{
					type: "custom",
					customType: SPOKESMAN_REWRITE_ENTRY,
					data,
				},
			],
		};
	});

	pi.on("context", async (event, ctx) => {
		syncRewriteRecordsFromBranch(ctx);
		const branch = ctx.sessionManager.getBranch();
		// Map assistant message entries on the branch in the order Pi sends them: after the latest
		// compaction (if any), the entries kept from its firstKeptEntryId, then the entries after it.
		let contextEntries = branch;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "compaction") continue;
			const firstKeptIdx = branch.findIndex((kept) => kept.id === entry.firstKeptEntryId);
			contextEntries = [
				...(firstKeptIdx >= 0 && firstKeptIdx < i ? branch.slice(firstKeptIdx, i) : []),
				...branch.slice(i + 1),
			];
			break;
		}
		const branchAssistantEntries = contextEntries.filter(
			(entry): entry is SessionEntry & { type: "message"; message: AssistantMessage } =>
				entry.type === "message" && entry.message.role === "assistant",
		);

		let changed = false;
		let nextEntryIdx = 0;

		const messages = event.messages.map((message) => {
			if (message.role !== "assistant") return message;
			const assistantMsg = message as AssistantMessage;
			// Pi sends copies and may leave an entry out, so pair a message with the next entry that
			// stores the same response. A message without such an entry gets no rewrite.
			const entryIdx = branchAssistantEntries.findIndex(
				(entry, idx) =>
					idx >= nextEntryIdx &&
					typeof assistantMsg.timestamp === "number" &&
					entry.message.timestamp === assistantMsg.timestamp,
			);
			const branchEntry = entryIdx >= 0 ? branchAssistantEntries[entryIdx] : undefined;
			if (entryIdx >= 0) nextEntryIdx = entryIdx + 1;
			if (!Array.isArray(assistantMsg.content)) return message;

			const targetRewrite = branchEntry
				? latestRewriteByTargetId.get(branchEntry.id)?.data.rewrittenText
				: undefined;

			let messageModified = false;
			const nextContent = assistantMsg.content.map((block) => {
				if (block.type !== "text") return block;
				if (targetRewrite !== undefined) {
					if (block.text !== targetRewrite) {
						messageModified = true;
						return { ...block, text: targetRewrite };
					}
					return block;
				}
				if (
					block.text.startsWith(HIDDEN_ORIGINAL_MARKER) ||
					block.text.startsWith(HIDDEN_ORIGINAL_MARKER.trim())
				) {
					messageModified = true;
					return {
						...block,
						text: stripHiddenOriginalMarker(block.text),
					};
				}
				return block;
			});

			if (!messageModified) return message;
			changed = true;
			return {
				...assistantMsg,
				content: nextContent,
			} as Message;
		});

		return changed ? { messages } : undefined;
	});

	async function rewriteLatestResponse(
		overrideModelSpec: string | undefined,
		ctx: ExtensionContext,
	): Promise<void> {
		const configured = await readConfig(ctx);
		const state = readBranch(ctx);
		const activeSpec = overrideModelSpec?.trim() || effectiveActive(state, configured);
		const mode = effectiveMode(state, configured);

		if (!activeSpec) {
			ctx.ui.notify(
				"No spokesman model is active. Configure one with /spokesman <model> first.",
				"warning",
			);
			return;
		}

		const spokesmanModel = resolveSpokesmanModel(activeSpec, ctx);
		if (!spokesmanModel) {
			ctx.ui.notify(`Spokesman model "${activeSpec}" was not found.`, "warning");
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		let targetEntry: (SessionEntry & { type: "message"; message: AssistantMessage }) | undefined;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const msg = entry.message as AssistantMessage;
				const hasToolCall =
					Array.isArray(msg.content) && msg.content.some((part) => part.type === "toolCall");
				if (!hasToolCall && extractTextFromContent(msg.content).trim()) {
					targetEntry = entry as SessionEntry & {
						type: "message";
						message: AssistantMessage;
					};
					break;
				}
			}
		}

		if (!targetEntry) {
			ctx.ui.notify("No assistant response found on the current branch to rewrite.", "warning");
			return;
		}

		let originalText = stripHiddenOriginalMarker(
			extractTextFromContent(targetEntry.message.content),
		).trim();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type === "custom" && entry.customType === SPOKESMAN_REWRITE_ENTRY) {
				const data = entry.data as SpokesmanRewriteData | undefined;
				if (data?.targetEntryId === targetEntry.id && data.originalText) {
					originalText = data.originalText;
					break;
				}
			}
		}

		const originalModelId = targetEntry.message.model || ctx.model?.id || "assistant";
		const originalProvider = targetEntry.message.provider || ctx.model?.provider;
		if (isSameAsMainModel(activeSpec, ctx, { id: originalModelId, provider: originalProvider })) {
			ctx.ui.notify(
				`Spokesman is disabled because the main model is already ${spokesmanModel.id}.`,
				"info",
			);
			return;
		}

		const branchContext = extractDialogueAndWorkFromBranch(ctx, targetEntry.id);
		const evaluation = evaluateProseForSpokesman(originalText, branchContext.workItems);
		const prompt = buildSpokesmanPrompt({
			userRequest: branchContext.userRequest,
			recentDialogue: branchContext.recentDialogue,
			workItems: branchContext.workItems,
			draftReply: originalText,
			originalModel: originalModelId,
			language: readActiveLanguage(ctx),
		});

		const startTime = Date.now();
		setStatus(ctx, formatStatusLabel(activeSpec, mode, configured.mainModels, ctx, true));
		try {
			ctx.ui.setWorkingMessage(`Spokesman (${spokesmanModel.id}) rewriting…`);
		} catch {}

		try {
			const result = await callSpokesmanModel(spokesmanModel, prompt, ctx);
			const rewrittenText = result?.text.trim();
			if (!rewrittenText) {
				ctx.ui.notify("Spokesman rewrite produced no output.", "warning");
				return;
			}

			const data: SpokesmanRewriteData = {
				targetEntryId: targetEntry.id,
				originalText,
				rewrittenText,
				originalModel: originalModelId,
				spokesmanModel: spokesmanModel.id,
				spokesmanProvider: spokesmanModel.provider,
				mode,
				signals: evaluation.signals.length > 0 ? evaluation.signals : ["manual"],
				usage: result?.usage,
				provider: result?.provider ?? spokesmanModel.provider,
				durationMs: Date.now() - startTime,
				timestamp: Date.now(),
			};

			pi.appendEntry<SpokesmanRewriteData>(SPOKESMAN_REWRITE_ENTRY, data);
			syncRewriteRecordsFromBranch(ctx);
			ctx.ui.notify(`Rewrote the latest response with ${spokesmanModel.id}.`, "info");
		} finally {
			try {
				ctx.ui.setWorkingMessage();
			} catch {}
			setStatus(
				ctx,
				formatStatusLabel(effectiveActive(state, configured), mode, configured.mainModels, ctx, false),
			);
		}
	}

	function refreshStatus(ctx: ExtensionContext, configured: SpokesmanConfig): void {
		const state = readBranch(ctx);
		setStatus(
			ctx,
			formatStatusLabel(
				effectiveActive(state, configured),
				effectiveMode(state, configured),
				configured.mainModels,
				ctx,
			),
		);
	}

	function reportStatus(ctx: ExtensionContext, configured: SpokesmanConfig): void {
		const state = readBranch(ctx);
		const active = effectiveActive(state, configured);
		const activeDisplay = !active
			? "off"
			: isSameAsMainModel(active, ctx)
				? `${active} (disabled: same as main model)`
				: !isMainModelEnabled(configured.mainModels, ctx.model)
					? `${active} (inactive: main model ${ctx.model?.id ?? "unknown"} is not in the main-model list)`
					: active;
		const mode = effectiveMode(state, configured);
		const pinned = state.base === undefined ? "not pinned yet" : (state.base ?? "off");
		const stats = collectSessionStats(ctx);
		ctx.ui.notify(
			[
				`Active spokesman: ${activeDisplay}`,
				`Mode: ${mode}`,
				`Session default: ${pinned}`,
				`Default for new sessions: ${configured.default ?? "off"} (${configured.mode})`,
				`Main models: ${formatMainModels(configured.mainModels)}`,
				`Session rewrites: ${stats.rewrites}/${stats.turns} turns · ↑ ${stats.inTokens} ↓ ${stats.outTokens} · $${stats.cost.toFixed(3)}`,
			].join("\n"),
			"info",
		);
	}

	pi.registerCommand("spokesman", {
		description:
			"Configure or run the spokesman rewrite model: /spokesman [<model> | mode <auto|always> | rewrite | off | reset | for [<pattern>... | all] | default [<model> | mode <auto|always> | off]]",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const trimmed = prefix.trimStart();
			const subcommands: AutocompleteItem[] = [
				{ value: "status", label: "status", description: "Show spokesman status and token usage" },
				{ value: "mode auto", label: "mode auto", description: "Rewrite only dense or cryptic responses" },
				{ value: "mode always", label: "mode always", description: "Rewrite every final assistant response" },
				{ value: "rewrite", label: "rewrite", description: "Rewrite the latest assistant response now" },
				{ value: "off", label: "off", description: "Disable spokesman for this session" },
				{ value: "reset", label: "reset", description: "Return to this session's default spokesman" },
				{ value: "default", label: "default", description: "Show or set the default for new sessions" },
				{ value: "default off", label: "default off", description: "Remove the default for new sessions" },
				{ value: "for", label: "for", description: "Show or set the main models spokesman runs for" },
				{ value: "for all", label: "for all", description: "Run spokesman for every main model" },
			];
			const matches = subcommands.filter((item) =>
				item.value.toLowerCase().startsWith(trimmed.toLowerCase()),
			);
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			if (!isEligible(ctx)) {
				ctx.ui.notify("/spokesman works only in top-level TUI and RPC sessions.", "warning");
				return;
			}

			const raw = args.trim();
			let configured = await readConfig(ctx);

			if (!raw || raw.toLowerCase() === "status") {
				reportStatus(ctx, configured);
				refreshStatus(ctx, configured);
				return;
			}

			// /spokesman for [<pattern>... | all]
			const forMatch = /^for(?:\s+([\s\S]+))?$/i.exec(raw);
			if (forMatch) {
				const rest = forMatch[1]?.trim();
				if (!rest) {
					ctx.ui.notify(
						`Spokesman runs for main models: ${formatMainModels(configured.mainModels)}.`,
						"info",
					);
					return;
				}
				let mainModels: string[] | undefined;
				if (rest.toLowerCase() !== "all") {
					mainModels = parseMainModels(rest.split(/[\s,]+/).filter(Boolean));
					if (!mainModels?.length) {
						ctx.ui.notify(
							'Invalid main-model pattern. Provide model ids or globs like "gpt-6-sol", "gpt-6-*", or "openai/*".',
							"warning",
						);
						return;
					}
				}
				await writeConfig({ default: configured.default, mode: configured.mode, mainModels });
				configured = { ...configured, mainModels };
				ctx.ui.notify(
					`Spokesman now runs for main models: ${formatMainModels(mainModels)} (all sessions).`,
					"info",
				);
				refreshStatus(ctx, configured);
				return;
			}

			// /spokesman default [...]
			const defaultMatch = /^default(?:\s+([\s\S]+))?$/i.exec(raw);
			if (defaultMatch) {
				const rest = defaultMatch[1]?.trim();
				if (!rest) {
					ctx.ui.notify(
						`Default for new sessions: ${configured.default ?? "off"} (${configured.mode}).`,
						"info",
					);
					return;
				}
				if (rest.toLowerCase() === "off") {
					await writeConfig({ mainModels: configured.mainModels });
					configured = { default: undefined, mode: "auto", mainModels: configured.mainModels };
					ctx.ui.notify(
						"Removed the default spokesman for new sessions. Sessions that have had a first run keep their spokesman.",
						"info",
					);
					refreshStatus(ctx, configured);
					return;
				}
				const defaultModeMatch = /^mode(?:\s+(auto|always))?$/i.exec(rest);
				if (defaultModeMatch) {
					const nextMode = defaultModeMatch[1]?.toLowerCase() as SpokesmanMode | undefined;
					if (!nextMode) {
						ctx.ui.notify(
							`Default spokesman mode for new sessions: ${configured.mode}.`,
							"info",
						);
						return;
					}
					configured = { ...configured, mode: nextMode };
					await writeConfig(configured);
					ctx.ui.notify(
						`Default spokesman mode for new sessions: ${nextMode}. Sessions that have had a first run keep their spokesman.`,
						"info",
					);
					refreshStatus(ctx, configured);
					return;
				}

				const parts = rest.split(/\s+/);
				const maybeMode = parts.length === 2 && isMode(parts[1]?.toLowerCase())
					? (parts[1]!.toLowerCase() as SpokesmanMode)
					: undefined;
				const modelCandidate = maybeMode ? parts[0]! : rest;
				const validSpec = validModelSpec(modelCandidate);
				if (!validSpec) {
					ctx.ui.notify(
						'Invalid spokesman model name. Provide a model id like "openai/gpt-5.4" or "claude-haiku-4-5".',
						"warning",
					);
					return;
				}
				const nextMode = maybeMode ?? configured.mode;
				configured = { ...configured, default: validSpec, mode: nextMode };
				await writeConfig(configured);
				ctx.ui.notify(
					`Default for new sessions: ${validSpec} (${nextMode}). Sessions that have had a first run keep their spokesman.`,
					"info",
				);
				refreshStatus(ctx, configured);
				return;
			}

			// /spokesman mode [auto|always] or /spokesman auto | /spokesman always
			const modeMatch = /^(?:mode(?:\s+(\S+))?|(auto|always))$/i.exec(raw);
			if (modeMatch) {
				const requested = (modeMatch[1] ?? modeMatch[2])?.toLowerCase();
				const state = readBranch(ctx);
				const currentMode = effectiveMode(state, configured);
				if (!requested) {
					ctx.ui.notify(
						`Spokesman mode: ${currentMode}. Use /spokesman mode auto or /spokesman mode always.`,
						"info",
					);
					return;
				}
				if (!isMode(requested)) {
					ctx.ui.notify('Expected spokesman mode "auto" or "always".', "warning");
					return;
				}
				pi.appendEntry<SpokesmanEntry>(SPOKESMAN_STATE_ENTRY, { mode: requested });
				refreshStatus(ctx, configured);
				ctx.ui.notify(`Spokesman mode set to ${requested} for this session.`, "info");
				return;
			}

			// /spokesman off
			if (raw.toLowerCase() === "off") {
				const state = readBranch(ctx);
				const currentMode = effectiveMode(state, configured);
				pi.appendEntry<SpokesmanEntry>(SPOKESMAN_STATE_ENTRY, {
					active: null,
					mode: currentMode,
				});
				setStatus(ctx, undefined);
				ctx.ui.notify("Spokesman disabled for this session.", "info");
				return;
			}

			// /spokesman reset
			if (raw.toLowerCase() === "reset") {
				const state = readBranch(ctx);
				const targetBase = state.base === undefined ? configured.default : (state.base ?? undefined);
				const targetMode = state.baseMode ?? configured.mode ?? "auto";
				if (!state.switchedOff && state.switchActive === undefined && state.switchMode === undefined) {
					ctx.ui.notify("No spokesman switch is active.", "info");
					return;
				}
				pi.appendEntry<SpokesmanEntry>(SPOKESMAN_STATE_ENTRY, {
					active: targetBase ?? null,
					mode: targetMode,
					reset: true,
				});
				refreshStatus(ctx, configured);
				ctx.ui.notify(
					`Spokesman reset${targetBase ? ` to ${targetBase}` : " to off"} (${targetMode}).`,
					"info",
				);
				return;
			}

			// /spokesman rewrite [<model>] or /spokesman now [<model>]
			const rewriteMatch = /^(?:rewrite|now)(?:\s+([\s\S]+))?$/i.exec(raw);
			if (rewriteMatch) {
				await rewriteLatestResponse(rewriteMatch[1], ctx);
				return;
			}

			// /spokesman <model> [auto|always]
			const tokens = raw.split(/\s+/);
			const inlineMode =
				tokens.length === 2 && isMode(tokens[1]?.toLowerCase())
					? (tokens[1]!.toLowerCase() as SpokesmanMode)
					: undefined;
			const rawModel = inlineMode ? tokens[0]! : raw;
			const modelSpec = validModelSpec(rawModel);
			if (!modelSpec) {
				ctx.ui.notify(
					'Invalid spokesman model name. Provide a model id like "openai/gpt-5.4" or "claude-haiku-4-5".',
					"warning",
				);
				return;
			}

			const state = readBranch(ctx);
			const nextMode = inlineMode ?? effectiveMode(state, configured);
			pi.appendEntry<SpokesmanEntry>(SPOKESMAN_STATE_ENTRY, {
				active: modelSpec,
				mode: nextMode,
			});
			setStatus(ctx, formatStatusLabel(modelSpec, nextMode, configured.mainModels, ctx));
			const disabledNote = isSameAsMainModel(modelSpec, ctx)
				? " (currently disabled because the main model is the same)"
				: !isMainModelEnabled(configured.mainModels, ctx.model)
					? ` (currently inactive because the main model is not in: ${formatMainModels(configured.mainModels)})`
					: "";
			ctx.ui.notify(
				`Spokesman switched to ${modelSpec} (${nextMode} mode)${disabledNote}.`,
				"info",
			);
		},
	});
}
