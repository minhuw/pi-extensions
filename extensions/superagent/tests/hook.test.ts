// src/hook.ts in real Pi sessions on the faux provider: activation, ticket_report, the prompt section, blocked tools.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENT_ISOLATION_BLOCK_REASON, gitBlockReason, overlapNote, writeBlockReason } from "../src/shared-guard.ts";
import { acquireHook, HOOK_NAME, registerTicket, superagentRegistry, ticketBlockReason, ticketKey, ticketSessionExtension, type TicketHookTarget } from "../src/hook.ts";
import { CHILD_SESSION_HOOKS, SESSION_LINK_TYPE, type Ticket, type TicketReport } from "../src/types.ts";
import { startSession, toolResults, Workspace, type Harness } from "./support/router-runtime.ts";

/** Stand-ins for Herder's and Impeccable's tools, which a ticket session must not call. */
const stubs: ExtensionFactory = (pi) => {
	for (const name of ["herder_status", "impeccable_question", "other_tool", "Agent"]) {
		pi.registerTool({
			name, label: name, description: `stub ${name}`, parameters: Type.Object({}, { additionalProperties: true }),
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

	describe("shared workspace", () => {
		const sharedTicket = (): Ticket => ({ ...ticket(), workspace: "shared", branch: "main", worktree: workspace.repo });

		function sharedTarget(others: Record<string, number[]> = {}) {
			const touched: string[] = [];
			const value: TicketHookTarget = {
				ticket: sharedTicket, report: () => {}, session: () => {},
				touch: (path) => { touched.push(path); return others[path] ?? []; },
			};
			return { value, touched };
		}

		async function session(link: Record<string, unknown>) {
			const sessionManager = SessionManager.create(workspace.repo, workspace.sessionDir, { parentSession: "/parent.jsonl" });
			sessionManager.appendCustomEntry(SESSION_LINK_TYPE, { kind: "subagent", ...link });
			const harness = await startSession({ workspace, sessionManager, extensions: [ticketSessionExtension, stubs] });
			harnesses.push(harness);
			harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "Agent"]);
			return harness;
		}

		/** One assistant message per step: each step's tool calls, or a function run first (to change files between calls). */
		function steps(h: Harness, list: (ReturnType<typeof fauxToolCall>[] | (() => ReturnType<typeof fauxToolCall>[]))[]): string[] {
			const prompts: string[] = [];
			let index = 0;
			const step: FauxResponseFactory = (context) => {
				prompts.push(JSON.stringify(context.messages));
				const next = list[index++];
				if (!next) return fauxAssistantMessage("done");
				return fauxAssistantMessage(typeof next === "function" ? next() : next, { stopReason: "toolUse" });
			};
			h.faux.setResponses(Array.from({ length: list.length + 1 }, () => step));
			return prompts;
		}

		const call = (name: string, input: Parameters<typeof fauxToolCall>[1]) => fauxToolCall(name, input);
		const result = (h: Harness, index: number) => toolResults(h.session)[index]!;

		it("registers ticket sessions and treats shared descendants (children and grandchildren) as part of the ticket", async () => {
			const t = sharedTarget();
			cleanups.push(registerTicket(ticketKey(workspace.commonDir, 1), t.value));
			const ticketSession = await session({ agentType: "ticket", superagent: { ticketId: 1 } });
			const ticketId = ticketSession.session.sessionManager.getSessionId();
			expect(superagentRegistry().sessions.get(ticketId)).toBe(ticketKey(workspace.commonDir, 1));
			const childSession = await session({ agentType: "worker", parentSessionId: ticketId });
			const childId = childSession.session.sessionManager.getSessionId();
			expect(superagentRegistry().sessions.get(childId)).toBe(ticketKey(workspace.commonDir, 1));
			const grandchild = await session({ agentType: "recon", parentSessionId: childId });
			const unrelated = await session({ agentType: "worker", parentSessionId: "someone-else" });
			for (const h of [childSession, grandchild]) {
				expect(h.session.getAllTools().map((tool) => tool.name)).not.toContain("ticket_report");
				const prompts = steps(h, [[call("bash", { command: "git commit -qm x" })]]);
				await h.session.prompt("go");
				expect(result(h, 0)).toMatchObject({ isError: true, text: gitBlockReason(["git commit"]) });
				expect(prompts[0]).toContain("# Shared working tree");
			}
			const prompts = steps(unrelated, [[call("bash", { command: "git status --short" })], [call("bash", { command: "git commit -qm x --allow-empty" })]]);
			await unrelated.session.prompt("go");
			expect(toolResults(unrelated.session).every((r) => !r.isError)).toBe(true);
			expect(prompts[0]).not.toContain("# Shared working tree");
			// Shutting a session down removes it from the registry.
			await grandchild.shutdown();
			expect([...superagentRegistry().sessions.values()].filter((key) => key === ticketKey(workspace.commonDir, 1))).toHaveLength(2);
		});

		it("does not extend to descendants of a worktree ticket", async () => {
			const t = target();
			cleanups.push(registerTicket(ticketKey(workspace.commonDir, 1), t.value));
			const ticketSession = await session({ agentType: "ticket", superagent: { ticketId: 1 } });
			const h = await session({ agentType: "worker", parentSessionId: ticketSession.session.sessionManager.getSessionId() });
			steps(h, [[call("Agent", { isolation: "worktree" })]]);
			await h.session.prompt("go");
			expect(result(h, 0)).toMatchObject({ isError: false });
		});

		it("blocks git state commands but runs read-only git", async () => {
			const t = sharedTarget();
			cleanups.push(registerTicket(ticketKey(workspace.commonDir, 1), t.value));
			const h = await session({ agentType: "ticket", superagent: { ticketId: 1 } });
			const blocked = ["git add -A", "git commit -qm x", "git checkout -- README.md", "git switch -c x", "git restore README.md", "git reset --hard", "git stash", "git clean -fd",
				"git rebase main", "git merge x", "git cherry-pick HEAD", "git revert HEAD", "git am x", "git pull", "git push", "git rm README.md", "git mv README.md R.md",
				"git worktree add ../x", "git branch x", "git tag v1"];
			const allowed = ["git status", "git diff", "git log --oneline", "git branch"];
			steps(h, [...blocked, ...allowed].map((command) => [call("bash", { command })]));
			await h.session.prompt("go");
			const results = toolResults(h.session);
			blocked.forEach((command, index) => expect(results[index]).toMatchObject({ isError: true, text: gitBlockReason([command.split(" ").slice(0, 2).join(" ")]) }));
			allowed.forEach((_command, index) => expect(results[blocked.length + index]!.isError).toBe(false));
			expect(results.at(-1)!.text).toContain("main");
			expect(workspace.git("log", "--oneline").trim().split("\n")).toHaveLength(1);
		});

		it("guards write: never read, changed since read, then allowed after a re-read; records touched files with overlap notes", async () => {
			const t = sharedTarget({ "README.md": [7] });
			cleanups.push(registerTicket(ticketKey(workspace.commonDir, 1), t.value));
			const h = await session({ agentType: "ticket", superagent: { ticketId: 1 } });
			const readme = join(workspace.repo, "README.md");
			steps(h, [
				[call("write", { path: "README.md", content: "never read\n" })],
				[call("read", { path: "README.md" })],
				() => { writeFileSync(readme, "# the user's edit, longer\n"); return [call("write", { path: "README.md", content: "stale\n" })]; },
				[call("read", { path: "README.md" })],
				[call("write", { path: "README.md", content: "# fresh\n" })],
				[call("write", { path: "new.txt", content: "a new file\n" })],
				[call("edit", { path: "new.txt", edits: [{ oldText: "a new", newText: "an edited" }] })],
				[call("Agent", { subagent_type: "worker", prompt: "x", isolation: "worktree" })],
				[call("Agent", { subagent_type: "worker", prompt: "x" })],
			]);
			await h.session.prompt("go");
			const results = toolResults(h.session);
			expect(results[0]).toMatchObject({ isError: true, text: writeBlockReason("README.md") });
			expect(results[1]!.isError).toBe(false);
			expect(results[2]).toMatchObject({ isError: true, text: writeBlockReason("README.md") });
			expect(results[3]!.isError).toBe(false);
			expect(results[4]).toMatchObject({ isError: false, text: expect.stringContaining(overlapNote(7, "README.md")) });
			expect(results[5]).toMatchObject({ isError: false });
			expect(results[5]!.text).not.toContain("Note:");
			expect(results[6]).toMatchObject({ isError: false });
			expect(results[7]).toMatchObject({ isError: true, text: AGENT_ISOLATION_BLOCK_REASON });
			expect(results[8]).toMatchObject({ isError: false });
			expect(readFileSync(readme, "utf8")).toBe("# fresh\n");
			expect(readFileSync(join(workspace.repo, "new.txt"), "utf8")).toBe("an edited file\n");
			expect(t.touched).toEqual(["README.md", "new.txt", "new.txt"]);
			// Nothing was committed.
			expect(workspace.git("status", "--porcelain")).toContain("README.md");
		});
	});
});
