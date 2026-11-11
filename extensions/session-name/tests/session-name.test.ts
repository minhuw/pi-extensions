import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import sessionName, { sanitizeTitle, SYSTEM_PROMPT } from "../index.ts";

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
	};
	const complete = vi.fn(options.complete ?? (async () => reply("Fix flaky goal retry test")));
	const models = options.models ?? [SESSION_MODEL, RECON_MODEL];
	const notify = vi.fn();
	const entries = (options.entries ?? firstRun) as never[];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		ui: { notify },
		model: SESSION_MODEL,
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
	return { pi, ctx, complete, notify, emit, name: () => name };
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
