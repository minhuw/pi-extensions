// src/subagents-host.ts against a fake Subagents RPC bus: the calls as sent, replies, and lifecycle events.
import { afterEach, describe, expect, it } from "vitest";
import { superagentRegistry, ticketKey } from "../src/hook.ts";
import { createSubagentsHost, PROTOCOL_REQUIRED, type RpcBus } from "../src/subagents-host.ts";
import type { Ticket, WorkerEvent, WorkerHost } from "../src/types.ts";

type Handler = (params: Record<string, unknown>) => unknown;

/** An in-process bus like `pi.events`, with Subagents' RPC verbs answered by `handlers` (async, as `handleRpc` does). */
class FakeBus implements RpcBus {
	readonly listeners = new Map<string, Set<(data: unknown) => void>>();
	readonly requests: { verb: string; params: Record<string, unknown> }[] = [];
	readonly handlers = new Map<string, Handler>();
	version: number | undefined = 3;

	constructor() {
		this.handlers.set("ping", () => ({ version: this.version }));
	}
	on(channel: string, handler: (data: unknown) => void) {
		const set = this.listeners.get(channel) ?? new Set();
		set.add(handler);
		this.listeners.set(channel, set);
		return () => { set.delete(handler); };
	}
	emit(channel: string, data: unknown) {
		for (const handler of [...this.listeners.get(channel) ?? []]) handler(data);
		const match = /^subagents:rpc:(\w+)$/.exec(channel);
		if (!match) return;
		const verb = match[1]!;
		const params = data as Record<string, unknown>;
		const { requestId, ...rest } = params;
		this.requests.push({ verb, params: rest });
		const handler = this.handlers.get(verb);
		if (!handler || (verb === "ping" && this.version === undefined)) return;
		void (async () => {
			try {
				const result = await handler(rest);
				this.emit(`${channel}:reply:${String(requestId)}`, result === undefined ? { success: true } : { success: true, data: result });
			} catch (error) {
				this.emit(`${channel}:reply:${String(requestId)}`, { success: false, error: (error as Error).message });
			}
		})();
	}
	lifecycle(kind: "started" | "completed" | "failed", payload: Record<string, unknown>) { this.emit(`subagents:${kind}`, payload); }
	sent(verb: string) { return this.requests.filter((request) => request.verb === verb).map((request) => request.params); }
}

const ticket = (id: number, extra: Partial<Ticket> = {}): Ticket => ({
	version: 1, id, slug: "fix-login", title: "Fix login", request: "fix it", source: "fix it", createdAt: 1, updatedAt: 1, createdBy: "s", owner: "s",
	base: "b".repeat(40), target: "main", branch: `pi/${id}-fix-login`, worktree: `/repo/.git/superagent/worktrees/${id}-fix-login`, state: "working", ...extra,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const hosts: WorkerHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.disposeAll(); });

function setup(options: { tickets?: Map<number, Ticket>; timeoutMs?: number } = {}) {
	const bus = new FakeBus();
	const events: WorkerEvent[] = [];
	const tickets = options.tickets ?? new Map([[1, ticket(1)]]);
	let next = 0;
	bus.handlers.set("spawn", (params) => {
		const id = `agent-${++next}`;
		// Subagents emits `started` synchronously inside spawn, before its reply.
		bus.lifecycle("started", { id, type: params.type, description: (params.options as { description: string }).description });
		return { id };
	});
	bus.handlers.set("reopen", () => {
		const id = `agent-${++next}`;
		bus.lifecycle("started", { id, sessionFile: "/sessions/t1.jsonl" });
		return { id };
	});
	bus.handlers.set("stop", () => undefined);
	const host = createSubagentsHost({
		events: bus, commonDir: "/repo/.git", ticket: (id) => tickets.get(id), onEvent: (event) => events.push(event),
		timeoutMs: options.timeoutMs ?? 200, startTimeoutMs: 200, stopGraceMs: 100,
	});
	hosts.push(host);
	return { bus, host, events, tickets };
}

describe("subagents host", () => {
	it("spawns a ticket agent with exactly the contract's options and records its id", async () => {
		const { bus, host, events } = setup();
		await host.start({ ticket: ticket(1), prompt: "REQUEST", resume: false, parentToolCallId: "call-7" });
		expect(bus.requests.map((request) => request.verb)).toEqual(["ping", "spawn"]);
		expect(bus.sent("spawn")).toEqual([{
			type: "ticket", prompt: "REQUEST",
			options: {
				cwd: "/repo/.git/superagent/worktrees/1-fix-login", description: "#1 Fix login", name: "ticket-1",
				isBackground: false, notifyParent: false, retain: true, parentToolCallId: "call-7",
				linkData: { superagent: { ticketId: 1, branch: "pi/1-fix-login", title: "Fix login" } },
			},
		}]);
		expect(events).toEqual([{ type: "session", ticketId: 1, agentId: "agent-1" }]);
		expect(host.isLive(1)).toBe(true);
		expect(host.isRunning(1)).toBe(true);
		// The ticket is known to child sessions while its agent lives.
		expect(superagentRegistry().tickets.has(ticketKey("/repo/.git", 1))).toBe(true);
	});

	it("omits parentToolCallId when unknown", async () => {
		const { bus, host } = setup();
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		expect(bus.sent("spawn")[0]!.options).not.toHaveProperty("parentToolCallId");
	});

	it("maps completed and failed events of its agent to run ends with the run's tool calls", async () => {
		const { bus, host, events } = setup();
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		bus.lifecycle("completed", { id: "someone-else", status: "completed", result: "x", runToolUses: 9 });
		bus.lifecycle("completed", { id: "agent-1", status: "completed", result: "all done", toolUses: 12, runToolUses: 4, sessionFile: "/s/1.jsonl" });
		expect(host.isRunning(1)).toBe(false);
		expect(host.isLive(1)).toBe(true);
		expect(events.slice(1)).toEqual([
			{ type: "session", ticketId: 1, sessionFile: "/s/1.jsonl" },
			{ type: "run_end", ticketId: 1, text: "all done", toolCalls: 4 },
		]);
		bus.lifecycle("started", { id: "agent-1" });
		expect(host.isRunning(1)).toBe(true);
		bus.lifecycle("failed", { id: "agent-1", status: "error", error: "provider down", runToolUses: 0 });
		bus.lifecycle("failed", { id: "agent-1", status: "stopped", result: "partial", runToolUses: 1 });
		bus.lifecycle("failed", { id: "agent-1", status: "aborted", error: "turn limit", runToolUses: 2 });
		expect(events.slice(3)).toEqual([
			{ type: "run_end", ticketId: 1, text: "", toolCalls: 0, error: "provider down" },
			{ type: "run_end", ticketId: 1, text: "partial", toolCalls: 1, aborted: true },
			{ type: "run_end", ticketId: 1, text: "", toolCalls: 2, aborted: true, error: "turn limit" },
		]);
	});

	it("replays a settlement that arrived before the spawn reply", async () => {
		const { bus, host, events } = setup();
		bus.handlers.set("spawn", () => {
			bus.lifecycle("started", { id: "fast" });
			bus.lifecycle("completed", { id: "fast", status: "completed", result: "quick", runToolUses: 1 });
			return { id: "fast" };
		});
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		expect(events).toEqual([{ type: "session", ticketId: 1, agentId: "fast" }, { type: "run_end", ticketId: 1, text: "quick", toolCalls: 1 }]);
		expect(host.isRunning(1)).toBe(false);
	});

	it("sends follow-ups: steered into a running agent, resumed for a settled one", async () => {
		const { bus, host } = setup();
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		bus.handlers.set("send", () => ({ delivery: "steered" }));
		expect(await host.send(1, "also this")).toBe("steered");
		bus.lifecycle("completed", { id: "agent-1", status: "completed", result: "", runToolUses: 1 });
		bus.handlers.set("send", () => ({ delivery: "resumed" }));
		expect(await host.send(1, "and now that")).toBe("prompted");
		expect(host.isRunning(1)).toBe(true);
		expect(bus.sent("send")).toEqual([{ agentId: "agent-1", text: "also this" }, { agentId: "agent-1", text: "and now that" }]);
	});

	it("reopens the ticket's session file when Subagents no longer knows the agent", async () => {
		const tickets = new Map([[1, ticket(1, { sessionFile: "/sessions/t1.jsonl" })]]);
		const { bus, host, events } = setup({ tickets });
		await host.start({ ticket: tickets.get(1)!, prompt: "P", resume: false });
		bus.lifecycle("completed", { id: "agent-1", status: "completed", result: "", runToolUses: 1 });
		bus.handlers.set("send", (params) => { throw new Error(`Unknown agent "${String(params.agentId)}"`); });
		expect(await host.send(1, "continue please")).toBe("reopened");
		expect(bus.sent("reopen")).toEqual([{
			sessionFile: "/sessions/t1.jsonl", type: "ticket", prompt: "continue please",
			options: { cwd: tickets.get(1)!.worktree, description: "#1 Fix login", name: "ticket-1", isBackground: false, notifyParent: false, retain: true },
		}]);
		expect(events).toContainEqual({ type: "session", ticketId: 1, agentId: "agent-2" });
		// Events of the new agent count; the old one's do not.
		bus.lifecycle("completed", { id: "agent-1", status: "completed", result: "old", runToolUses: 0 });
		bus.lifecycle("completed", { id: "agent-2", status: "completed", result: "new", runToolUses: 3 });
		expect(events.filter((event) => event.type === "run_end")).toEqual([
			{ type: "run_end", ticketId: 1, text: "", toolCalls: 1 },
			{ type: "run_end", ticketId: 1, text: "new", toolCalls: 3 },
		]);
	});

	it("passes other send errors through", async () => {
		const { bus, host } = setup();
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		bus.lifecycle("completed", { id: "agent-1", status: "completed", result: "", runToolUses: 1 });
		bus.handlers.set("send", () => { throw new Error("Agent is owned by another agent or workflow"); });
		await expect(host.send(1, "x")).rejects.toThrow("Agent is owned by another agent or workflow");
		expect(bus.sent("reopen")).toEqual([]);
		expect(host.isRunning(1)).toBe(false);
	});

	it("starts a resumed ticket by reopening its session file", async () => {
		const tickets = new Map([[1, ticket(1, { state: "interrupted", sessionFile: "/sessions/t1.jsonl" })]]);
		const { bus, host, events } = setup({ tickets });
		await host.start({ ticket: tickets.get(1)!, prompt: "RECOVERY\n\nmessage", resume: true });
		expect(bus.sent("spawn")).toEqual([]);
		expect(bus.sent("reopen")).toEqual([expect.objectContaining({ sessionFile: "/sessions/t1.jsonl", type: "ticket", prompt: "RECOVERY\n\nmessage" })]);
		expect(events).toEqual([{ type: "session", ticketId: 1, agentId: "agent-1" }, { type: "session", ticketId: 1, sessionFile: "/sessions/t1.jsonl" }]);
		await expect(host.start({ ticket: ticket(2), prompt: "x", resume: true })).rejects.toThrow("no recorded session file");
	});

	it("stops a running agent, waits for it to settle, and reports no run end", async () => {
		const { bus, host, events } = setup();
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		bus.handlers.set("stop", (params) => { setTimeout(() => bus.lifecycle("failed", { id: params.agentId, status: "stopped", runToolUses: 0 }), 5); return undefined; });
		await host.stop(1);
		expect(bus.sent("stop")).toEqual([{ agentId: "agent-1" }]);
		expect(events.filter((event) => event.type === "run_end")).toEqual([]);
		expect(host.isLive(1)).toBe(false);
		expect(superagentRegistry().tickets.has(ticketKey("/repo/.git", 1))).toBe(false);
	});

	it("does not stop an idle agent", async () => {
		const { bus, host } = setup();
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		bus.lifecycle("completed", { id: "agent-1", status: "completed", result: "", runToolUses: 1 });
		await host.stop(1);
		expect(bus.sent("stop")).toEqual([]);
		expect(host.isLive(1)).toBe(false);
	});

	it("refuses to run tickets without Subagents protocol 3, and checks again at the next use", async () => {
		const { bus, host } = setup();
		bus.version = 2;
		await expect(host.start({ ticket: ticket(1), prompt: "P", resume: false })).rejects.toThrow(`${PROTOCOL_REQUIRED}, and the loaded Subagents speaks protocol 2`);
		bus.version = undefined;
		await expect(host.start({ ticket: ticket(1), prompt: "P", resume: false })).rejects.toThrow(`${PROTOCOL_REQUIRED}: no reply to subagents:rpc:ping`);
		expect(PROTOCOL_REQUIRED).toBe("Subagents with RPC protocol 3 is required to run tickets");
		expect(bus.sent("spawn")).toEqual([]);
		expect(host.isLive(1)).toBe(false);
		bus.version = 3;
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		expect(host.isLive(1)).toBe(true);
		// Checked once per host after success.
		await host.send(1, "x").catch(() => {});
		expect(bus.sent("ping")).toHaveLength(3);
	});

	it("reports spawn errors and forgets the ticket", async () => {
		const { bus, host } = setup();
		bus.handlers.set("spawn", () => { throw new Error('Unknown or disabled agent type: "ticket". Available: worker.'); });
		await expect(host.start({ ticket: ticket(1), prompt: "P", resume: false })).rejects.toThrow("Unknown or disabled agent type");
		expect(host.isLive(1)).toBe(false);
		expect(superagentRegistry().tickets.has(ticketKey("/repo/.git", 1))).toBe(false);
	});

	it("disposes: stops running agents and ignores later events", async () => {
		const { bus, host, events } = setup();
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		await host.disposeAll();
		await tick();
		expect(bus.sent("stop")).toEqual([{ agentId: "agent-1" }]);
		bus.lifecycle("failed", { id: "agent-1", status: "stopped", runToolUses: 0 });
		expect(events.filter((event) => event.type === "run_end")).toEqual([]);
		await expect(host.start({ ticket: ticket(1), prompt: "P", resume: false })).rejects.toThrow("shutting down");
	});

	it("forwards reports and session files from the hook target", async () => {
		const { host, events } = setup();
		await host.start({ ticket: ticket(1), prompt: "P", resume: false });
		const target = superagentRegistry().tickets.get(ticketKey("/repo/.git", 1))!;
		expect(target.ticket()?.title).toBe("Fix login");
		target.session("/s/child.jsonl");
		target.report({ state: "ready", summary: "done", at: 3 });
		expect(events.slice(1)).toEqual([
			{ type: "session", ticketId: 1, sessionFile: "/s/child.jsonl" },
			{ type: "report", ticketId: 1, report: { state: "ready", summary: "done", at: 3 } },
		]);
	});
});
