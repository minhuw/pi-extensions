import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import sessionName, { AUTO_ENTRY, REFRESH_SYSTEM_PROMPT, sanitizeTitle, SYSTEM_PROMPT } from "../index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Model = { provider: string; id: string };

const SESSION_MODEL: Model = { provider: "main", id: "big" };
const RECON_MODEL: Model = { provider: "magpie", id: "claude-haiku-5-5" };

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-session-name-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

function reply(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra } as AssistantMessage;
}

function message(role: string, text: string, stopReason?: string) {
	return { type: "message", message: { role, content: role === "user" ? text : [{ type: "text", text }], stopReason } };
}

const firstRun = [
	message("user", "Fix the flaky retry test in extensions/goal"),
	message("assistant", "Let me look.", "toolUse"),
	message("assistant", "The retry test now waits for the timer; it passes 50 times in a row.", "stop"),
];

function harness(options: {
	name?: string;
	usage?: { tokens: number | null; contextWindow: number } | undefined;
	mode?: string;
	entries?: unknown[];
	models?: Model[];
	auth?: boolean;
	complete?: (model: Model, context: Context, options: { signal?: AbortSignal }) => Promise<AssistantMessage>;
} = {}) {
	const handlers = new Map<string, Handler[]>();
	let name = options.name;
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		getSessionName: () => name,
		setSessionName: vi.fn((next: string) => { name = next; }),
		appendEntry: vi.fn((customType: string, data?: unknown) => { entries.push({ type: "custom", customType, data } as never); }),
	};
	const complete = vi.fn(options.complete ?? (async () => reply("Fix flaky goal retry test")));
	const models = options.models ?? [SESSION_MODEL, RECON_MODEL];
	const notify = vi.fn();
	const entries = [...(options.entries ?? firstRun)] as never[];
	let usage = "usage" in options ? options.usage : { tokens: 1_000, contextWindow: 200_000 };
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		ui: { notify },
		model: SESSION_MODEL,
		getContextUsage: () => usage && { ...usage, percent: usage.tokens === null ? null : (usage.tokens / usage.contextWindow) * 100 },
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
		modelRegistry: {
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => options.auth ?? true,
			complete,
		},
	} as unknown as ExtensionContext;
	sessionName(pi as unknown as ExtensionAPI);
	const emit = async (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const setUsage = (next: typeof usage) => { usage = next; };
	const autoEntries = () => entries.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === AUTO_ENTRY)
		.map((entry: { data: unknown }) => entry.data);
	return { pi, ctx, complete, notify, emit, entries, setUsage, autoEntries, name: () => name };
}

/** Lets the fire-and-forget naming request finish. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 20));

it("names the session after the first completed run, from the first prompt and final answer", async () => {
	const h = harness();
	await h.emit("agent_settled", { aborted: false });
	await drain();
	expect(h.name()).toBe("Fix flaky goal retry test");
	const [, context] = h.complete.mock.calls[0]!;
	expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
	const input = context.messages[0]!.content as string;
	expect(input).toContain("Fix the flaky retry test in extensions/goal");
	expect(input).toContain("it passes 50 times in a row");
	expect(input).not.toContain("Let me look.");
	expect(h.notify).not.toHaveBeenCalled();

	// Once per session.
	await h.emit("agent_settled", { aborted: false });
	await drain();
	expect(h.complete).toHaveBeenCalledTimes(1);
});

it("truncates long inputs", async () => {
	const h = harness({ entries: [message("user", "a".repeat(10_000)), message("assistant", "b".repeat(10_000), "stop")] });
	await h.emit("agent_settled", { aborted: false });
	await drain();
	const input = h.complete.mock.calls[0]![1].messages[0]!.content as string;
	expect(input.length).toBeLessThan(8_200);
});

it("never overwrites an existing name", async () => {
	const h = harness({ name: "Set by /name" });
	await h.emit("agent_settled", { aborted: false });
	await drain();
	expect(h.complete).not.toHaveBeenCalled();
	expect(h.pi.setSessionName).not.toHaveBeenCalled();
});

it("keeps a name set while the title was being generated", async () => {
	let finish!: (message: AssistantMessage) => void;
	const h = harness({ complete: () => new Promise((resolve) => { finish = resolve; }) });
	await h.emit("agent_settled", { aborted: false });
	await drain();
	h.pi.setSessionName("Chosen by the user");
	finish(reply("Generated title"));
	await drain();
	expect(h.name()).toBe("Chosen by the user");
	expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
});

it("waits for a run that was not aborted and has a final answer", async () => {
	const h = harness({ entries: [message("user", "Do it"), message("assistant", "Working", "toolUse")] });
	await h.emit("agent_settled", { aborted: true });
	await h.emit("agent_settled", { aborted: false });
	await drain();
	expect(h.complete).not.toHaveBeenCalled();
});

it("uses the recon model from subagent-models.json", async () => {
	await writeFile(join(agentDir, "subagent-models.json"), JSON.stringify({ recon: "magpie/claude-haiku-5-5" }));
	const h = harness();
	await h.emit("agent_settled", { aborted: false });
	await drain();
	expect(h.complete.mock.calls[0]![0]).toBe(RECON_MODEL);
});

it("falls back to the session model when recon has no override or inherits", async () => {
	const missing = harness();
	await missing.emit("agent_settled", { aborted: false });
	await drain();
	expect(missing.complete.mock.calls[0]![0]).toBe(SESSION_MODEL);

	await writeFile(join(agentDir, "subagent-models.json"), JSON.stringify({ worker: "magpie/claude-haiku-5-5" }));
	const otherKey = harness();
	await otherKey.emit("agent_settled", { aborted: false });
	await drain();
	expect(otherKey.complete.mock.calls[0]![0]).toBe(SESSION_MODEL);

	await writeFile(join(agentDir, "subagent-models.json"), JSON.stringify({ recon: "inherit" }));
	const inherit = harness();
	await inherit.emit("agent_settled", { aborted: false });
	await drain();
	expect(inherit.complete.mock.calls[0]![0]).toBe(SESSION_MODEL);
});

it("skips child sessions", async () => {
	const print = harness({ mode: "print" });
	await print.emit("agent_settled", { aborted: false });
	const linked = harness({ entries: [{ type: "custom", customType: "pi-extensions.session-link", data: {} }, ...firstRun] });
	await linked.emit("agent_settled", { aborted: false });
	await drain();
	expect(print.complete).not.toHaveBeenCalled();
	expect(linked.complete).not.toHaveBeenCalled();
});

it("sanitizes the title", async () => {
	expect(sanitizeTitle('\n  "Fix flaky goal retry test."\nThis title says…')).toBe("Fix flaky goal retry test");
	expect(sanitizeTitle("**Title:** `pika` relay reconnect")).toBe("pika relay reconnect");
	expect(sanitizeTitle("# 修复 goal 重试测试。")).toBe("修复 goal 重试测试");
	expect(sanitizeTitle("x".repeat(200))).toHaveLength(80);

	const h = harness({ complete: async () => reply(' \n"" \n') });
	await h.emit("agent_settled", { aborted: false });
	await drain();
	expect(h.pi.setSessionName).not.toHaveBeenCalled();
	expect(h.notify).not.toHaveBeenCalled();
});

it("warns once and names nothing when the model fails", async () => {
	const failing = harness({ complete: async () => reply("", { stopReason: "error", errorMessage: "503 upstream" }) });
	await failing.emit("agent_settled", { aborted: false });
	await drain();
	expect(failing.pi.setSessionName).not.toHaveBeenCalled();
	expect(failing.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("503 upstream"), "warning");

	const throwing = harness({ complete: async () => { throw new Error("network down"); } });
	await throwing.emit("agent_settled", { aborted: false });
	await drain();
	expect(throwing.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("network down"), "warning");

	const noAuth = harness({ auth: false });
	await noAuth.emit("agent_settled", { aborted: false });
	await drain();
	expect(noAuth.complete).not.toHaveBeenCalled();
	expect(noAuth.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("no credentials for main/big"), "warning");

	await writeFile(join(agentDir, "subagent-models.json"), JSON.stringify({ recon: "gone/model" }));
	const missing = harness();
	await missing.emit("agent_settled", { aborted: false });
	await drain();
	expect(missing.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('recon model "gone/model" was not found'), "warning");
});

it("aborts the request on session shutdown without naming or warning", async () => {
	let signal: AbortSignal | undefined;
	const h = harness({
		complete: (_model, _context, options) => new Promise((resolve) => {
			signal = options.signal;
			options.signal?.addEventListener("abort", () => resolve(reply("", { stopReason: "aborted" })));
		}),
	});
	await h.emit("agent_settled", { aborted: false });
	await drain();
	await h.emit("session_shutdown", { reason: "quit" });
	await drain();
	expect(signal?.aborted).toBe(true);
	expect(h.pi.setSessionName).not.toHaveBeenCalled();
	expect(h.notify).not.toHaveBeenCalled();
});

const FIRST_TITLE = "Fix flaky goal retry test";

/** A harness whose first naming replies FIRST_TITLE and whose refreshes reply from `refreshReplies`, in order. */
function refreshing(refreshReplies: Array<string | Error>, options: Parameters<typeof harness>[0] = {}) {
	return harness({
		...options,
		complete: async (_model, context) => {
			if (context.systemPrompt === SYSTEM_PROMPT) return reply(FIRST_TITLE);
			const next = refreshReplies.shift();
			if (next === undefined) throw new Error("unexpected refresh");
			if (next instanceof Error) throw next;
			return reply(next);
		},
	});
}

async function settle(h: ReturnType<typeof harness>, tokens?: number | null, contextWindow = 200_000) {
	if (tokens !== undefined) h.setUsage({ tokens, contextWindow });
	await h.emit("agent_settled", { aborted: false });
	await drain();
}

it("records the first naming with the context tokens", async () => {
	const h = refreshing([]);
	await settle(h, 1_000);
	expect(h.autoEntries()).toEqual([{ name: FIRST_TITLE, tokens: 1_000 }]);
});

it("does not refresh before the context grew by a quarter of the window", async () => {
	const h = refreshing([]);
	await settle(h, 1_000);
	await settle(h, 50_999);
	expect(h.complete).toHaveBeenCalledTimes(1);
	expect(h.autoEntries()).toHaveLength(1);
});

it("refreshes once the context grew by a quarter of the window, from the first prompt, name, and recent messages", async () => {
	const h = refreshing(["Goal retry timer and backoff rework"]);
	await settle(h, 1_000);
	h.entries.push(message("user", "Now rework the backoff in extensions/goal/retry.ts") as never);
	h.entries.push(message("assistant", "Reworked the backoff to use jittered delays.", "stop") as never);
	await settle(h, 51_000);
	expect(h.complete).toHaveBeenCalledTimes(2);
	const [, context] = h.complete.mock.calls[1]!;
	expect(context.systemPrompt).toBe(REFRESH_SYSTEM_PROMPT);
	const input = context.messages[0]!.content as string;
	expect(input).toContain("<first-request>\nFix the flaky retry test in extensions/goal\n</first-request>");
	expect(input).toContain(`<current-title>\n${FIRST_TITLE}\n</current-title>`);
	expect(input).toContain("[user] Now rework the backoff");
	expect(input).toContain("[assistant] Reworked the backoff to use jittered delays.");
	expect(input).not.toContain("earlier-work-summary");
	expect(h.name()).toBe("Goal retry timer and backoff rework");
	expect(h.autoEntries().at(-1)).toEqual({ name: "Goal retry timer and backoff rework", tokens: 51_000 });
});

it("keeps the newest recent messages within about 8000 characters", async () => {
	const h = refreshing(["KEEP"]);
	await settle(h, 1_000);
	h.entries.push(message("user", `old ${"o".repeat(9_000)}`) as never);
	h.entries.push(message("assistant", `new ${"n".repeat(5_000)}`, "stop") as never);
	await settle(h, 51_000);
	const input = h.complete.mock.calls[1]![1].messages[0]!.content as string;
	const recent = input.slice(input.indexOf("<recent-messages>"));
	expect(recent).toContain(`[assistant] new ${"n".repeat(5_000)}`);
	expect(recent).not.toContain("old ");
	expect(recent.length).toBeLessThan(8_200);
});

it("caps the refresh step at 256K tokens", async () => {
	const million = refreshing(["KEEP"]);
	await settle(million, 1_000, 1_000_000);
	await settle(million, 250_999, 1_000_000);
	expect(million.complete).toHaveBeenCalledTimes(1);
	await settle(million, 251_000, 1_000_000);
	expect(million.complete).toHaveBeenCalledTimes(2);

	const huge = refreshing(["KEEP"]);
	await settle(huge, 1_000, 2_000_000);
	await settle(huge, 256_999, 2_000_000);
	expect(huge.complete).toHaveBeenCalledTimes(1);
	await settle(huge, 257_000, 2_000_000);
	expect(huge.complete).toHaveBeenCalledTimes(2);
});

it("advances the baseline without renaming on KEEP or the same title", async () => {
	const h = refreshing(["KEEP", `"${FIRST_TITLE}."`]);
	await settle(h, 1_000);
	await settle(h, 51_000);
	expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
	expect(h.autoEntries().at(-1)).toEqual({ name: FIRST_TITLE, tokens: 51_000 });

	await settle(h, 100_999);
	expect(h.complete).toHaveBeenCalledTimes(2);
	await settle(h, 101_000);
	expect(h.complete).toHaveBeenCalledTimes(3);
	expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
	expect(h.autoEntries().at(-1)).toEqual({ name: FIRST_TITLE, tokens: 101_000 });
});

it("never refreshes a name set by /name", async () => {
	const h = refreshing([]);
	await settle(h, 1_000);
	h.pi.setSessionName("Mine");
	await settle(h, 190_000);
	expect(h.complete).toHaveBeenCalledTimes(1);
	expect(h.name()).toBe("Mine");

	const flag = refreshing([], { name: "From --name" });
	await settle(flag, 190_000);
	expect(flag.complete).not.toHaveBeenCalled();
});

it("keeps a name set while the refresh was pending, and sends one request at a time", async () => {
	let finish!: (message: AssistantMessage) => void;
	const h = harness({
		complete: (_model, context) => context.systemPrompt === SYSTEM_PROMPT
			? Promise.resolve(reply(FIRST_TITLE))
			: new Promise((resolve) => { finish = resolve; }),
	});
	await settle(h, 1_000);
	await settle(h, 51_000);
	await settle(h, 120_000);
	expect(h.complete).toHaveBeenCalledTimes(2);
	h.pi.setSessionName("Chosen by the user");
	finish(reply("Generated title"));
	await drain();
	expect(h.name()).toBe("Chosen by the user");
	expect(h.autoEntries()).toHaveLength(1);
});

it("counts growth again from a context that compaction shrank, and sends the compaction summary", async () => {
	const h = refreshing(["Goal retry backoff"]);
	await settle(h, 100_000);
	h.entries.push({ type: "compaction", summary: "Fixed the retry test; started the backoff rework.", firstKeptEntryId: "x", tokensBefore: 150_000 } as never);
	await settle(h, 20_000);
	expect(h.complete).toHaveBeenCalledTimes(1);
	expect(h.autoEntries().at(-1)).toEqual({ name: FIRST_TITLE, tokens: 20_000 });
	await settle(h, 69_999);
	expect(h.complete).toHaveBeenCalledTimes(1);
	await settle(h, 70_000);
	expect(h.complete).toHaveBeenCalledTimes(2);
	expect(h.complete.mock.calls[1]![1].messages[0]!.content).toContain(
		"<earlier-work-summary>\nFixed the retry test; started the backoff rework.\n</earlier-work-summary>",
	);
	expect(h.name()).toBe("Goal retry backoff");
});

it("restores the name and baseline from the latest entry after a reload", async () => {
	const entries = [...firstRun, { type: "custom", customType: AUTO_ENTRY, data: { name: "Old title", tokens: 10_000 } }];
	const below = refreshing([], { name: "Old title", entries, usage: { tokens: 59_999, contextWindow: 200_000 } });
	await settle(below);
	expect(below.complete).not.toHaveBeenCalled();

	const due = refreshing(["New title"], { name: "Old title", entries, usage: { tokens: 60_000, contextWindow: 200_000 } });
	await settle(due);
	expect(due.complete).toHaveBeenCalledOnce();
	expect(due.name()).toBe("New title");
	expect(due.autoEntries().at(-1)).toEqual({ name: "New title", tokens: 60_000 });

	const renamed = refreshing([], { name: "Renamed later", entries, usage: { tokens: 190_000, contextWindow: 200_000 } });
	await settle(renamed);
	expect(renamed.complete).not.toHaveBeenCalled();
});

it("skips the check silently while the context size is unknown", async () => {
	const h = refreshing([]);
	await settle(h, 1_000);
	await settle(h, null);
	h.setUsage(undefined);
	await settle(h);
	expect(h.complete).toHaveBeenCalledTimes(1);
	expect(h.autoEntries()).toHaveLength(1);
	expect(h.notify).not.toHaveBeenCalled();
});

it("warns once per failed refresh and retries only after another step of growth", async () => {
	const h = refreshing([new Error("503 upstream"), "Goal retry backoff"]);
	await settle(h, 1_000);
	await settle(h, 51_000);
	expect(h.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("503 upstream"), "warning");
	expect(h.autoEntries()).toHaveLength(1);

	await settle(h, 52_000);
	await settle(h, 100_999);
	expect(h.complete).toHaveBeenCalledTimes(2);
	await settle(h, 101_000);
	expect(h.complete).toHaveBeenCalledTimes(3);
	expect(h.name()).toBe("Goal retry backoff");
	expect(h.notify).toHaveBeenCalledOnce();
});
