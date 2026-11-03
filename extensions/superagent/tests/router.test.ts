// Superagent and direct mode in real Pi sessions on the faux provider, with the extension loaded from index.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentResumeBlockReason, agentTypeBlockReason, blockReason } from "../src/router.ts";
import { MODE_ENTRY, STATUS_KEY, TICKETS_MESSAGE, WIDGET_KEY, type TicketStore } from "../src/types.ts";
import { customMessages, modulesExist, Notes, startSession, toolResults, waitFor, Workspace, type Harness } from "./support/router-runtime.ts";

const READ_ONLY = ["read", "grep", "find", "ls"];
const TICKET_TOOLS = ["ticket_create", "ticket_message", "ticket_status", "ticket_merge", "ticket_close", "git_read"];

describe.skipIf(!modulesExist)("superagent router", () => {
	let workspace: Workspace;
	const harnesses: Harness[] = [];
	const start = async (options: Partial<Parameters<typeof startSession>[0]> = {}) => {
		const harness = await startSession({ workspace, ...options });
		harnesses.push(harness);
		return harness;
	};
	const store = async (): Promise<TicketStore> => (await import("../src/store.ts")).openStore(workspace.commonDir);

	beforeEach(async () => { workspace = await Workspace.create(); });
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.shutdown();
		await workspace.cleanup();
	});

	/** Every request's serialized transcript, and a reply for each from `reply`. */
	function script(h: Harness, reply: (transcript: string, call: number) => ReturnType<FauxResponseFactory>, count = 30): string[] {
		const seen: string[] = [];
		const step: FauxResponseFactory = (context) => { const text = JSON.stringify(context.messages); seen.push(text); return reply(text, seen.length); };
		h.faux.setResponses(Array.from({ length: count }, () => step));
		return seen;
	}

	it("starts direct by default without router instructions", async () => {
		const h = await start();
		expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", ...TICKET_TOOLS]));
		expect(h.notes.statuses.get(STATUS_KEY)).toBe("superagent: direct · worktree");
		const seen = script(h, (_text, call) => call === 1
			? fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" })
			: fauxAssistantMessage("done"));
		await h.session.prompt("go");
		expect(toolResults(h.session).find((result) => result.name === "bash")?.isError).toBe(false);
		expect(seen[0]).not.toContain("You are the router of this repository.");
		expect(customMessages(h.session, TICKETS_MESSAGE)).toEqual([]);
	});

	it("applies the router tool set when settings enable it and runs git_read", async () => {
		await workspace.settings({ enabled: true });
		const h = await start();
		const active = h.session.getActiveToolNames();
		for (const name of [...READ_ONLY, ...TICKET_TOOLS]) expect(active).toContain(name);
		for (const name of ["edit", "write", "bash"]) expect(active).not.toContain(name);
		expect(h.notes.statuses.get(STATUS_KEY)).toBe("superagent: on · worktree");
		const seen = script(h, (_text, call) => call === 1
			? fauxAssistantMessage([
				fauxToolCall("bash", { command: "touch x" }, { id: "c1" }),
				fauxToolCall("edit", { path: "README.md", edits: [] }, { id: "c2" }),
				fauxToolCall("git_read", { args: ["log", "--oneline"] }, { id: "c3" }),
			], { stopReason: "toolUse" })
			: fauxAssistantMessage("done"));
		await h.session.prompt("what changed recently?");
		const results = toolResults(h.session);
		// Inactive tools never run: Pi itself refuses them.
		expect(results.find((result) => result.name === "bash")?.isError).toBe(true);
		expect(results.find((result) => result.name === "edit")?.isError).toBe(true);
		expect(blockReason("bash")).toBe("bash is not available in superagent mode: create a ticket with ticket_create for changes, or switch to direct mode with /superagent off.");
		expect(results.find((result) => result.name === "git_read")).toMatchObject({ isError: false, text: expect.stringContaining("initial commit") });
		expect(seen[0]).toContain("You are the router of this repository.");
	});

	it("re-applies the router set when another extension changes the active tools", async () => {
		await workspace.settings({ enabled: true });
		const atStart: string[][] = [];
		const h = await start({ extensions: [(pi) => {
			pi.on("agent_start", () => { atStart.push(pi.getActiveTools()); });
			pi.on("agent_end", () => { pi.setActiveTools([...pi.getActiveTools(), "bash"]); });
		}] });
		script(h, (_text, call) => call === 2 ? fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }) : fauxAssistantMessage("ok"));
		await h.session.prompt("hello");
		expect(h.session.getActiveToolNames()).toContain("bash");
		await h.session.prompt("run ls");
		expect(atStart.map((tools) => tools.includes("bash"))).toEqual([false, false]);
		expect(toolResults(h.session).find((result) => result.name === "bash")?.isError).toBe(true);
	});

	it("blocks model-issued calls to active tools outside the router set with the reason", async () => {
		await workspace.settings({ enabled: true });
		const h = await start({ extensions: [(pi) => {
			// Loaded after superagent: re-activates tools once superagent applied its set.
			pi.on("before_agent_start", () => { pi.setActiveTools([...pi.getActiveTools(), "bash", "edit"]); return undefined; });
		}] });
		script(h, (_text, call) => call === 1
			? fauxAssistantMessage([fauxToolCall("bash", { command: "touch x" }, { id: "c1" }), fauxToolCall("edit", { path: "README.md", edits: [] }, { id: "c2" })], { stopReason: "toolUse" })
			: fauxAssistantMessage("done"));
		await h.session.prompt("change it");
		const results = toolResults(h.session);
		expect(results.find((result) => result.name === "bash")).toMatchObject({ isError: true, text: blockReason("bash") });
		expect(results.find((result) => result.name === "edit")).toMatchObject({ isError: true, text: blockReason("edit") });
	});

	it("stays direct outside git, in child sessions, and in print mode", async () => {
		await workspace.settings({ enabled: true });
		const outside = await start({ cwd: workspace.plain });
		expect(outside.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
		expect(outside.session.getActiveToolNames()).not.toContain("ticket_create");
		expect(outside.notes.statuses.get(STATUS_KEY)).toBeUndefined();

		const child = await start({ sessionManager: SessionManager.create(workspace.repo, workspace.sessionDir, { parentSession: "/parent.jsonl" }) });
		expect(child.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "edit"]));
		expect(child.session.getActiveToolNames()).not.toContain("ticket_create");

		const print = await start({ mode: "print" });
		expect(print.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "edit"]));
		script(print, (_text, call) => call === 1 ? fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }) : fauxAssistantMessage("ok"));
		await print.session.prompt("go");
		expect(toolResults(print.session).find((result) => result.name === "bash")?.isError).toBe(false);
	});

	it("starts direct when settings disable it", async () => {
		await workspace.settings({ enabled: false, maxWorkers: 99 });
		const h = await start();
		expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "edit", "ticket_create"]));
		expect(h.notes.statuses.get(STATUS_KEY)).toBe("superagent: direct · worktree");
		expect(h.notes.messages.some((message) => message.includes("\"maxWorkers\" must be an integer from 1 to 16"))).toBe(true);
	});

	it("switches off and on, restoring the session's tools, and keeps the choice across a reload", async () => {
		const h = await start();
		await h.session.prompt("/superagent off");
		const direct = h.session.getActiveToolNames();
		expect(direct).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", ...TICKET_TOOLS]));
		expect(h.notes.statuses.get(STATUS_KEY)).toBe("superagent: direct · worktree");
		await h.session.reload();
		expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "edit"]));
		await h.session.prompt("/superagent on");
		expect(h.session.getActiveToolNames()).not.toContain("bash");
		await h.session.reload();
		expect(h.session.getActiveToolNames()).not.toContain("bash");
		expect(h.session.getActiveToolNames()).toContain("ticket_create");
		await h.session.prompt("/superagent off");
		expect(h.session.getActiveToolNames().sort()).toEqual([...direct].sort());
		const modes = h.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === MODE_ENTRY ? [(entry.data as { mode: string }).mode] : []);
		expect(modes).toEqual(["superagent", "direct"]);
	});

	it("keeps pika's relay and recall tools, loaded after superagent, in the router set and restores them in direct mode", async () => {
		await workspace.settings({ enabled: true });
		// pika loads last in `pi.extensions`; relay registers its tools only after every `session_start` handler.
		const pika = (await import("../../pika/index.ts")).default;
		const h = await start({ extensions: [pika] });
		const pikaTools = ["relay_list", "relay_send", "relay_status", "recall_search", "recall_read"];
		await waitFor(() => pikaTools.every((name) => h.session.getAllTools().some((tool) => tool.name === name)), 5_000, "relay's tools");
		const seen = script(h, () => fauxAssistantMessage("done"));
		await h.session.prompt("what did we do before?");
		expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(pikaTools));
		expect(h.session.getActiveToolNames()).not.toContain("bash");
		for (const name of pikaTools) expect(seen[0]).toContain(`"${name}"`);
		await h.session.prompt("/superagent off");
		expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "edit", ...pikaTools]));
		expect(h.errors).toEqual([]);
	});

	it("handles #N input without a model turn, refuses closed tickets, and passes other numbers to the model", async () => {
		const tickets = await store();
		const ticket = tickets.create({ title: "Old work", request: "do it", source: "do it", createdBy: "elsewhere", base: workspace.git("rev-parse", "HEAD").trim(), target: "main" }, "elsewhere");
		tickets.update(ticket.id, { state: "closed", closedReason: "abandoned" });
		const h = await start();
		script(h, () => fauxAssistantMessage("should not run"));
		const calls = h.faux.state.callCount;
		await h.session.prompt("#1");
		await waitFor(() => h.notes.messages.some((message) => message.startsWith("#1 Old work")), 5_000, "ticket shown");
		await h.session.prompt("#1 more please");
		expect(h.notes.messages).toContain("Ticket #1 is closed; it takes no more messages.");
		expect(h.faux.state.callCount).toBe(calls);
		expect(h.session.messages.filter((message) => message.role === "user")).toEqual([]);
		// No ticket #9, so it is ordinary text such as an issue number: a normal prompt, as is a hashtag.
		await h.session.prompt("#9 is the issue to look at");
		expect(h.faux.state.callCount).toBe(calls + 1);
		await h.session.prompt("#hashtag");
		expect(h.faux.state.callCount).toBe(calls + 2);
	});

	it("gives the tickets message only when the summary changed", async () => {
		await workspace.settings({ enabled: true });
		const tickets = await store();
		tickets.create({ title: "Pending job", request: "x", source: "x", createdBy: "elsewhere", base: workspace.git("rev-parse", "HEAD").trim(), target: "main" }, "elsewhere");
		const h = await start();
		script(h, () => fauxAssistantMessage("ok"));
		await h.session.prompt("one");
		await h.session.prompt("two");
		let messages = customMessages(h.session, TICKETS_MESSAGE);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ display: false, content: expect.stringContaining("#1 [interrupted] Pending job") });
		tickets.update(1, { state: "closed" });
		await h.session.prompt("three");
		messages = customMessages(h.session, TICKETS_MESSAGE);
		expect(messages.map((message) => message.content)).toEqual([expect.stringContaining("Pending job"), "[superagent] Workspace mode: worktree. No tickets are open."]);
		await h.session.reload();
		await h.session.prompt("four");
		expect(customMessages(h.session, TICKETS_MESSAGE)).toHaveLength(2);
	});

	it("allows Agent for the routerAgents types only, and never to resume a ticket's agent", async () => {
		const tickets = await store();
		const ticket = tickets.create({ title: "Old work", request: "x", source: "x", createdBy: "elsewhere", base: workspace.git("rev-parse", "HEAD").trim(), target: "main" }, "elsewhere");
		tickets.update(ticket.id, { agentId: "agent-77" });
		const ran: string[] = [];
		const h = await start({ extensions: [(pi) => {
			for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) {
				pi.registerTool({
					name, label: name, description: `stub ${name}`,
					parameters: Type.Object({ subagent_type: Type.Optional(Type.String()), resume: Type.Optional(Type.String()), agent_id: Type.Optional(Type.String()) }),
					async execute(_id, params) { ran.push(`${name}:${JSON.stringify(params)}`); return { content: [{ type: "text", text: "ok" }], details: {} }; },
				});
			}
		}] });
		await h.session.prompt("/superagent off");
		await h.session.prompt("/superagent on");
		const active = h.session.getActiveToolNames();
		for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) expect(active).toContain(name);
		script(h, (_text, call) => call === 1
			? fauxAssistantMessage([
				fauxToolCall("Agent", { subagent_type: "recon" }, { id: "a1" }),
				fauxToolCall("Agent", { subagent_type: "worker" }, { id: "a2" }),
				fauxToolCall("Agent", { subagent_type: "recon", resume: "agent-77" }, { id: "a3" }),
				fauxToolCall("get_subagent_result", { agent_id: "x" }, { id: "a4" }),
			], { stopReason: "toolUse" })
			: fauxAssistantMessage("done"));
		await h.session.prompt("look around");
		const results = toolResults(h.session).filter((result) => result.name === "Agent");
		expect(results.map((result) => result.isError)).toEqual([false, true, true]);
		expect(results[1]!.text).toBe(agentTypeBlockReason("worker", ["recon", "reviewer", "expert"]));
		expect(results[2]!.text).toBe(agentResumeBlockReason("agent-77", 1));
		expect(ran).toEqual(['Agent:{"subagent_type":"recon"}', 'get_subagent_result:{"agent_id":"x"}']);
	});

	it("shows the board widget in the TUI only, grouped, and hides it without open tickets", async () => {
		const tickets = await store();
		const base = workspace.git("rev-parse", "HEAD").trim();
		tickets.create({ title: "First", request: "x", source: "x", createdBy: "elsewhere", base, target: "main" }, "elsewhere");
		const rpc = await start();
		expect(rpc.notes.widgets.has(WIDGET_KEY)).toBe(false);
		await rpc.shutdown();
		const tui = await start({ mode: "tui" });
		await tui.session.prompt("/tickets");
		// Startup marked the lock-less ticket interrupted: it needs the user.
		expect(tui.notes.widgets.get(WIDGET_KEY)).toEqual(["tickets · worktree workspace", "needs you: #1 First (interrupted)"]);
		await tui.session.prompt("/tickets close 1");
		expect(tui.notes.widgets.get(WIDGET_KEY)).toBeUndefined();
	});
});
