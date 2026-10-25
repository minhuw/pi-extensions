import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_AGENTS, externalAgents, StepAgents, type ExternalAgent, type ExternalAgentRegistry } from "../../src/adapter/external-agents.ts";
import { EXTERNAL_AGENT_TTL_MS } from "../../src/config.ts";
import { activeRun, openRun } from "../../src/run/store.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { harness, VALID_GOAL } from "./harness.ts";

const SCOPE = { ownerSessionId: "session-a", runId: "run-1", launch: 2 };
const session = (id = "gpt-x") => ({ model: { id }, thinkingLevel: "high" });
const registry = (): ExternalAgentRegistry & { seen: string[] } => {
	const seen: string[] = [];
	return { agents: new Map(), listeners: new Set([(id: string) => seen.push(id)]), seen };
};
const running = (extra: object = {}) => ({ key: "impl-0", label: "implement", task: "T1", state: "running" as const, role: "worker", prompt: "\n  Implement the parser.\nDetails follow.", attempt: 1, startedAt: 100, ...extra });

afterEach(() => vi.useRealTimers());

describe("externalAgents", () => {
	it("creates the registry once, on globalThis under the shared symbol", () => {
		const shared = globalThis as { [EXTERNAL_AGENTS]?: ExternalAgentRegistry };
		const before = shared[EXTERNAL_AGENTS];
		delete shared[EXTERNAL_AGENTS];
		try {
			const first = externalAgents();
			expect(shared[Symbol.for("pi-extensions.external-agents") as typeof EXTERNAL_AGENTS]).toBe(first);
			expect(externalAgents()).toBe(first);
			expect(first.agents).toBeInstanceOf(Map);
			expect(first.listeners).toBeInstanceOf(Set);
		} finally {
			if (before) shared[EXTERNAL_AGENTS] = before;
			else delete shared[EXTERNAL_AGENTS];
		}
	});
});

describe("StepAgents", () => {
	it("adds an entry once the attempt has a session, updates it, and finishes it without the session", () => {
		const reg = registry();
		const agents = new StepAgents({ registry: reg, now: () => 500 });
		agents.update(running(), SCOPE);
		expect(reg.agents.size).toBe(0);
		const live = session();
		agents.update(running({ session: live }), SCOPE);
		const id = "herder:run-1:impl-0:1@100";
		expect(reg.agents.get(id)).toEqual<ExternalAgent>({
			id, source: "herder", ownerSessionId: "session-a", group: "Herder run-1 · launch 2", name: "T1 · implement", role: "worker",
			description: "Implement the parser.", model: "gpt-x", thinking: "high", status: "running", startedAt: 100, session: live as never,
		});
		// The runner disposed the session; gates may still run.
		agents.update(running(), SCOPE);
		expect(reg.agents.get(id)).toMatchObject({ status: "running", model: "gpt-x" });
		expect(reg.agents.get(id)!.session).toBeUndefined();
		agents.update({ key: "impl-0", label: "implement", state: "settled", status: "gate_failed" }, SCOPE);
		expect(reg.agents.get(id)).toMatchObject({ status: "failed", completedAt: 500 });
		expect(reg.seen).toEqual([id, id, id]);
		agents.clear();
	});

	it("maps step statuses, and a settle without a status is a stop", () => {
		for (const [status, expected] of [["ok", "completed"], ["no_changes", "completed"], ["failed", "failed"], ["stopped", "stopped"], [undefined, "stopped"]] as const) {
			const reg = registry();
			const agents = new StepAgents({ registry: reg });
			agents.update(running({ session: session() }), SCOPE);
			agents.update({ key: "impl-0", label: "implement", state: "settled", ...(status && { status }) }, SCOPE);
			expect(reg.agents.get("herder:run-1:impl-0:1@100")!.status).toBe(expected);
			agents.clear();
		}
	});

	it("gives each attempt its own entry and fails the retried one", () => {
		const reg = registry();
		const agents = new StepAgents({ registry: reg });
		agents.update(running({ session: session() }), SCOPE);
		agents.update(running({ attempt: 2, startedAt: 200 }), SCOPE);
		expect(reg.agents.get("herder:run-1:impl-0:1@100")!.status).toBe("failed");
		expect(reg.agents.size).toBe(1);
		agents.update(running({ attempt: 2, startedAt: 200, session: session("other") }), SCOPE);
		agents.update({ key: "impl-0", label: "implement", state: "settled", status: "ok" }, SCOPE);
		expect(reg.agents.get("herder:run-1:impl-0:1@100")!.status).toBe("failed");
		expect(reg.agents.get("herder:run-1:impl-0:2@200")).toMatchObject({ status: "completed", model: "other", startedAt: 200 });
		agents.clear();
	});

	it("a rerun of a finished step gets a new entry and leaves the finished one alone", () => {
		const reg = registry();
		const agents = new StepAgents({ registry: reg });
		agents.update(running({ session: session() }), SCOPE);
		agents.update({ key: "impl-0", label: "implement", state: "settled", status: "failed" }, SCOPE);
		agents.update(running({ startedAt: 300 }), SCOPE);
		expect([...reg.agents.values()].map((agent) => [agent.id, agent.status])).toEqual([["herder:run-1:impl-0:1@100", "failed"]]);
		agents.update(running({ startedAt: 300, session: session() }), SCOPE);
		expect([...reg.agents.values()].map((agent) => [agent.id, agent.status])).toEqual([["herder:run-1:impl-0:1@100", "failed"], ["herder:run-1:impl-0:1@300", "running"]]);
		agents.clear();
	});

	it("removes finished entries after the TTL with one timer, and clear removes only its own", () => {
		vi.useFakeTimers();
		const reg = registry();
		reg.agents.set("subagents:other", { id: "subagents:other", source: "other", name: "x", role: "worker", status: "running", startedAt: 0 });
		const agents = new StepAgents({ registry: reg, now: Date.now });
		agents.update(running({ session: session() }), SCOPE);
		agents.update({ key: "impl-0", label: "implement", state: "settled", status: "ok" }, SCOPE);
		vi.advanceTimersByTime(EXTERNAL_AGENT_TTL_MS / 2);
		agents.update(running({ key: "review-0", session: session() }), { ...SCOPE, launch: undefined });
		expect(reg.agents.get("herder:run-1:review-0:1@100")!.group).toBe("Herder run-1");
		agents.update({ key: "review-0", label: "review", state: "settled", status: "ok" }, SCOPE);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(EXTERNAL_AGENT_TTL_MS / 2);
		expect([...reg.agents.keys()]).toEqual(["subagents:other", "herder:run-1:review-0:1@100"]);
		vi.advanceTimersByTime(EXTERNAL_AGENT_TTL_MS / 2);
		expect([...reg.agents.keys()]).toEqual(["subagents:other"]);
		expect(vi.getTimerCount()).toBe(0);
		agents.update(running({ key: "late", session: session() }), SCOPE);
		agents.clear();
		expect([...reg.agents.keys()]).toEqual(["subagents:other"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a throwing listener neither stops others nor the publisher", () => {
		const reg = registry();
		reg.listeners.add(() => { throw new Error("boom"); });
		const after: string[] = [];
		reg.listeners.add((id) => after.push(id));
		const agents = new StepAgents({ registry: reg });
		expect(() => agents.update(running({ session: session() }), SCOPE)).not.toThrow();
		expect(after).toEqual(["herder:run-1:impl-0:1@100"]);
		agents.clear();
	});
});

describe("the adapter's external agents", () => {
	const fixtures: GitFixture[] = [];
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	async function launched(options: Parameters<typeof harness>[0]["options"] = {}) {
		const fixture = createGitFixture();
		fixtures.push(fixture);
		const h = harness({ cwd: fixture.dir, options });
		cleanups.push(h.shutdown);
		await h.command("add a greeting to the CLI");
		const run = openRun(fixture.commonDir, activeRun(fixture.commonDir)!);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await h.tool("herder_run", { action: "approve_goal" });
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		h.runtime().env.onActivity(running({ session: session() }));
		const mine = () => [...externalAgents().agents.values()].filter((agent) => agent.id.startsWith(`herder:${run.runId}:`));
		return { h, run, mine };
	}

	it("publishes a launch's steps for the owning session and removes them on abort", async () => {
		const { h, run, mine } = await launched();
		expect(mine()).toEqual([expect.objectContaining({ ownerSessionId: "session-a", group: `Herder ${run.runId} · launch 1`, name: "T1 · implement", status: "running" })]);
		await h.command("abort");
		expect(mine()).toEqual([]);
	});

	it("removes them when the lock is lost, and later reports from the stopping steps do not bring them back", async () => {
		const { h, run, mine } = await launched({ heartbeatMs: 15 });
		expect(mine()).toHaveLength(1);
		const now = new Date().toISOString();
		writeFileSync(run.paths.lock, `${JSON.stringify({ pid: process.pid + 1, host: "elsewhere", startedAt: now, heartbeatAt: now, sessionId: "session-z#00000000" })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(h.runtime().launches[0]!.stopped).toBe("run lock lost");
		expect(mine()).toEqual([]);
		h.runtime().env.onActivity(running({ session: session() }));
		expect(mine()).toEqual([]);
	});

	it("removes them on session shutdown", async () => {
		const { h, mine } = await launched();
		expect(mine()).toHaveLength(1);
		await h.shutdown();
		expect(mine()).toEqual([]);
	});
});
