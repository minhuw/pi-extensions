// Normalizes captured provider payloads into one shape for the "what the model saw" drawer.

export type PayloadShape = "anthropic-messages" | "openai-chat" | "openai-responses" | "google" | "pi-context" | "generic";

export const SHAPE_LABELS: Record<PayloadShape, string> = {
	"anthropic-messages": "Anthropic messages",
	"openai-chat": "OpenAI chat completions",
	"openai-responses": "OpenAI responses",
	google: "Google contents",
	"pi-context": "pi context",
	generic: "Unrecognized payload",
};

export type Block =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; redacted?: boolean }
	| { kind: "tool-call"; name: string; id?: string; args: unknown }
	| { kind: "tool-result"; id?: string; name?: string; text: string; isError?: boolean }
	| { kind: "image"; label: string }
	| { kind: "missing"; hash: string }
	| { kind: "json"; label: string; value: unknown };

export interface NormalMessage {
	role: string;
	blocks: Block[];
	raw: unknown;
}

export interface ToolDeclaration {
	name: string;
	description?: string;
	parameters?: unknown;
	/** Hash of a tool declaration block that is not uploaded yet. */
	missing?: string;
}

export interface NormalRequest {
	shape: PayloadShape;
	system: string | null;
	/** Hashes of system prompt blocks that are not uploaded yet. */
	systemMissing: string[];
	tools: ToolDeclaration[];
	messages: NormalMessage[];
	/** Remaining top-level fields, e.g. model, max_tokens, temperature. */
	settings: Record<string, unknown>;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** A block reference the server could not resolve yet (`{"$pika": hash}`). */
export function missingRef(value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.$pika !== "string") return undefined;
	const keys = Object.keys(value);
	return keys.every((key) => key === "$pika" || key === "$type") ? value.$pika : undefined;
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function parseArgs(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** Text of a content value that is a string or a list of text-like parts. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (missingRef(content)) return "";
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (!isRecord(part)) return "";
				return str(part.text) ?? str(part.content) ?? (part.content !== undefined ? textOf(part.content) : "");
			})
			.filter(Boolean)
			.join("\n");
	}
	if (isRecord(content)) {
		if (typeof content.text === "string") return content.text;
		if (Array.isArray(content.parts)) return textOf(content.parts);
	}
	return content === undefined || content === null ? "" : stringify(content);
}

function missingMessage(hash: string): NormalMessage {
	return { role: "missing", blocks: [{ kind: "missing", hash }], raw: { $pika: hash } };
}

function missingTool(hash: string): ToolDeclaration {
	return { name: "tool", missing: hash };
}

interface SystemParts {
	system: string[];
	systemMissing: string[];
}

/** Adds a system prompt value: a string, a list of text parts, or a block reference. */
function addSystem(parts: SystemParts, value: unknown) {
	const items = Array.isArray(value) ? value : [value];
	const refs = items.flatMap((item) => missingRef(item) ?? []);
	parts.systemMissing.push(...refs);
	if (!Array.isArray(value)) {
		if (!refs.length) parts.system.push(textOf(value));
		return;
	}
	const text = textOf(items.filter((item) => !missingRef(item)));
	if (text) parts.system.push(text);
}

function systemFields({ system, systemMissing }: SystemParts): Pick<NormalRequest, "system" | "systemMissing"> {
	return { system: system.length ? system.join("\n\n") : null, systemMissing };
}

// Anthropic messages ---------------------------------------------------------------------------

function anthropicBlocks(content: unknown): Block[] {
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: "json", label: "content", value: content }];
	return content.map((block): Block => {
		if (!isRecord(block)) return { kind: "text", text: String(block) };
		switch (block.type) {
			case "text":
				return { kind: "text", text: str(block.text) ?? "" };
			case "thinking":
				return { kind: "thinking", text: str(block.thinking) ?? "" };
			case "redacted_thinking":
				return { kind: "thinking", text: "", redacted: true };
			case "tool_use":
			case "server_tool_use":
				return { kind: "tool-call", name: str(block.name) ?? "tool", id: str(block.id), args: block.input };
			case "tool_result":
				return { kind: "tool-result", id: str(block.tool_use_id), text: textOf(block.content), isError: block.is_error === true };
			case "image":
			case "document": {
				const source = isRecord(block.source) ? block.source : {};
				return { kind: "image", label: `${String(block.type)}${source.media_type ? ` · ${String(source.media_type)}` : ""}` };
			}
			default:
				return { kind: "json", label: String(block.type ?? "block"), value: block };
		}
	});
}

function normalizeAnthropic(payload: Rec): Omit<NormalRequest, "shape" | "settings"> {
	const messages = (payload.messages as unknown[]).map((message): NormalMessage => {
		const hash = missingRef(message);
		if (hash) return missingMessage(hash);
		const m = isRecord(message) ? message : {};
		return { role: str(m.role) ?? "unknown", blocks: anthropicBlocks(m.content), raw: message };
	});
	const tools = Array.isArray(payload.tools)
		? payload.tools.map((tool): ToolDeclaration => {
				const hash = missingRef(tool);
				if (hash) return missingTool(hash);
				const t = isRecord(tool) ? tool : {};
				return { name: str(t.name) ?? str(t.type) ?? "tool", description: str(t.description), parameters: t.input_schema };
			})
		: [];
	const system: SystemParts = { system: [], systemMissing: [] };
	if (payload.system !== undefined) addSystem(system, payload.system);
	return { ...systemFields(system), tools, messages };
}

// OpenAI chat completions ----------------------------------------------------------------------

function openAiParts(content: unknown): Block[] {
	if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	return content.map((part): Block => {
		if (!isRecord(part)) return { kind: "text", text: String(part) };
		switch (part.type) {
			case "text":
			case "input_text":
			case "output_text":
				return { kind: "text", text: str(part.text) ?? "" };
			case "refusal":
				return { kind: "text", text: str(part.refusal) ?? "" };
			case "image_url":
			case "input_image":
				return { kind: "image", label: "image" };
			case "input_file":
				return { kind: "image", label: `file${part.filename ? ` · ${String(part.filename)}` : ""}` };
			default:
				return { kind: "json", label: String(part.type ?? "part"), value: part };
		}
	});
}

function chatTools(tools: unknown): ToolDeclaration[] {
	if (!Array.isArray(tools)) return [];
	return tools.map((tool): ToolDeclaration => {
		const hash = missingRef(tool);
		if (hash) return missingTool(hash);
		const t = isRecord(tool) ? tool : {};
		const fn = isRecord(t.function) ? t.function : t;
		return { name: str(fn.name) ?? str(t.type) ?? "tool", description: str(fn.description), parameters: fn.parameters };
	});
}

function isSystemRole(role: unknown): boolean {
	return role === "system" || role === "developer";
}

/** Splits leading system/developer messages off into the system prompt. */
function leadingSystem(items: unknown[], textFor: (item: Rec) => string): { parts: SystemParts; rest: unknown[] } {
	let index = 0;
	const parts: SystemParts = { system: [], systemMissing: [] };
	while (index < items.length) {
		const item = items[index];
		if (!isRecord(item) || !isSystemRole(item.role)) break;
		parts.system.push(textFor(item));
		index++;
	}
	return { parts, rest: items.slice(index) };
}

function normalizeOpenAiChat(payload: Rec): Omit<NormalRequest, "shape" | "settings"> {
	const { parts, rest } = leadingSystem(payload.messages as unknown[], (item) => textOf(item.content));
	const messages = rest.map((message): NormalMessage => {
		const hash = missingRef(message);
		if (hash) return missingMessage(hash);
		const m = isRecord(message) ? message : {};
		const role = str(m.role) ?? "unknown";
		if (role === "tool") {
			return { role, blocks: [{ kind: "tool-result", id: str(m.tool_call_id), text: textOf(m.content) }], raw: message };
		}
		const blocks = openAiParts(m.content);
		if (typeof m.reasoning_content === "string" && m.reasoning_content) blocks.unshift({ kind: "thinking", text: m.reasoning_content });
		if (Array.isArray(m.tool_calls)) {
			for (const call of m.tool_calls) {
				const c = isRecord(call) ? call : {};
				const fn = isRecord(c.function) ? c.function : {};
				blocks.push({ kind: "tool-call", name: str(fn.name) ?? "tool", id: str(c.id), args: parseArgs(fn.arguments) });
			}
		}
		return { role, blocks, raw: message };
	});
	return { ...systemFields(parts), tools: chatTools(payload.tools), messages };
}

// OpenAI responses -----------------------------------------------------------------------------

function normalizeOpenAiResponses(payload: Rec): Omit<NormalRequest, "shape" | "settings"> {
	const { parts, rest } = leadingSystem(payload.input as unknown[], (item) => textOf(item.content));
	if (payload.instructions !== undefined && payload.instructions !== null) {
		const instructions: SystemParts = { system: [], systemMissing: [] };
		addSystem(instructions, payload.instructions);
		parts.system.unshift(...instructions.system);
		parts.systemMissing.unshift(...instructions.systemMissing);
	}
	const messages = rest.map((item): NormalMessage => {
		const hash = missingRef(item);
		if (hash) return missingMessage(hash);
		const i = isRecord(item) ? item : {};
		const type = str(i.type) ?? (i.role ? "message" : "item");
		switch (type) {
			case "message":
				return { role: str(i.role) ?? "unknown", blocks: openAiParts(i.content), raw: item };
			case "function_call":
			case "custom_tool_call":
				return {
					role: "assistant",
					blocks: [{ kind: "tool-call", name: str(i.name) ?? "tool", id: str(i.call_id), args: parseArgs(i.arguments ?? i.input) }],
					raw: item,
				};
			case "function_call_output":
			case "custom_tool_call_output":
				return { role: "tool", blocks: [{ kind: "tool-result", id: str(i.call_id), text: textOf(i.output) }], raw: item };
			case "reasoning": {
				const summary = Array.isArray(i.summary) ? textOf(i.summary) : "";
				return { role: "assistant", blocks: [{ kind: "thinking", text: summary, redacted: !summary && Boolean(i.encrypted_content) }], raw: item };
			}
			default:
				return { role: str(i.role) ?? type, blocks: [{ kind: "json", label: type, value: item }], raw: item };
		}
	});
	return { ...systemFields(parts), tools: chatTools(payload.tools), messages };
}

// Google contents ------------------------------------------------------------------------------

function googleBlocks(parts: unknown): Block[] {
	if (!Array.isArray(parts)) return [];
	return parts.map((part): Block => {
		if (!isRecord(part)) return { kind: "text", text: String(part) };
		if (typeof part.text === "string") return part.thought === true ? { kind: "thinking", text: part.text } : { kind: "text", text: part.text };
		if (isRecord(part.functionCall)) {
			return { kind: "tool-call", name: str(part.functionCall.name) ?? "tool", id: str(part.functionCall.id), args: part.functionCall.args };
		}
		if (isRecord(part.functionResponse)) {
			const response = part.functionResponse;
			return { kind: "tool-result", name: str(response.name), id: str(response.id), text: textOf(response.response) };
		}
		if (isRecord(part.inlineData) || isRecord(part.fileData)) {
			const data = (part.inlineData ?? part.fileData) as Rec;
			return { kind: "image", label: str(data.mimeType) ?? "inline data" };
		}
		return { kind: "json", label: Object.keys(part)[0] ?? "part", value: part };
	});
}

function googleTools(tools: unknown): ToolDeclaration[] {
	if (!Array.isArray(tools)) return [];
	return tools.flatMap((tool): ToolDeclaration[] => {
		const hash = missingRef(tool);
		if (hash) return [missingTool(hash)];
		if (!isRecord(tool)) return [];
		if (Array.isArray(tool.functionDeclarations)) {
			return tool.functionDeclarations.map((fn) => {
				const f = isRecord(fn) ? fn : {};
				return { name: str(f.name) ?? "function", description: str(f.description), parameters: f.parameters ?? f.parametersJsonSchema };
			});
		}
		return [{ name: Object.keys(tool)[0] ?? "tool", parameters: tool }];
	});
}

function normalizeGoogle(payload: Rec): Omit<NormalRequest, "shape" | "settings"> {
	const config = isRecord(payload.config) ? payload.config : {};
	const instruction = payload.systemInstruction ?? config.systemInstruction;
	const messages = (payload.contents as unknown[]).map((content): NormalMessage => {
		const hash = missingRef(content);
		if (hash) return missingMessage(hash);
		const c = isRecord(content) ? content : {};
		return { role: str(c.role) ?? "user", blocks: googleBlocks(c.parts), raw: content };
	});
	const system: SystemParts = { system: [], systemMissing: [] };
	if (instruction !== undefined) addSystem(system, instruction);
	return {
		...systemFields(system),
		tools: googleTools(payload.tools ?? config.tools),
		messages,
	};
}

// pi context (fidelity "context") --------------------------------------------------------------

function piBlocks(message: Rec): Block[] {
	const role = str(message.role);
	if (role === "toolResult") {
		return [{ kind: "tool-result", id: str(message.toolCallId), name: str(message.toolName), text: textOf(message.content), isError: message.isError === true }];
	}
	if (role === "bashExecution") return [{ kind: "text", text: `$ ${str(message.command) ?? ""}\n${str(message.output) ?? ""}` }];
	if (role === "compactionSummary" || role === "branchSummary") return [{ kind: "text", text: str(message.summary) ?? "" }];
	const content = message.content;
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: "json", label: "content", value: content }];
	return content.map((block): Block => {
		if (!isRecord(block)) return { kind: "text", text: String(block) };
		switch (block.type) {
			case "text":
				return { kind: "text", text: str(block.text) ?? "" };
			case "thinking":
				return { kind: "thinking", text: str(block.thinking) ?? "", redacted: block.redacted === true };
			case "toolCall":
				return { kind: "tool-call", name: str(block.name) ?? "tool", id: str(block.id), args: block.arguments };
			case "image":
				return { kind: "image", label: str(block.mimeType) ?? "image" };
			default:
				return { kind: "json", label: String(block.type ?? "block"), value: block };
		}
	});
}

function normalizePiContext(payload: Rec): Omit<NormalRequest, "shape" | "settings"> {
	const { parts, rest } = leadingSystem(payload.messages as unknown[], (item) => textOf(item.content));
	if (payload.systemPrompt !== undefined && payload.systemPrompt !== null) {
		const prompt: SystemParts = { system: [], systemMissing: [] };
		addSystem(prompt, payload.systemPrompt);
		parts.system.unshift(...prompt.system);
		parts.systemMissing.unshift(...prompt.systemMissing);
	}
	const messages = rest.map((message): NormalMessage => {
		const hash = missingRef(message);
		if (hash) return missingMessage(hash);
		const m = isRecord(message) ? message : {};
		return { role: str(m.role) ?? "unknown", blocks: piBlocks(m), raw: message };
	});
	const tools = Array.isArray(payload.tools) ? chatTools(payload.tools) : [];
	return { ...systemFields(parts), tools, messages };
}

// Detection ------------------------------------------------------------------------------------

function hasBlockType(messages: unknown[], types: Set<string>): boolean {
	return messages.some(
		(message) => isRecord(message) && Array.isArray(message.content) && message.content.some((block) => isRecord(block) && types.has(String(block.type))),
	);
}

const ANTHROPIC_TYPES = new Set(["tool_use", "tool_result", "thinking", "redacted_thinking"]);

export function detectShape(payload: unknown, hints: { fidelity?: string; api?: string } = {}): PayloadShape {
	if (!isRecord(payload)) return "generic";
	const api = hints.api?.toLowerCase() ?? "";
	if (hints.fidelity === "context") return Array.isArray(payload.messages) ? "pi-context" : "generic";
	if (Array.isArray(payload.contents)) return "google";
	if (Array.isArray(payload.input)) return "openai-responses";
	if (!Array.isArray(payload.messages)) return "generic";
	if (api.includes("anthropic")) return "anthropic-messages";
	if (api.includes("openai") || api.includes("completions") || api.includes("chat")) return "openai-chat";
	const messages = payload.messages;
	if (payload.system !== undefined || hasBlockType(messages, ANTHROPIC_TYPES)) return "anthropic-messages";
	return "openai-chat";
}

const SHAPE_FIELDS: Record<PayloadShape, string[]> = {
	"anthropic-messages": ["messages", "system", "tools"],
	"openai-chat": ["messages", "tools"],
	"openai-responses": ["input", "instructions", "tools"],
	google: ["contents", "systemInstruction", "tools"],
	"pi-context": ["messages", "systemPrompt", "tools"],
	generic: [],
};

export function normalizeRequest(payload: unknown, hints: { fidelity?: string; api?: string } = {}): NormalRequest {
	const shape = detectShape(payload, hints);
	if (shape === "generic" || !isRecord(payload)) return { shape: "generic", system: null, systemMissing: [], tools: [], messages: [], settings: {} };
	const parts =
		shape === "anthropic-messages"
			? normalizeAnthropic(payload)
			: shape === "openai-chat"
				? normalizeOpenAiChat(payload)
				: shape === "openai-responses"
					? normalizeOpenAiResponses(payload)
					: shape === "google"
						? normalizeGoogle(payload)
						: normalizePiContext(payload);
	const skip = new Set(SHAPE_FIELDS[shape]);
	const settings: Rec = {};
	for (const [key, value] of Object.entries(payload)) {
		if (skip.has(key)) continue;
		if (shape === "google" && key === "config" && isRecord(value)) {
			const { systemInstruction: _system, tools: _tools, ...rest } = value;
			if (Object.keys(rest).length) settings.config = rest;
			continue;
		}
		settings[key] = value;
	}
	return { shape, ...parts, settings };
}

const isCachePoint = (block: unknown) => isRecord(block) && Object.keys(block).length === 1 && "cachePoint" in block;

/**
 * A message without prompt-caching markers. Providers mark only the last user message, so the same
 * message differs between consecutive requests: Anthropic adds `cache_control`, turning string
 * content into a single text block to hold it, and Bedrock appends a `cachePoint` content element.
 */
function comparable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(comparable);
	if (!isRecord(value)) return value;
	const out: Rec = {};
	for (const [key, item] of Object.entries(value)) if (key !== "cache_control") out[key] = comparable(item);
	if (Array.isArray(out.content)) out.content = out.content.filter((block) => !isCachePoint(block));
	if (Array.isArray(out.content) && out.content.length === 1) {
		const [block] = out.content;
		if (isRecord(block) && block.type === "text" && typeof block.text === "string" && Object.keys(block).length === 2) out.content = block.text;
	}
	return out;
}

/**
 * Indices of messages that are new since `previous`: everything after the longest common prefix.
 * Returns undefined when there is no previous request to compare with.
 */
export function newMessageStart(current: NormalMessage[], previous: NormalMessage[] | undefined): number | undefined {
	if (!previous) return undefined;
	const same = (a: NormalMessage, b: NormalMessage) => a.raw === b.raw || stringify(comparable(a.raw)) === stringify(comparable(b.raw));
	let index = 0;
	while (index < current.length && index < previous.length && same(current[index], previous[index])) index++;
	return index;
}

export interface Section {
	title: string;
	text: string;
}

const TAG_OPEN = /^<([A-Za-z_][\w.-]*)(\s[^>]*)?>\s*$/;
const HEADING = /^(#{1,2})\s+(.+?)\s*#*\s*$/;

/**
 * Splits a system prompt into known sections: top-level `<tag>…</tag>` blocks and `#`/`##`
 * headings. Text before the first section becomes an untitled lead.
 */
export function systemSections(text: string): Section[] {
	const lines = text.split("\n");
	const sections: Section[] = [];
	let current: { title: string; lines: string[] } = { title: "", lines: [] };
	const flush = () => {
		const body = current.lines.join("\n").trim();
		if (body || current.title) sections.push({ title: current.title, text: body });
	};
	let fence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trimStart().startsWith("```")) fence = !fence;
		if (fence) {
			current.lines.push(line);
			continue;
		}
		const tag = TAG_OPEN.exec(line);
		if (tag) {
			const close = lines.findIndex((candidate, j) => j > i && candidate.trim() === `</${tag[1]}>`);
			if (close > i) {
				flush();
				const attrs = tag[2]?.trim();
				sections.push({ title: attrs ? `${tag[1]} ${attrs}` : tag[1], text: lines.slice(i + 1, close).join("\n").trim() });
				current = { title: "", lines: [] };
				i = close;
				continue;
			}
		}
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			current = { title: heading[2], lines: [] };
			continue;
		}
		current.lines.push(line);
	}
	flush();
	return sections;
}
