// Pure helpers: router Agent gating, the router set, the board widget's groups, and settings.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { boardLines, reportContent, reportDetails } from "../src/render.ts";
import { agentCallBlock, agentResumeBlockReason, agentTypeBlockReason, routerTools } from "../src/router.ts";
import { DEFAULT_SETTINGS, loadSettings } from "../src/settings.ts";
import type { Ticket, TicketState } from "../src/types.ts";

const ticket = (id: number, state: TicketState, extra: Partial<Ticket> = {}): Ticket => ({
	version: 1, id, slug: `t${id}`, title: `Ticket ${id}`, request: "r", source: "r", createdAt: 1, updatedAt: 1, createdBy: "s", owner: "s",
	base: "a".repeat(40), branch: `pi/${id}-t${id}`, worktree: `/w/${id}`, state, ...extra,
});

describe("router Agent gating", () => {
	const allowed = ["recon", "reviewer", "expert"];
	it("allows the routerAgents types and refuses others with a reason", () => {
		expect(agentCallBlock({ subagent_type: "recon", prompt: "look" }, allowed, new Map())).toBeUndefined();
		expect(agentCallBlock({ subagent_type: "worker", prompt: "edit" }, allowed, new Map())).toBe(agentTypeBlockReason("worker", allowed));
		expect(agentCallBlock({ prompt: "x" }, allowed, new Map())).toBe(agentTypeBlockReason(undefined, allowed));
		expect(agentTypeBlockReason("worker", allowed)).toBe('Agent with subagent_type "worker" is not available in superagent mode: only recon, reviewer, expert may run here (setting routerAgents). Work that changes files goes to a ticket: create one with ticket_create.');
	});
	it("refuses a resume naming a ticket's agent, by id or handle", () => {
		const agents = new Map([["agent-7", 3]]);
		expect(agentCallBlock({ subagent_type: "recon", resume: "agent-7" }, allowed, agents)).toBe(agentResumeBlockReason("agent-7", 3));
		expect(agentCallBlock({ subagent_type: "recon", resume: "@ticket-4" }, allowed, agents)).toBe(agentResumeBlockReason("@ticket-4", 4));
		expect(agentCallBlock({ subagent_type: "recon", resume: "agent-1" }, allowed, agents)).toBeUndefined();
		expect(agentResumeBlockReason("agent-7", 3)).toBe('Agent resume "agent-7" names the agent of ticket #3: send it a message with ticket_message instead.');
	});
	it("puts Agent, get_subagent_result, and steer_subagent in the router set", () => {
		const tools = ["read", "bash", "Agent", "get_subagent_result", "steer_subagent", "ticket_create"].map((name) => ({ name, exposure: "direct" }) as unknown as ToolInfo);
		expect(routerTools(tools, [], allowed)).toEqual(["read", "Agent", "get_subagent_result", "steer_subagent", "ticket_create"]);
		expect(routerTools(tools, [], [])).toEqual(["read", "get_subagent_result", "steer_subagent", "ticket_create"]);
	});
});

describe("board widget", () => {
	it("groups open tickets: needs you, ready to merge, working, queued (with after)", () => {
		const open = [
			ticket(1, "question"), ticket(2, "ready"), ticket(3, "working"), ticket(4, "queued", { after: [3] }), ticket(5, "blocked"),
			ticket(6, "failed"), ticket(7, "waiting"), ticket(8, "interrupted"), ticket(9, "queued"), ticket(10, "ready", { mergeWhenReady: true }),
		];
		expect(boardLines(open)).toEqual([
			"needs you: #1 Ticket 1 (question) · #5 Ticket 5 (blocked) · #6 Ticket 6 (failed) · #7 Ticket 7 (waiting) · #8 Ticket 8 (interrupted)",
			"ready to merge: #2 Ticket 2 · #10 Ticket 10 (merging)",
			"working: #3 Ticket 3",
			"queued: #4 Ticket 4 (after #3) · #9 Ticket 9",
		]);
		expect(boardLines([ticket(1, "working")])).toEqual(["working: #1 Ticket 1"]);
		expect(boardLines([])).toEqual([]);
		expect(boardLines([ticket(4, "queued", { after: [3] })], () => [])).toEqual(["queued: #4 Ticket 4"]);
	});
});

describe("report text", () => {
	it("starts with #<id> <kind> · <title>", () => {
		expect(reportContent(reportDetails(ticket(2, "ready", { report: { state: "ready", summary: "done", at: 1 } }), "ready", { ahead: 1, target: "main" }))).toBe(
			"#2 ready · Ticket 2\nSummary: done\nBranch: pi/2-t2\nAhead of main: 1 commit");
		expect(reportContent(reportDetails(ticket(2, "ready"), "merge-handed", { reason: "conflicts" })).split("\n").slice(0, 2)).toEqual(["#2 merge-handed · Ticket 2", "State: ready"]);
	});
});

describe("settings", () => {
	let dir: string | undefined;
	afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; delete process.env.PI_SUPERAGENT_DISABLED; });
	const load = (value: unknown) => {
		dir = mkdtempSync(join(tmpdir(), "superagent-settings-"));
		writeFileSync(join(dir, "superagent.json"), JSON.stringify(value));
		return loadSettings(dir);
	};

	it("defaults", () => {
		expect(DEFAULT_SETTINGS).toEqual({ enabled: true, maxWorkers: 4, routerTools: [], routerAgents: ["recon", "reviewer", "expert"], react: "attention" });
	});
	it("reads routerAgents and react, and names the retired worker settings", () => {
		const { settings, problems } = load({ routerAgents: ["recon"], react: "none", workerModel: "a/b", workerThinking: "high" });
		expect(settings).toMatchObject({ routerAgents: ["recon"], react: "none" });
		expect(settings).not.toHaveProperty("workerModel");
		expect(problems.map((problem) => problem.replace(/^.*superagent\.json: /, ""))).toEqual([
			"\"workerModel\" is no longer supported and is ignored: set `model` in the `ticket` agent type's frontmatter instead (`/agents`)",
			"\"workerThinking\" is no longer supported and is ignored: set `thinking` in the `ticket` agent type's frontmatter instead (`/agents`)",
		]);
	});
	it("refuses invalid values and honours PI_SUPERAGENT_DISABLED", () => {
		process.env.PI_SUPERAGENT_DISABLED = "1";
		const { settings, problems } = load({ routerAgents: "recon", react: "always" });
		expect(settings).toMatchObject({ enabled: false, routerAgents: ["recon", "reviewer", "expert"], react: "attention" });
		expect(problems).toHaveLength(2);
	});
});
