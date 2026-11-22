import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMagpieAutoContinue } from "../auto-continue.ts";
import type { MagpieModel } from "../model-aliases.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const RESET = NOW + 60_000;
const RETRY = RESET + 30_000;
const model: MagpieModel = {
	id: "gpt-test", name: "GPT", provider: "magpie", api: "openai-responses", baseUrl: "https://stale.example/v1",
	magpieAliasTarget: "auto/gpt-test", magpieRoute: { canonicalId: "auto/gpt-test", group: true, owner: "codex" },
	reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};
function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "magpie", model: model.id, content: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error", errorMessage: "429 usage_limit_reached", timestamp: Date.now(), ...overrides };
}
function harness(mode: ExtensionContext["mode"] = "tui", child = false) {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "Finish the task", timestamp: NOW - 100 });
	if (child) session.appendCustomEntry("pi-extensions.session-link", { parentSessionId: "parent" });
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	let idle = false;
	let pending = false;
	const statuses = new Map<string, string>();
	const setStatus = vi.fn((key: string, text: string | undefined) => {
		if (text === undefined) statuses.delete(key);
		else statuses.set(key, text);
	});
	const auth = vi.fn(async () => ({ ok: true as const, apiKey: "private-key", baseUrl: "https://active.example/v1" }));
	const notify = vi.fn();
	const sendMessage = vi.fn();
	const controller = new AbortController();
	let activeSession = session;
	const makeCtx = (targetSession: SessionManager, targetSetStatus: typeof setStatus, targetMode = mode) => ({
		mode: targetMode, hasUI: true, model: { ...model }, sessionManager: targetSession,
		modelRegistry: { getApiKeyAndHeaders: auth }, signal: controller.signal,
		isIdle: () => idle, hasPendingMessages: () => pending,
		ui: { notify, setStatus: targetSetStatus },
	}) as unknown as ExtensionContext;
	let activeCtx = makeCtx(session, setStatus);
	const appendEntry = vi.fn((type: string, data: unknown) => activeSession.appendCustomEntry(type, structuredClone(data)));
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry, sendMessage,
	} as unknown as ExtensionAPI;
	const route = () => ({ session: activeSession.getSessionId(), route: { asked: "auto/gpt-test", time: new Date(Date.now()).toISOString(),
		done: true, status: 429, tries: [{ model: "codex/gpt-test", done: true, status: 429, fail: "quota" }] } });
	const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).includes("/quotas")
		? Response.json({ object: "list", data: [{ provider: "codex", kind: "subscription", windows: [
			{ name: "5 hours", used: 100, remaining: 0, resetsAt: new Date(RESET).toISOString() },
		] }] }) : Response.json(route()));
	vi.stubGlobal("fetch", fetcher);
	registerMagpieAutoContinue(pi);
	const emit = async (event: string, data: unknown = {}, targetCtx = activeCtx) => handlers.get(event)?.(data, targetCtx);
	const start = async () => { idle = false; await emit("before_agent_start"); };
	const finishMessage = async (msg = message()) => {
		// Pi emits message_end to extensions before persisting the message.
		await emit("message_end", { message: msg });
		activeSession.appendMessage(msg);
	};
	const settled = async (aborted = false) => { idle = true; await emit("agent_settled", { aborted }); };
	const fail = async () => { await start(); await finishMessage(); await settled(); };
	const command = (args: string, targetCtx = activeCtx) => commands.get("magpie-auto-continue")!.handler(args, targetCtx);
	const replaceSession = (nextMode: ExtensionContext["mode"] = mode, nextChild = false) => {
		const nextSession = SessionManager.inMemory();
		nextSession.appendMessage({ role: "user", content: "Next session task", timestamp: Date.now() - 100 });
		if (nextChild) nextSession.appendCustomEntry("pi-extensions.session-link", { parentSessionId: "parent" });
		const nextStatuses = new Map<string, string>();
		const nextSetStatus = vi.fn((key: string, text: string | undefined) => {
			if (text === undefined) nextStatuses.delete(key);
			else nextStatuses.set(key, text);
		});
		const nextCtx = makeCtx(nextSession, nextSetStatus, nextMode);
		activeSession = nextSession;
		activeCtx = nextCtx;
		return { session: nextSession, ctx: nextCtx, statuses: nextStatuses, setStatus: nextSetStatus };
	};
	return { session, ctx: activeCtx, auth, notify, sendMessage, statuses, setStatus, appendEntry, controller, fetcher, emit, start, finishMessage, settled, fail, command, replaceSession,
		setIdle: (next: boolean) => { idle = next; }, setPending: (next: boolean) => { pending = next; },
		reload: async () => { await emit("session_shutdown"); registerMagpieAutoContinue(pi); await emit("session_start", { reason: "reload" }); },
	};
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Magpie quota continuation", () => {
	it("queries the effective gateway only after a failure, shows a countdown, and resumes exactly once after reset plus grace", async () => {
		const h = harness();
		await h.emit("session_start");
		expect(h.fetcher).not.toHaveBeenCalled();
		await h.fail();
		expect(h.fetcher).toHaveBeenCalledTimes(2);
		expect(h.fetcher.mock.calls.every(([url]) => String(url).startsWith("https://active.example/"))).toBe(true);
		expect(h.statuses.get("magpie-quota")).toContain("quota awaiting · retry in 2m");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.statuses.get("magpie-quota")).toContain("retry in 1m");
		await vi.advanceTimersByTimeAsync(RETRY - NOW - 30_001);
		expect(h.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			customType: "magpie-auto-continue", content: expect.stringContaining("Check completed tool results"), display: true,
		}), { triggerTurn: true });
		expect(h.statuses.has("magpie-quota")).toBe(false);
		await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000);
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
		expect(h.fetcher).toHaveBeenCalledTimes(2); // no network polling while waiting
		expect(JSON.stringify(h.session.getEntries())).not.toContain("private-key");
	});

	it("preserves the first useful route observation through core retries, but arms only at final settlement", async () => {
		const h = harness();
		await h.start(); await h.finishMessage();
		await vi.advanceTimersByTimeAsync(10_000);
		await h.finishMessage(); // gateway's next route may have no tries
		expect(h.fetcher).toHaveBeenCalledTimes(2);
		expect(h.sendMessage).not.toHaveBeenCalled();
		await h.settled();
		await vi.advanceTimersByTimeAsync(RETRY - Date.now());
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});

	it.each(["success", "different-error", "different-provider"])("discards a quota candidate when a core retry ends with %s", async outcome => {
		const h = harness();
		await h.start(); await h.finishMessage();
		await h.finishMessage(message(outcome === "success" ? { stopReason: "stop", errorMessage: undefined }
			: outcome === "different-error" ? { errorMessage: "401 invalid API key" } : { provider: "other" }));
		await h.settled();
		await vi.advanceTimersByTimeAsync(RETRY - NOW);
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.statuses.size).toBe(0);
	});

	it.each(["input", "model_select", "session_before_switch", "session_before_fork", "session_tree", "session_compact"])("cancels a wait on %s", async event => {
		const h = harness(); await h.fail();
		await h.emit(event, { text: "new task", source: "interactive" });
		await vi.advanceTimersByTimeAsync(RETRY - NOW + 60_000);
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.statuses.size).toBe(0);
	});

	it("respects abort and never schedules an aborted quota failure", async () => {
		const h = harness(); await h.start(); await h.finishMessage(); await h.settled(true);
		await vi.advanceTimersByTimeAsync(RETRY - NOW);
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.statuses.size).toBe(0);
	});

	it.each(["busy", "pending", "dialog"])("waits outside Pi's queue while %s", async kind => {
		const h = harness(); await h.fail();
		if (kind === "busy") h.setIdle(false);
		if (kind === "pending") h.setPending(true);
		if (kind === "dialog") await h.emit("ui_prompt_start");
		await vi.advanceTimersByTimeAsync(RETRY - NOW + 2000);
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.statuses.get("magpie-quota")).toContain("waiting for idle");
		h.setIdle(true); h.setPending(false);
		if (kind === "dialog") await h.emit("ui_prompt_end");
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("pauses on credential changes and requires explicit resume", async () => {
		const h = harness(); await h.fail();
		h.auth.mockResolvedValue({ ok: true, apiKey: "replacement-key", baseUrl: "https://active.example/v1" });
		await vi.advanceTimersByTimeAsync(RETRY - NOW);
		expect(h.statuses.get("magpie-quota")).toContain("credentials changed");
		expect(h.sendMessage).not.toHaveBeenCalled();
		await h.command("resume"); await vi.advanceTimersByTimeAsync(1);
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("does not send a saved credential to the old gateway or automatically follow a changed gateway", async () => {
		const h = harness(); await h.fail();
		h.auth.mockResolvedValue({ ok: true, apiKey: "another-key", baseUrl: "https://another.example/v1" });
		await vi.advanceTimersByTimeAsync(RETRY - NOW);
		await h.command("resume"); await vi.advanceTimersByTimeAsync(1000);
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.statuses.get("magpie-quota")).toContain("gateway changed");
		expect(h.fetcher).toHaveBeenCalledTimes(2);
	});

	it("restores a wait paused after reload and allows explicit resumption", async () => {
		const h = harness(); await h.fail(); await h.reload();
		expect(h.statuses.get("magpie-quota")).toContain("quota paused");
		await vi.advanceTimersByTimeAsync(RETRY - NOW + 1000);
		expect(h.sendMessage).not.toHaveBeenCalled();
		await h.command("resume"); await vi.advanceTimersByTimeAsync(1);
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("cancel stops only the current wait; off persists across reload", async () => {
		const h = harness(); await h.fail(); await h.command("cancel");
		expect(h.statuses.size).toBe(0);
		await h.fail(); expect(h.statuses.get("magpie-quota")).toContain("awaiting");
		await h.command("off"); await h.reload();
		h.fetcher.mockClear(); await h.fail();
		expect(h.fetcher).not.toHaveBeenCalled();
		await h.command("status");
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("off"), "info");
		await h.command("on"); await h.fail();
		expect(h.fetcher).toHaveBeenCalledTimes(2);
	});

	it.each(["no-reset", "forbidden", "auth-error"])("reports %s without guessing a retry or exposing secrets", async kind => {
		const h = harness();
		if (kind === "no-reset") h.fetcher.mockResolvedValue(Response.json({ object: "list", data: [] }));
		if (kind === "forbidden") h.fetcher.mockImplementation(async () => Response.json({ message: "private-body-key" }, { status: 403 }));
		if (kind === "auth-error") h.auth.mockRejectedValue(new Error("private-auth-key"));
		await h.fail(); await vi.advanceTimersByTimeAsync(RETRY - NOW);
		expect(h.statuses.get("magpie-quota")).toContain("quota paused");
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(JSON.stringify(h.notify.mock.calls)).not.toMatch(/private-(?:body|auth)-key/);
	});

	it("drops an in-flight quota lookup after new user input", async () => {
		const h = harness();
		let release!: (value: Response) => void;
		h.fetcher.mockImplementation(() => new Promise(resolve => { release = resolve; }));
		await h.start(); const failure = h.finishMessage();
		await vi.advanceTimersByTimeAsync(0);
		await h.emit("input", { text: "stop", source: "interactive" });
		release(Response.json({ object: "list", data: [] }));
		await failure; await h.settled();
		await vi.advanceTimersByTimeAsync(RETRY - NOW);
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.statuses.size).toBe(0);
	});

	it("rechecks model and branch after asynchronous credential resolution", async () => {
		const h = harness(); await h.fail();
		let release!: (value: Awaited<ReturnType<typeof h.auth>>) => void;
		h.auth.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
		await vi.advanceTimersByTimeAsync(RETRY - NOW);
		await h.emit("input", { text: "stop", source: "interactive" });
		release({ ok: true, apiKey: "private-key", baseUrl: "https://active.example/v1" });
		await vi.advanceTimersByTimeAsync(1);
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.statuses.size).toBe(0);
	});

	it.each(["print", "json", "child"])("does not create a scheduler for %s sessions", async kind => {
		const h = harness(kind === "child" ? "tui" : kind as "print" | "json", kind === "child");
		await h.emit("session_start"); await h.fail();
		expect(h.fetcher).not.toHaveBeenCalled(); expect(h.statuses.size).toBe(0);
	});

	it("does not resume when the failed assistant is no longer the latest one", async () => {
		const h = harness(); await h.fail();
		h.session.appendMessage(message({ stopReason: "stop", timestamp: NOW + 1 }));
		await vi.advanceTimersByTimeAsync(RETRY - NOW);
		expect(h.sendMessage).not.toHaveBeenCalled(); expect(h.statuses.size).toBe(0);
	});

	it("deletes the runtime entry on session_shutdown while cancelling timers, clearing status, and preserving the wait checkpoint", async () => {
		const h = harness();
		await h.fail();
		expect(vi.getTimerCount()).toBe(1);
		h.setStatus.mockClear();
		h.appendEntry.mockClear();

		await h.emit("session_shutdown", { reason: "quit" });
		expect(vi.getTimerCount()).toBe(0);
		expect(h.statuses.size).toBe(0);
		expect(h.setStatus).toHaveBeenCalledWith("magpie-quota", undefined);
		expect(h.appendEntry).toHaveBeenCalledWith("magpie-auto-continue", expect.objectContaining({
			version: 1, enabled: true, wait: expect.objectContaining({ model: model.id, retryAt: RETRY }),
		}));

		// A deleted runtime must not react to subsequent events or clobber the saved checkpoint.
		h.setStatus.mockClear();
		h.appendEntry.mockClear();
		await h.emit("input", { text: "late", source: "interactive" });
		await h.emit("session_tree");
		await h.emit("session_shutdown", { reason: "quit" });
		expect(h.setStatus).not.toHaveBeenCalled();
		expect(h.appendEntry).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(RETRY - NOW + 60_000);
		expect(h.sendMessage).not.toHaveBeenCalled();

		// Re-entering the same session on the same extension instance still restores the paused checkpoint.
		await h.emit("session_start", { reason: "reload" });
		expect(h.statuses.get("magpie-quota")).toContain("quota paused");
		await h.command("resume");
		await vi.advanceTimersByTimeAsync(1);
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("aborts an in-flight quota lookup and deletes the runtime entry on session_shutdown", async () => {
		const h = harness();
		let lookupSignal: AbortSignal | undefined;
		let release!: (value: Response) => void;
		h.fetcher.mockImplementation((_url, init) => {
			lookupSignal = init?.signal ?? undefined;
			return new Promise(resolve => { release = resolve; });
		});
		await h.start();
		const pending = h.finishMessage();
		await vi.advanceTimersByTimeAsync(0);
		expect(lookupSignal?.aborted).toBe(false);

		await h.emit("session_shutdown", { reason: "quit" });
		expect(lookupSignal?.aborted).toBe(true);
		expect(h.statuses.size).toBe(0);

		h.setStatus.mockClear();
		h.appendEntry.mockClear();
		release(Response.json({ object: "list", data: [] }));
		await pending;
		await h.settled();
		await h.emit("input", { text: "after shutdown", source: "interactive" });
		expect(h.setStatus).not.toHaveBeenCalled();
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it.each(["session_before_switch", "session_before_fork"] as const)(
		"deletes the runtime entry and cancels pending timers and lookups on %s while preserving cancelled-switch recovery",
		async event => {
			const h = harness();
			await h.fail();
			expect(vi.getTimerCount()).toBe(1);
			h.setStatus.mockClear();
			h.appendEntry.mockClear();

			await h.emit(event, event === "session_before_switch" ? { reason: "new" } : { entryId: "e1", position: "before" });
			expect(vi.getTimerCount()).toBe(0);
			expect(h.statuses.size).toBe(0);
			expect(h.setStatus).toHaveBeenCalledWith("magpie-quota", undefined);

			// The closed session entry must be removed from runtimes rather than retained.
			h.setStatus.mockClear();
			h.appendEntry.mockClear();
			await h.emit("input", { text: "late", source: "interactive" });
			await h.emit("model_select");
			await h.emit("session_tree");
			await h.emit("session_shutdown", { reason: event === "session_before_switch" ? "new" : "fork" });
			expect(h.setStatus).not.toHaveBeenCalled();
			expect(h.appendEntry).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(RETRY - NOW + 60_000);
			expect(h.sendMessage).not.toHaveBeenCalled();

			// If the switch/fork was cancelled, the same session can re-enter cleanly via commands or the next turn.
			vi.setSystemTime(NOW);
			await h.command("status");
			expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("no quota wait is pending"), "info");
			await h.fail();
			expect(h.statuses.get("magpie-quota")).toContain("quota awaiting");

			// Also verify an in-flight quota lookup is aborted and cleaned up on switch/fork.
			let lookupSignal: AbortSignal | undefined;
			let release!: (value: Response) => void;
			h.fetcher.mockImplementationOnce((_url, init) => {
				lookupSignal = init?.signal ?? undefined;
				return new Promise(resolve => { release = resolve; });
			});
			await h.start();
			const pending = h.finishMessage();
			await vi.advanceTimersByTimeAsync(0);
			expect(lookupSignal?.aborted).toBe(false);

			await h.emit(event, event === "session_before_switch" ? { reason: "new" } : { entryId: "e2", position: "before" });
			expect(lookupSignal?.aborted).toBe(true);
			expect(h.statuses.size).toBe(0);
			h.setStatus.mockClear();
			h.appendEntry.mockClear();
			release(Response.json({ object: "list", data: [] }));
			await pending;
			await h.settled();
			await h.emit("input", { text: "after leave", source: "interactive" });
			expect(h.setStatus).not.toHaveBeenCalled();
			expect(h.appendEntry).not.toHaveBeenCalled();

			// Cancelled switch/fork preserves persisted disabled state on re-entry.
			await h.command("off");
			await h.emit(event, event === "session_before_switch" ? { reason: "new" } : { entryId: "e3", position: "before" });
			h.fetcher.mockClear();
			await h.fail();
			expect(h.fetcher).not.toHaveBeenCalled();
		},
	);

	it("cancels and deletes a prior session runtime when session_start replaces it directly", async () => {
		const h = harness();
		const firstCtx = h.ctx;
		const firstSetStatus = h.setStatus;
		const firstStatuses = h.statuses;

		await h.fail();
		expect(vi.getTimerCount()).toBe(1);
		expect(firstStatuses.get("magpie-quota")).toContain("quota awaiting");

		const second = h.replaceSession();
		h.appendEntry.mockClear();
		firstSetStatus.mockClear();

		await h.emit("session_start", { reason: "new" }, second.ctx);
		expect(vi.getTimerCount()).toBe(0);
		expect(firstStatuses.size).toBe(0);
		expect(firstSetStatus).toHaveBeenCalledWith("magpie-quota", undefined);
		// Must not write the old session's state into the replacement session.
		expect(h.appendEntry).not.toHaveBeenCalled();
		expect(second.session.getEntries().some(entry => entry.type === "custom" && entry.customType === "magpie-auto-continue")).toBe(false);

		// Prior session entry is gone from runtimes; advancing timers must not fire into the new session.
		firstSetStatus.mockClear();
		await h.emit("input", { text: "stale", source: "interactive" }, firstCtx);
		await h.emit("session_shutdown", { reason: "new" }, firstCtx);
		expect(firstSetStatus).not.toHaveBeenCalled();
		expect(h.appendEntry).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(RETRY - NOW + 60_000);
		expect(h.sendMessage).not.toHaveBeenCalled();

		// Replacement session operates normally.
		vi.setSystemTime(NOW);
		await h.fail();
		expect(second.statuses.get("magpie-quota")).toContain("quota awaiting");

		// Replacing a session that has an in-flight lookup (even with an ineligible session) aborts and drops it.
		let lookupSignal: AbortSignal | undefined;
		let release!: (value: Response) => void;
		h.fetcher.mockImplementationOnce((_url, init) => {
			lookupSignal = init?.signal ?? undefined;
			return new Promise(resolve => { release = resolve; });
		});
		await h.start();
		const pending = h.finishMessage();
		await vi.advanceTimersByTimeAsync(0);
		expect(lookupSignal?.aborted).toBe(false);

		const third = h.replaceSession("print");
		second.setStatus.mockClear();
		h.appendEntry.mockClear();
		await h.emit("session_start", { reason: "resume" }, third.ctx);
		expect(lookupSignal?.aborted).toBe(true);
		expect(second.statuses.size).toBe(0);
		expect(h.appendEntry).not.toHaveBeenCalled();

		second.setStatus.mockClear();
		release(Response.json({ object: "list", data: [] }));
		await pending;
		await h.emit("input", { text: "stale second", source: "interactive" }, second.ctx);
		expect(second.setStatus).not.toHaveBeenCalled();
	});

	it.each([
		"http://127.0.0.1:3425/?",
		"http://127.0.0.1:3425/#",
		"http://127.0.0.1:3425/v1?",
		"http://127.0.0.1:3425/v1#",
	])("rejects gateway URLs with bare query or fragment before querying or resuming: %s", async badBaseUrl => {
		const h = harness();
		h.auth.mockResolvedValue({ ok: true, apiKey: "private-key", baseUrl: badBaseUrl });
		await h.fail();
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.statuses.get("magpie-quota")).toContain("quota paused");
		expect(h.sendMessage).not.toHaveBeenCalled();

		// Also reject invalid URLs when resuming an already-scheduled wait.
		const h2 = harness();
		await h2.fail();
		h2.auth.mockResolvedValue({ ok: true, apiKey: "private-key", baseUrl: badBaseUrl });
		await vi.advanceTimersByTimeAsync(RETRY - NOW);
		expect(h2.statuses.get("magpie-quota")).toContain("check /login magpie");
		expect(h2.sendMessage).not.toHaveBeenCalled();
	});
});
