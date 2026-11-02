// Superagent on the real Subagents extension (extensions/subagents/src/index.ts), in real Pi sessions on the faux provider,
// in a real git repository: ticket agents spawned, steered, resumed, and reopened over Subagents' RPC.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dirtyWorkspaceText } from "../src/dispatcher.ts";
import { ticketBlockReason } from "../src/hook.ts";
import { gitBlockReason, writeBlockReason } from "../src/shared-guard.ts";
import { openStore } from "../src/store.ts";
import { CHILD_SESSION_HOOKS, REPORT_MESSAGE, SESSION_LINK_TYPE, type Ticket } from "../src/types.ts";
import { RECOVERY_NOTE } from "../src/worker-prompt.ts";
import { customMessages, startSession, toolResults, waitFor, Workspace, type Harness } from "./support/router-runtime.ts";

const RPC_SOURCE = fileURLToPath(new URL("../../subagents/src/cross-extension-rpc.ts", import.meta.url));
/** Subagents answers `subagents:rpc:ping` with protocol 3 (send, reopen, ticket type, spawn options). */
const protocol3 = (() => { try { return /PROTOCOL_VERSION = (\d+)/.exec(readFileSync(RPC_SOURCE, "utf8"))?.[1] === "3"; } catch { return false; } })();

type Role = "main" | "ticket" | "nested";
/** Which session a model call comes from, by its transcript (system prompt included). */
const roleOf = (text: string): Role => text.includes("# Your ticket") ? "ticket" : text.includes("You are the router of this repository") ? "main" : "nested";

/** A stand-in Herder tool in every child session, which a ticket agent must not call. */
const herderStub = {
	name: "superagent-test-herder-stub",
	extensionFactory: ((pi) => {
		pi.registerTool({
			name: "herder_status", label: "herder_status", description: "stub", parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "herder ran" }], details: {} }; },
		});
	}) as ExtensionFactory,
};

describe.skipIf(!protocol3)("superagent on Subagents", () => {
	let workspace: Workspace;
	let home: string | undefined;
	const harnesses: Harness[] = [];
	let subagents: ExtensionFactory;

	beforeEach(async () => {
		workspace = await Workspace.create();
		home = process.env.HOME;
		process.env.HOME = workspace.root;
		subagents = (await import("../../subagents/src/index.ts")).default as ExtensionFactory;
		const hooks = ((globalThis as Record<symbol, unknown>)[Symbol.for(CHILD_SESSION_HOOKS)] ??= new Set()) as Set<unknown>;
		hooks.add(herderStub);
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.shutdown();
		((globalThis as Record<symbol, unknown>)[Symbol.for(CHILD_SESSION_HOOKS)] as Set<unknown> | undefined)?.delete(herderStub);
		if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
		await workspace.cleanup();
	});

	const faux = () => fauxProvider({ api: "superagent-test-api", provider: "superagent-test", models: [{ id: "test" }] });
	async function start(options: { sessionManager?: SessionManager; faux?: ReturnType<typeof faux> } = {}): Promise<Harness> {
		const harness = await startSession({ workspace, before: [subagents], ...(options.faux ? { faux: options.faux } : {}), ...(options.sessionManager ? { sessionManager: options.sessionManager } : {}) });
		harnesses.push(harness);
		return harness;
	}

	/** Every model call's transcript by role, answered by `reply` (which may wait). */
	function script(h: Harness, reply: (role: Role, call: number, text: string) => ReturnType<FauxResponseFactory>) {
		const seen: Record<Role, string[]> = { main: [], ticket: [], nested: [] };
		const step: FauxResponseFactory = (context) => {
			const text = JSON.stringify(context.messages);
			const role = roleOf(text);
			seen[role].push(text);
			return reply(role, seen[role].length, text);
		};
		h.faux.setResponses(Array.from({ length: 80 }, () => step));
		return seen;
	}

	const store = () => openStore(workspace.commonDir);
	const ticket = (id = 1): Ticket => store().get(id)!;
	const createCall = (id = "create-1") => fauxAssistantMessage([fauxToolCall("ticket_create", { title: "Add a note", request: "add a note to the README" }, { id })], { stopReason: "toolUse" });

	it("runs a ticket agent in its worktree that reports ready, which starts a main-session turn", async () => {
		const h = await start();
		const seen = script(h, (role, call) => {
			if (role === "main") return call === 1 ? createCall() : fauxAssistantMessage(call === 2 ? "Created #1." : "Noted.");
			if (role === "nested") {
				return call === 1 ? fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }) : fauxAssistantMessage("nested done");
			}
			if (call === 1) {
				return fauxAssistantMessage([
					fauxToolCall("bash", { command: "pwd && echo note >> README.md && git commit -qam 'add a note' && echo committed" }, { id: "t1" }),
					fauxToolCall("herder_status", {}, { id: "t2" }),
					fauxToolCall("Agent", { subagent_type: "worker", prompt: "NESTED TASK: print the working directory", description: "nested pwd" }, { id: "t3" }),
				], { stopReason: "toolUse" });
			}
			if (call === 2) return fauxAssistantMessage([fauxToolCall("ticket_report", { state: "ready", summary: "added the note", tests: "none needed" }, { id: "t4" })], { stopReason: "toolUse" });
			return fauxAssistantMessage("ticket done");
		});
		await h.session.prompt("add a note to the README");
		expect(toolResults(h.session).find((result) => result.name === "ticket_create")).toMatchObject({ isError: false, text: expect.stringContaining("Created ticket #1") });
		await waitFor(() => customMessages(h.session, REPORT_MESSAGE).length > 0, 20_000, "ready report");
		await waitFor(() => seen.main.length >= 3, 10_000, "main turn for the report");
		const [report] = customMessages(h.session, REPORT_MESSAGE);
		expect(report).toMatchObject({ display: true, details: { ticketId: 1, kind: "ready", state: "ready", branch: "pi/1-add-a-note", ahead: 1 } });
		expect(String(report!.content).startsWith("#1 ready · Add a note")).toBe(true);
		expect(seen.main[2]).toContain("#1 ready · Add a note");

		const current = ticket();
		expect(current).toMatchObject({ state: "ready", agentId: expect.any(String), sessionFile: expect.stringMatching(/\.jsonl$/) });
		// The ticket agent ran in its worktree and could not call Herder; its nested worker ran in the same worktree.
		const second = seen.ticket[1]!;
		expect(second).toContain(current.worktree);
		expect(second).toContain("committed");
		expect(second).toContain(JSON.stringify(ticketBlockReason("herder_status")).slice(1, -1));
		expect(seen.nested.length).toBeGreaterThanOrEqual(2);
		expect(seen.nested[1]).toContain(current.worktree);
		expect(workspace.git("log", "--oneline", current.branch)).toContain("add a note");

		// The ticket session's link: the ticket, and the ticket_create call it came from.
		const entries = readFileSync(current.sessionFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; customType?: string; data?: Record<string, unknown> });
		const link = entries.find((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE)!;
		expect(link.data).toMatchObject({ agentType: "ticket", parentToolCallId: "create-1", superagent: { ticketId: 1, branch: "pi/1-add-a-note", title: "Add a note" } });
		expect(h.errors).toEqual([]);
	});

	it("steers a running ticket with #N and resumes an idle one", async () => {
		const h = await start();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const seen = script(h, async (role, call) => {
			if (role === "main") return call === 1 ? createCall() : fauxAssistantMessage("ok");
			if (call === 1) {
				await gate;
				return fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(`ticket reply ${call}`);
		});
		await h.session.prompt("add a note to the README");
		await waitFor(() => seen.ticket.length === 1, 10_000, "ticket running");
		await h.session.prompt("#1 also mention the license");
		await waitFor(() => h.notes.messages.some((message) => message.includes("steered into its running agent")), 5_000, "steered");
		release();
		await waitFor(() => ticket().state === "waiting", 15_000, "first run ended");
		expect(seen.ticket.slice(1).some((text) => text.includes("also mention the license"))).toBe(true);
		const calls = seen.ticket.length;
		await h.session.prompt("#1 and the changelog");
		await waitFor(() => h.notes.messages.some((message) => message.includes("its agent started a new run")), 5_000, "resumed");
		await waitFor(() => seen.ticket.length > calls && ticket().state === "waiting", 15_000, "resumed run ended");
		expect(seen.ticket.at(-1)).toContain("and the changelog");
		expect(seen.ticket.at(-1)).toContain("add a note to the README");
	});

	/** One ticket whose first run calls a tool and ends without a report (`waiting`); then the main session is shut down. */
	async function firstSession(shared: ReturnType<typeof faux>) {
		const first = await start({ sessionManager: SessionManager.create(workspace.repo, workspace.sessionDir), faux: shared });
		script(first, (role, call) => role === "main" ? (call === 1 ? createCall() : fauxAssistantMessage("ok"))
			: call === 1 ? fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }) : fauxAssistantMessage("first run text"));
		await first.session.prompt("add a note to the README");
		await waitFor(() => ticket().state === "waiting", 15_000, "first run ended");
		const mainFile = first.session.sessionFile!;
		await first.shutdown();
		return { mainFile, before: ticket() };
	}

	it("reopens a ticket's session after a restart", async () => {
		const shared = faux();
		const { mainFile, before } = await firstSession(shared);
		const second = await start({ sessionManager: SessionManager.open(mainFile, workspace.sessionDir), faux: shared });
		expect(ticket().state).toBe("waiting");
		const seen = script(second, (role) => role === "main" ? fauxAssistantMessage("ok") : fauxAssistantMessage("reopened run text"));
		await second.session.prompt("#1 please continue");
		await waitFor(() => ticket().lastText === "reopened run text", 15_000, "reopened run ended");
		// The same conversation continues: its first request and run are in the transcript.
		expect(seen.ticket[0]).toContain("add a note to the README");
		expect(seen.ticket[0]).toContain("first run text");
		expect(seen.ticket[0]).toContain("please continue");
		expect(seen.ticket[0]).not.toContain(RECOVERY_NOTE.slice(0, 40));
		const after = ticket();
		expect(after.sessionFile).toBe(before.sessionFile);
		expect(after.agentId).not.toBe(before.agentId);
		expect(second.notes.messages.some((message) => message.includes("session was reopened"))).toBe(true);
	});

	it("puts the recovery note first when an interrupted ticket is reopened", async () => {
		const shared = faux();
		const { mainFile } = await firstSession(shared);
		// As a crash mid-run leaves it: working, with no live lock. The next session's startup marks it interrupted.
		store().update(1, { state: "working" });
		const second = await start({ sessionManager: SessionManager.open(mainFile, workspace.sessionDir), faux: shared });
		expect(ticket().state).toBe("interrupted");
		const seen = script(second, (role) => role === "main" ? fauxAssistantMessage("ok") : fauxAssistantMessage("recovered"));
		await second.session.prompt("#1 go on");
		await waitFor(() => ticket().lastText === "recovered", 15_000, "recovered run");
		const prompt = seen.ticket[0]!;
		expect(prompt).toContain("first run text");
		expect(prompt.indexOf(RECOVERY_NOTE.slice(0, 40))).toBeGreaterThan(prompt.indexOf("first run text"));
		expect(prompt.indexOf("go on")).toBeGreaterThan(prompt.indexOf(RECOVERY_NOTE.slice(0, 40)));
	});

	it("shared mode: two tickets run in the main checkout on a dirty tree, see the user's change, and leave their edits uncommitted", async () => {
		const h = await start();
		await h.session.prompt("/superagent workspace shared");
		expect(h.notes.last).toMatchObject({ type: "info", message: expect.stringContaining("Workspace mode: shared") });
		writeFileSync(join(workspace.repo, "README.md"), "# demo\nUSER CHANGE\n");
		const commits = workspace.git("rev-list", "--count", "HEAD").trim();
		const byTicket: Record<number, string[]> = { 1: [], 2: [] };
		const seen = script(h, (role, call, text) => {
			if (role === "main") {
				if (call === 1) {
					return fauxAssistantMessage([
						fauxToolCall("ticket_create", { title: "Alpha", request: "add alpha" }, { id: "c-a" }),
						fauxToolCall("ticket_create", { title: "Beta", request: "add beta" }, { id: "c-b" }),
					], { stopReason: "toolUse" });
				}
				return fauxAssistantMessage("ok");
			}
			if (role !== "ticket") return fauxAssistantMessage("nested");
			const id = text.includes("ticket #1") && text.includes("add alpha") ? 1 : 2;
			byTicket[id]!.push(text);
			const step = byTicket[id]!.length;
			const file = id === 1 ? "alpha.txt" : "beta.txt";
			const calls: Record<number, ReturnType<typeof fauxToolCall>[]> = {
				1: [fauxToolCall("bash", { command: "pwd && cat README.md" }, { id: `t${id}-1` })],
				2: [fauxToolCall("bash", { command: "git add -A && git commit -qm sneaky" }, { id: `t${id}-2` })],
				3: [fauxToolCall("write", { path: "README.md", content: "clobbered\n" }, { id: `t${id}-3` })],
				4: [fauxToolCall("write", { path: file, content: `${file}\n` }, { id: `t${id}-4` })],
				5: [fauxToolCall("ticket_report", { state: "ready", summary: `added ${file}` }, { id: `t${id}-5` })],
			};
			return calls[step] ? fauxAssistantMessage(calls[step]!, { stopReason: "toolUse" }) : fauxAssistantMessage("ticket done");
		});
		await h.session.prompt("add alpha, and add beta");
		await waitFor(() => ticket(1)?.state === "ready" && ticket(2)?.state === "ready", 30_000, "both tickets ready");
		for (const id of [1, 2] as const) {
			const current = ticket(id);
			expect(current).toMatchObject({ workspace: "shared", worktree: workspace.repo, branch: "main", touched: [id === 1 ? "alpha.txt" : "beta.txt"] });
			const transcript = byTicket[id]!;
			// The ticket agent ran in the main checkout and saw the user's uncommitted change.
			expect(transcript[1]).toContain(workspace.repo);
			expect(transcript[1]).toContain("USER CHANGE");
			expect(transcript[2]).toContain(JSON.stringify(gitBlockReason(["git add", "git commit"])).slice(1, -1));
			expect(transcript[3]).toContain(JSON.stringify(writeBlockReason("README.md")).slice(1, -1));
			expect(transcript[0]).toContain("You work directly in the user's working tree");
		}
		expect(seen.ticket.length).toBeGreaterThanOrEqual(10);
		// Edits landed uncommitted; no commit, no worktree, no branch; the user's change is intact.
		expect(readFileSync(join(workspace.repo, "README.md"), "utf8")).toBe("# demo\nUSER CHANGE\n");
		expect(readFileSync(join(workspace.repo, "alpha.txt"), "utf8")).toBe("alpha.txt\n");
		expect(readFileSync(join(workspace.repo, "beta.txt"), "utf8")).toBe("beta.txt\n");
		expect(workspace.git("rev-list", "--count", "HEAD").trim()).toBe(commits);
		expect(workspace.git("status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M README.md", "?? alpha.txt", "?? beta.txt"]);
		expect(workspace.git("branch", "--format=%(refname:short)").trim()).toBe("main");
		expect(workspace.git("worktree", "list").trim().split("\n")).toHaveLength(1);
		await waitFor(() => customMessages(h.session, REPORT_MESSAGE).length >= 1, 10_000, "ready reports");

		await h.session.prompt("/merge 1");
		expect(ticket(1).state).toBe("done");
		await waitFor(() => customMessages(h.session, REPORT_MESSAGE).some((message) => String(message.content).includes("Ticket #1 is done; its changes stay uncommitted in your working tree.")), 5_000, "done report");
		expect(existsSync(join(workspace.repo, "alpha.txt"))).toBe(true);
		expect(workspace.git("rev-list", "--count", "HEAD").trim()).toBe(commits);
		expect(h.errors).toEqual([]);
	});

	it("worktree mode: a dirty checkout refuses ticket_create and tells the user", async () => {
		const h = await start();
		writeFileSync(join(workspace.repo, "README.md"), "# demo\nUSER CHANGE\n");
		script(h, (role, call) => role === "main" ? (call === 1 ? createCall() : fauxAssistantMessage("Commit first.")) : fauxAssistantMessage("x"));
		await h.session.prompt("add a note to the README");
		const refusal = dirtyWorkspaceText([" M README.md"]);
		expect(toolResults(h.session).find((result) => result.name === "ticket_create")).toMatchObject({ isError: true, text: refusal });
		expect(h.notes.notes).toContainEqual({ message: refusal, type: "warning" });
		expect(store().list()).toEqual([]);
		expect(workspace.git("worktree", "list").trim().split("\n")).toHaveLength(1);
	});
});
