import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LIVE_MESSAGE, LIVE_SNAPSHOT } from "../src/live.ts";
import { generateEvent, liveFixture, alive } from "./support/live-fixture.ts";
import { liveSession } from "./support/live-session.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";
isolateEngineEnvironment();
const text = (context: unknown) => JSON.stringify(context);
const eventView = (context: { messages: readonly unknown[] }) => {
	const contents = context.messages.map((m) => {
		const content = (m as { content: unknown }).content;
		return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("\n") : "";
	});
	const content = contents.findLast((s) => s.includes("Impeccable native live event."))!;
	return JSON.parse(content.slice(content.indexOf("\n") + 1));
};

it("delivers native event -> actual Pi model tool -> exact native ack with one consumer", async () => {
	const h = await liveFixture(); vi.stubEnv("IMPECCABLE_BIN", h.binary); vi.stubEnv("IMPECCABLE_LIVE_FIXTURE", h.root);
	const runtime = await liveSession(h.root);
	try {
		let received = 0;
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "start" })]),
			fauxAssistantMessage("The helper is starting in the background."),
			(context) => {
				received++;
				const view = eventView(context);
				expect(view.pending.event).toMatchObject(generateEvent);
				return fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "reply", id: view.pending.id, eventToken: view.pending.eventToken, status: "done", file: "index.html" })]);
			},
			fauxAssistantMessage("Native publication acknowledged; waiting for the user's selection."),
		]);
		await runtime.session.prompt("Start live");
		await expect.poll(() => runtime.saved()?.phase).toBe("polling");
		await h.write("event.json", generateEvent);
		await expect.poll(async () => (await h.calls()).filter((c) => c.argv.includes("--reply")).length).toBe(1);
		await expect.poll(() => runtime.session.isStreaming).toBe(false);
		expect(received).toBe(1); expect(runtime.faux.state.callCount).toBe(4);
		const results = runtime.session.sessionManager.getBranch().flatMap((e) => e.type === "message" && e.message.role === "toolResult" ? [e.message] : []);
		expect(results.at(-1)?.details).toMatchObject({ phase: "polling", result: { ok: true, status: "done", id: generateEvent.id } });
		expect(runtime.errors).toEqual([]);
	} finally { await runtime.cleanup(); await h.cleanup(); vi.unstubAllEnvs(); }
});

it("delivers a native live-generate returned event exactly once through Pi", async () => {
	const h = await liveFixture(); vi.stubEnv("IMPECCABLE_BIN", h.binary); vi.stubEnv("IMPECCABLE_LIVE_FIXTURE", h.root);
	const runtime = await liveSession(h.root);
	try {
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "generate", argv: ["#hero"] })]), fauxAssistantMessage("Go is waiting in the background"),
			(context) => { const view = eventView(context); return fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "reply", id: view.pending.id, eventToken: view.pending.eventToken, status: "done", file: "index.html" })]); },
			fauxAssistantMessage("Published once"),
		]);
		await runtime.session.prompt("Generate native variants");
		await expect.poll(async () => (await h.calls()).some((c) => c.argv[0] === "live-generate")).toBe(true);
		expect((await h.calls()).some((c) => c.argv[0] === "live-poll")).toBe(false);
		await h.write("go.json", generateEvent);
		await expect.poll(async () => (await h.calls()).filter((c) => c.argv.includes("--reply")).length).toBe(1);
		await expect.poll(() => runtime.session.isStreaming).toBe(false);
		await h.write("event.json", generateEvent); await expect.poll(() => runtime.saved()?.phase).toBe("paused");
		expect(runtime.session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === LIVE_MESSAGE)).toHaveLength(1);
		expect(runtime.faux.state.callCount).toBe(4); expect(runtime.errors).toEqual([]);
	} finally { await runtime.cleanup(); await h.cleanup(); vi.unstubAllEnvs(); }
});

it("pauses an unsettled model event, removes stale provider context, then reloads and resumes without another Go", async () => {
	const h = await liveFixture(); vi.stubEnv("IMPECCABLE_BIN", h.binary); vi.stubEnv("IMPECCABLE_LIVE_FIXTURE", h.root);
	const runtime = await liveSession(h.root);
	try {
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "start" })]), fauxAssistantMessage("Starting"),
			fauxAssistantMessage("I have not acknowledged this event."),
		]);
		await runtime.session.prompt("Start live"); await expect.poll(() => runtime.saved()?.phase).toBe("polling");
		await h.write("event.json", generateEvent); await expect.poll(() => runtime.saved()?.phase).toBe("paused");
		const saved = runtime.saved()!; expect(saved.pending).toBeDefined();
		const helper = JSON.parse(await readFile(`${h.directory}/server.json`, "utf8")); expect(alive(helper.pid)).toBe(false);
		await runtime.session.reload();
		let staleSeen = false;
		runtime.faux.setResponses([
			(context) => { staleSeen = text(context).includes("Impeccable native live event."); return fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "resume" })]); },
			fauxAssistantMessage("Resuming explicitly"),
			(context) => { const view = eventView(context); return fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "reply", id: view.pending.id, eventToken: view.pending.eventToken, status: "done", file: "index.html" })]); },
			fauxAssistantMessage("Recovered native event was acknowledged"),
		]);
		await runtime.session.prompt("Resume my live work");
		await expect.poll(async () => (await h.calls()).filter((c) => c.argv.includes("--reply")).length).toBe(1);
		await expect.poll(() => runtime.session.isStreaming).toBe(false);
		expect(staleSeen).toBe(false); expect(runtime.errors).toEqual([]);
		expect((await h.calls()).filter((c) => c.argv[0] === "live")).toHaveLength(1);
	} finally { await runtime.cleanup(); await h.cleanup(); vi.unstubAllEnvs(); }
});

it.each(["quit", "reload", "new", "resume", "fork"] as const)("Pi shutdown %s invalidates queued custom messages and closes owned helper/poller", async (reason) => {
	const h = await liveFixture(); vi.stubEnv("IMPECCABLE_BIN", h.binary); vi.stubEnv("IMPECCABLE_LIVE_FIXTURE", h.root);
	const runtime = await liveSession(h.root);
	try {
		runtime.faux.setResponses([fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "start" })]), fauxAssistantMessage("Started")]);
		await runtime.session.prompt("Start live"); await expect.poll(() => runtime.saved()?.phase).toBe("polling");
		await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason });
		expect((await h.calls()).every((c) => !alive(c.pid))).toBe(true);
		expect(runtime.saved()?.phase).toBe("paused");
		const messages = await runtime.session.extensionRunner.emitContext([{ role: "custom", customType: LIVE_MESSAGE, content: "STALE-PROBE", display: true, timestamp: Date.now(), details: { sessionId: runtime.session.sessionManager.getSessionId(), activation: "expired", eventToken: "expired" } }]);
		expect(text(messages)).not.toContain("STALE-PROBE");
	} finally { await runtime.cleanup(); await h.cleanup(); vi.unstubAllEnvs(); }
});

it("forked session entries cannot adopt the parent's live native work", async () => {
	const h = await liveFixture(); vi.stubEnv("IMPECCABLE_BIN", h.binary); vi.stubEnv("IMPECCABLE_LIVE_FIXTURE", h.root);
	const parent = await liveSession(h.root);
	let fork: Awaited<ReturnType<typeof liveSession>> | undefined;
	try {
		parent.faux.setResponses([fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "start" })]), fauxAssistantMessage("Starting"), fauxAssistantMessage("Pending without ack")]);
		await parent.session.prompt("Start live"); await expect.poll(() => parent.saved()?.phase).toBe("polling"); await h.write("event.json", generateEvent); await expect.poll(() => parent.saved()?.phase).toBe("paused");
		const saved = parent.saved()!; const manager = SessionManager.inMemory(h.root);
		manager.appendCustomEntry(LIVE_SNAPSHOT, saved);
		fork = await liveSession(h.root, undefined, manager);
		fork.faux.setResponses([fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "resume" })]), fauxAssistantMessage("No owned recovery metadata")]);
		await fork.session.prompt("Resume");
		const results = manager.getBranch().flatMap((e) => e.type === "message" && e.message.role === "toolResult" ? [e.message] : []);
		expect(results[0]?.isError).toBe(true); expect(text(results)).toContain("No paused owner");
		expect((await h.calls()).filter((c) => c.argv[0] === "live-server")).toHaveLength(1);
	} finally { await fork?.cleanup(); await parent.cleanup(); await h.cleanup(); vi.unstubAllEnvs(); }
});

it.each(["abort", "queued-user", "shutdown"] as const)("pauses pending native work when a busy episode gets %s", async (action) => {
	const h = await liveFixture(); vi.stubEnv("IMPECCABLE_BIN", h.binary); vi.stubEnv("IMPECCABLE_LIVE_FIXTURE", h.root);
	let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
	const runtime = await liveSession(h.root);
	try {
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "start" })]),
			async () => { await barrier; return fauxAssistantMessage("Busy response finished"); },
			(context) => { expect(text(context)).not.toContain("Impeccable native live event."); return fauxAssistantMessage("Handled the newer user request"); },
		]);
		const prompting = runtime.session.prompt("Start live");
		await expect.poll(() => runtime.saved()?.phase).toBe("polling"); await h.write("event.json", generateEvent); await expect.poll(() => runtime.saved()?.phase).toBe("pending");
		const oldToken = runtime.saved()!.pending!.token;
		let stopping: Promise<unknown> | undefined;
		if (action === "abort") stopping = runtime.session.abort();
		else if (action === "shutdown") stopping = runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		else stopping = runtime.session.prompt("Handle my new request", { streamingBehavior: "steer" });
		release(); await stopping; await prompting;
		expect(runtime.saved()?.phase).toBe("paused"); expect(runtime.saved()?.pending?.token).not.toBe(oldToken);
		expect((await h.calls()).every((c) => !alive(c.pid))).toBe(true);
		expect((await h.calls()).filter((c) => c.argv.includes("--reply"))).toHaveLength(0);
		expect(runtime.errors).toEqual([]);
	} finally { release(); await runtime.cleanup(); await h.cleanup(); vi.unstubAllEnvs(); }
});

it("follows the active Pi branch instead of all file entries", async () => {
	const h = await liveFixture(); vi.stubEnv("IMPECCABLE_BIN", h.binary); vi.stubEnv("IMPECCABLE_LIVE_FIXTURE", h.root);
	const runtime = await liveSession(h.root);
	try {
		runtime.faux.setResponses([fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "start" })]), fauxAssistantMessage("Starting")]);
		await runtime.session.prompt("Start branch-owned live"); await expect.poll(() => runtime.saved()?.phase).toBe("polling");
		const user = runtime.session.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user")!;
		await runtime.session.navigateTree(user.id);
		expect((await h.calls()).every((c) => !alive(c.pid))).toBe(true);
		expect(runtime.saved()).toBeUndefined();
		runtime.faux.setResponses([fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "resume" })]), fauxAssistantMessage("No work on this branch")]);
		await runtime.session.prompt("Resume only this branch");
		const results = runtime.session.sessionManager.getBranch().flatMap((e) => e.type === "message" && e.message.role === "toolResult" ? [e.message] : []);
		expect(results.at(-1)?.isError).toBe(true); expect(text(results.at(-1))).toContain("No paused owner");
	} finally { await runtime.cleanup(); await h.cleanup(); vi.unstubAllEnvs(); }
});

it("busy delivery appends to other extension boundary context and allows one actionable continuation", async () => {
	const h = await liveFixture(); vi.stubEnv("IMPECCABLE_BIN", h.binary); vi.stubEnv("IMPECCABLE_LIVE_FIXTURE", h.root);
	let release!: () => void;
	const barrier = new Promise<void>((r) => { release = r; });
	const runtime = await liveSession(h.root, (pi) => {
		pi.on("turn_end", (event) => ({ entries: [...event.entries, { type: "custom_message", customType: "earlier-evidence", content: "KEEP-OTHER-EXTENSION", display: false }] }));
	});
	try {
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_live", { action: "start" })]),
			async () => { await barrier; return fauxAssistantMessage("A busy foreground response"); },
			(context) => { expect(text(context)).toContain("KEEP-OTHER-EXTENSION"); expect(text(context)).toContain("Impeccable native live event."); return fauxAssistantMessage("Pause without acknowledging"); },
		]);
		const prompting = runtime.session.prompt("Start live, keep input responsive");
		await expect.poll(() => runtime.saved()?.phase).toBe("polling"); await h.write("event.json", generateEvent); await expect.poll(() => runtime.saved()?.phase).toBe("pending");
		expect(runtime.faux.state.callCount).toBe(2); release(); await prompting;
		expect(runtime.saved()?.phase).toBe("paused"); expect(runtime.faux.state.callCount).toBe(3); expect(runtime.errors).toEqual([]);
	} finally { release(); await runtime.cleanup(); await h.cleanup(); vi.unstubAllEnvs(); }
});
