// src/hook.ts in real Pi sessions on the faux provider: activation, ticket_report, the prompt section, blocked tools.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { acquireHook, HOOK_NAME, registerTicket, superagentRegistry, ticketBlockReason, ticketKey, ticketSessionExtension, type TicketHookTarget } from "../src/hook.ts";
import { CHILD_SESSION_HOOKS, SESSION_LINK_TYPE, type Ticket, type TicketReport } from "../src/types.ts";
import { startSession, toolResults, Workspace, type Harness } from "./support/router-runtime.ts";

/** Stand-ins for Herder's and Impeccable's tools, which a ticket session must not call. */
const stubs: ExtensionFactory = (pi) => {
	for (const name of ["herder_status", "impeccable_question", "other_tool"]) {
		pi.registerTool({
			name, label: name, description: `stub ${name}`, parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: `${name} ran` }], details: {} }; },
		});
	}
};

describe("ticket session hook", () => {
	let workspace: Workspace;
	const harnesses: Harness[] = [];
	const cleanups: (() => void)[] = [];
	beforeEach(async () => { workspace = await Workspace.create(); });
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.shutdown();
		for (const cleanup of cleanups.splice(0)) cleanup();
		await workspace.cleanup();
	});

	const ticket = (): Ticket => ({
		version: 1, id: 1, slug: "fix", title: "Fix login", request: "fix", source: "fix", createdAt: 1, updatedAt: 1, createdBy: "s", owner: "s",
		base: "a".repeat(40), target: "main", branch: "pi/1-fix", worktree: workspace.repo, state: "working",
	});

	function target() {
		const reports: TicketReport[] = [];
		const sessions: (string | undefined)[] = [];
		const value: TicketHookTarget = { ticket, report: (report) => reports.push(report), session: (file) => sessions.push(file) };
		return { value, reports, sessions };
	}

	async function child(agentType: string, link: Record<string, unknown> | undefined) {
		const sessionManager = SessionManager.create(workspace.repo, workspace.sessionDir, { parentSession: "/parent.jsonl" });
		sessionManager.appendCustomEntry(SESSION_LINK_TYPE, { kind: "subagent", agentType, ...(link ? { superagent: link } : {}) });
		const harness = await startSession({ workspace, sessionManager, extensions: [ticketSessionExtension, stubs] });
		harnesses.push(harness);
		return harness;
	}

	function script(h: Harness, calls: ReturnType<typeof fauxToolCall>[]): string[] {
		const prompts: string[] = [];
		const step: FauxResponseFactory = (context) => {
			prompts.push(JSON.stringify(context.messages));
			return prompts.length === 1 ? fauxAssistantMessage(calls, { stopReason: "toolUse" }) : fauxAssistantMessage("done");
		};
		h.faux.setResponses([step, step, step]);
		return prompts;
	}

	it("activates in a ticket session of a live ticket: ticket_report, the prompt section, blocked tools, the session file", async () => {
		const t = target();
		cleanups.push(registerTicket(ticketKey(workspace.commonDir, 1), t.value));
		const h = await child("ticket", { ticketId: 1, branch: "pi/1-fix", title: "Fix login" });
		expect(t.sessions).toEqual([h.session.sessionFile]);
		expect(h.session.getActiveToolNames()).toContain("ticket_report");
		// Superagent's own extension also loads here and stays direct: no router tools, the session keeps its tools.
		expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "edit"]));
		const prompts = script(h, [
			fauxToolCall("herder_status", {}, { id: "c1" }),
			fauxToolCall("impeccable_question", {}, { id: "c2" }),
			fauxToolCall("other_tool", {}, { id: "c3" }),
			fauxToolCall("ticket_report", { state: "ready", summary: "fixed", tests: "npm test" }, { id: "c4" }),
		]);
		h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "herder_status", "impeccable_question", "other_tool"]);
		await h.session.prompt("REQUEST");
		const results = toolResults(h.session);
		expect(results.find((result) => result.name === "herder_status")).toMatchObject({ isError: true, text: ticketBlockReason("herder_status") });
		expect(results.find((result) => result.name === "impeccable_question")).toMatchObject({ isError: true, text: ticketBlockReason("impeccable_question") });
		expect(results.find((result) => result.name === "other_tool")).toMatchObject({ isError: false, text: "other_tool ran" });
		expect(results.find((result) => result.name === "ticket_report")).toMatchObject({ isError: false, text: "Reported." });
		expect(ticketBlockReason("herder_status")).toBe('herder_status is not available in a ticket session: ask the user through ticket_report (state "progress" with a question, or "blocked") instead.');
		expect(t.reports).toEqual([{ state: "ready", summary: "fixed", tests: "npm test", at: expect.any(Number) }]);
		expect(prompts[0]).toContain("# Your ticket");
		expect(prompts[0]).toContain('You are the agent for ticket #1, \\"Fix login\\"');
		expect(prompts[0]).toContain("on branch `pi/1-fix`");
	});

	it("stays inert for other agent types, unknown tickets, and main sessions", async () => {
		const t = target();
		cleanups.push(registerTicket(ticketKey(workspace.commonDir, 1), t.value));
		const worker = await child("worker", { ticketId: 1 });
		const unknown = await child("ticket", { ticketId: 2 });
		const noLink = await child("ticket", undefined);
		for (const h of [worker, unknown, noLink]) {
			expect(h.session.getAllTools().map((tool) => tool.name)).not.toContain("ticket_report");
			h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "herder_status"]);
			const prompts = script(h, [fauxToolCall("herder_status", {}, { id: "c1" })]);
			await h.session.prompt("go");
			expect(toolResults(h.session).find((result) => result.name === "herder_status")).toMatchObject({ isError: false });
			expect(prompts[0]).not.toContain("# Your ticket");
		}
		expect(t.sessions).toEqual([]);
	});

	it("is in the child-session hook Set while an instance holds it", () => {
		const hooks = () => (globalThis as Record<symbol, unknown>)[Symbol.for(CHILD_SESSION_HOOKS)] as Set<{ name: string }> | undefined;
		const first = acquireHook();
		const second = acquireHook();
		expect([...hooks()!].filter((hook) => hook.name === HOOK_NAME)).toHaveLength(1);
		first();
		first();
		expect([...hooks()!].some((hook) => hook.name === HOOK_NAME)).toBe(true);
		second();
		expect([...hooks()!].some((hook) => hook.name === HOOK_NAME)).toBe(false);
		expect(superagentRegistry().users).toBe(0);
	});
});
