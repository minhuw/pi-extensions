import { afterEach, beforeEach, expect, it } from "vitest";
import { BUDGET, GOAL_MAX, PLAN_MAX, PREAMBLE } from "../../recall/format.ts";
import { FakePika } from "./support/pika-server.ts";
import { callTool, type Harness, setCredentials, startSession, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let pika: FakePika;
let h: Harness;
beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start();
	setCredentials(pika.url);
	h = await startSession({ workspace });
});
afterEach(async () => {
	await h.shutdown();
	await pika.stop();
	await workspace.cleanup();
});

const RUN = "20261021-100000-abcd";
const SUMMARY = {
	runId: RUN, device: "d-1", deviceName: "Laptop", repo: "widgets", title: "Add pagination", status: "delivered", verdict: "met",
	startedAt: "2026-10-21T10:00:00.000Z", lastAt: "2026-10-21T10:14:00.000Z", stepCount: 2, sessionId: "orch-1",
};

let seq = 0;
const event = (data: Record<string, unknown>) => ({ seq: seq, t: data.t, at: data.at ?? `2026-10-21T10:${String(seq++).padStart(2, "0")}:00.000Z`, data: { v: 1, ...data } });

function journal() {
	seq = 0;
	return [
		event({ t: "run.started", runId: RUN, title: "Add pagination", base: "abc1234567890def", runtime: "1.0.0", repo: "/home/me/widgets", sessionId: "orch-1" }),
		event({ t: "goal.approved", sha256: "9a1f", approvedBy: "user", checks: [{ id: "test", command: "npm test", timeoutMs: 600000 }] }),
		event({ t: "plan.updated", sha256: "7c2e" }),
		event({ t: "script.launched", launch: 1, scriptSha256: "5d5d", args: null, head: "abc1234567890def" }),
		event({ t: "step.started", key: "impl-T1", id: "impl-T1", occurrence: 0, fingerprint: "f1", attempt: 1, role: "worker", write: true, base: "abc", task: "T1", label: "Implement T1", sessionId: "step-s1" }),
		event({ t: "step.failed", key: "impl-T1", fingerprint: "f1", attempt: 1, errorClass: "transient", message: "rate limited", final: false, sessionId: "step-s1" }),
		event({ t: "step.completed", key: "impl-T1", fingerprint: "f1", status: "ok", commit: "c0ffee1234567890", text: "Added the cursor.\nTests pass.", data: { files: 2 },
			checks: [{ id: "lint", passed: false, exitCode: 1, timedOut: false }, { id: "test", passed: true, exitCode: 0, timedOut: false }] }),
		event({ t: "check.completed", checkId: "test", commit: "d00d", exitCode: 1, timedOut: false, durationMs: 4200, logRef: "l", tail: `${"x".repeat(900)}\nFAIL src/page.test.ts`, purpose: "integrate" }),
		event({ t: "check.completed", checkId: "test", commit: "d00e", exitCode: 0, timedOut: false, durationMs: 3000, logRef: "l", tail: "all good" }),
		event({ t: "integrate.failed", key: "impl-T1", from: "abc", source: "c0ffee", reason: "conflict", conflicts: ["src/a.ts", "src/b.ts"] }),
		event({ t: "integrate.completed", key: "impl-T1", from: "abc", source: "c0ffee", head: "d00e", tree: "t", message: "feat: paginate", task: "T1", checks: [] }),
		event({ t: "decision.recorded", question: "Keep the old API?", answer: "No" }),
		event({ t: "verify.completed", head: "d00e", checks: [], verdict: "not_met", verifierRan: true,
			criteria: [{ id: "C1", status: "met", evidence: "ok" }, { id: "C2", status: "not_met", evidence: "no docs" }], gaps: [{ kind: "missing", criteria: ["C2"], text: "Document the cursor" }] }),
		event({ t: "delivery.completed", mode: "series", target: "main", tip: "d00f", commits: ["d00e", "d00f"] }),
		event({ t: "custom.future", x: 1 }),
		event({ t: "run.finished", status: "delivered", reason: "done" }),
	];
}

const STEPS = [
	{ key: "impl-T1", id: "impl-T1", task: "T1", role: "worker", label: "Implement T1", status: "ok", attempts: 2, sessionId: "step-s2", commit: "c0ffee1234567890" },
	{ key: "review-T1", id: "review-T1", role: "reviewer", status: "failed", attempts: 1 },
];

it("lists runs, newest first, with the current project's filter and a hint at older ones", async () => {
	setCredentials(pika.url, { repository: async () => ({ project: "widgets" }) });
	pika.routes.set("herder/runs", { body: { items: [SUMMARY, { runId: "r-2", repo: "", status: "running", stepCount: 1 }], nextCursor: "c" } });
	const result = await callTool(h, "recall_herder", { scope: "project", limit: 2 });
	expect(result.isError).toBe(false);
	const request = pika.requestsTo("herder/runs")[0]!;
	expect(Object.fromEntries(request.query)).toEqual({ limit: "2", repo: "widgets" });
	expect(request.authorization).toBe("Bearer recall-test-token");
	expect(result.text).toBe([
		PREAMBLE,
		"2 Herder runs in project widgets, newest first:",
		"",
		"1. \"Add pagination\"",
		`   runId ${RUN} · project widgets · delivered · verdict met · 2 steps`,
		"   started 2026-10-21 10:00 UTC · last active 2026-10-21 10:14 UTC · device Laptop · orchestrated in session orch-1",
		"",
		"2. \"untitled\"",
		"   runId r-2 · project unknown · running · 1 step",
		"   started unknown · last active unknown · device unknown",
		"",
		"Older runs are not shown; raise limit to see more.",
		"Read a run with recall_herder({ runId }) for its goal, plan, steps, and journal.",
	].join("\n"));
	expect(result.details).toEqual({ project: "widgets", limit: 2, runIds: [RUN, "r-2"] });

	pika.routes.set("herder/runs", { body: { items: [], nextCursor: null } });
	const none = await callTool(h, "recall_herder", { project: "gadgets" });
	expect(none.text).toBe(`${PREAMBLE}\nNo Herder run is recorded in project gadgets.`);
	await callTool(h, "recall_herder", {});
	expect(pika.requestsTo("herder/runs").slice(1).map((r) => Object.fromEntries(r.query))).toEqual([{ limit: "10", repo: "gadgets" }, { limit: "10" }]);
});

it("reads a run: goal, plan, steps, and every kind of journal event", async () => {
	pika.routes.set(`herder/runs/${RUN}`, { body: { run: SUMMARY, goal: "# Goal\nPaginate.", plan: "# Plan\n- T1", events: journal(), steps: STEPS } });
	const result = await callTool(h, "recall_herder", { runId: ` ${RUN} ` });
	expect(result.isError).toBe(false);
	expect(result.text).toBe([
		PREAMBLE,
		`Herder run ${RUN}: "Add pagination"`,
		"Project widgets · device Laptop · delivered · verdict met",
		"Started 2026-10-21 10:00 UTC · last active 2026-10-21 10:14 UTC · 2 steps · 16 journal events",
		"Orchestrated in session orch-1; read it with recall_read({ sessionId: \"orch-1\" })",
		"",
		"## Goal",
		"# Goal\nPaginate.",
		"",
		"## Plan",
		"# Plan\n- T1",
		"",
		"## Steps (2)",
		"- impl-T1 · worker · task T1 · \"Implement T1\" · ok · 2 attempts · commit c0ffee123456 · session step-s2",
		"- review-T1 · reviewer · failed · 1 attempt",
		"",
		"## Journal",
		"[#0 · 2026-10-21 10:00 UTC] run started: \"Add pagination\" from abc123456789, orchestrated in session orch-1",
		"[#1 · 2026-10-21 10:01 UTC] goal approved; checks: test (npm test)",
		"[#2 · 2026-10-21 10:02 UTC] plan updated",
		"[#3 · 2026-10-21 10:03 UTC] launch 1 started at abc123456789",
		"[#4 · 2026-10-21 10:04 UTC] step impl-T1 started: worker for T1 \"Implement T1\", attempt 1 → session step-s1",
		"[#5 · 2026-10-21 10:05 UTC] step impl-T1 attempt 1 failed (transient): rate limited",
		"[#6 · 2026-10-21 10:06 UTC] step impl-T1 ok, commit c0ffee123456; checks: lint failed (exit 1), test passed",
		"  reply: Added the cursor. Tests pass.",
		"  data: {\"files\":2}",
		`[#7 · 2026-10-21 10:07 UTC] check test (integrate) on d00d failed (exit 1) in 4.2 s`,
		// The log's last 800 characters, folded to one line.
		`  log tail: …${"x".repeat(777)} FAIL src/page.test.ts`,
		"[#8 · 2026-10-21 10:08 UTC] check test on d00e passed in 3.0 s",
		"[#9 · 2026-10-21 10:09 UTC] integration of impl-T1 failed (conflict); conflicts: src/a.ts, src/b.ts",
		"[#10 · 2026-10-21 10:10 UTC] integrated impl-T1 (T1) → head d00e: feat: paginate",
		"[#11 · 2026-10-21 10:11 UTC] decision: Keep the old API? → No",
		"[#12 · 2026-10-21 10:12 UTC] verified head d00e: verdict not_met",
		"  criteria: C1 met, C2 not_met",
		"  C2: no docs",
		"  gap (missing, C2): Document the cursor",
		"[#13 · 2026-10-21 10:13 UTC] delivered (series) to main: 2 commits, tip d00f",
		"[#14 · 2026-10-21 10:14 UTC] custom.future: {\"x\":1}",
		"[#15 · 2026-10-21 10:15 UTC] run finished: delivered (done)",
		"",
		"Shown events 0 to 15 of 16: the end of the journal.",
		"Read a step's session with recall_read({ sessionId }).",
	].join("\n"));
	expect(result.details).toEqual({ runId: RUN, events: Array.from({ length: 16 }, (_, i) => i) });
});

it("continues a long journal from an event, without the goal, plan, and steps again", async () => {
	const events = Array.from({ length: 200 }, (_, i) => ({ seq: i, t: "decision.recorded", at: "2026-10-21T10:00:00.000Z",
		data: { v: 1, t: "decision.recorded", question: `question ${i} ${"q".repeat(200)}`, answer: "yes" } }));
	pika.routes.set(`herder/runs/${RUN}`, { body: { run: SUMMARY, goal: "g".repeat(GOAL_MAX + 100), plan: "plan", events, steps: [] } });
	const first = await callTool(h, "recall_herder", { runId: RUN });
	const next = (first.details as { next?: { fromEvent: number } }).next!.fromEvent;
	expect(next).toBeGreaterThan(10);
	expect(first.text.length).toBeLessThanOrEqual(BUDGET + 500);
	expect(first.text).toContain(`${"g".repeat(GOAL_MAX - 1)}…\n`);
	expect(first.text).toContain(`Shown events 0 to ${next - 1} of 200. Continue with recall_herder({ runId: "${RUN}", fromEvent: ${next} }).`);
	expect(first.text).not.toContain("Read a step's session");

	const second = await callTool(h, "recall_herder", { runId: RUN, fromEvent: next });
	expect(second.text).not.toContain("## Goal");
	expect(second.text).not.toContain("## Steps");
	expect(second.text).toContain(`\n## Journal\n[#${next} · `);
	expect((second.details as { events: number[] }).events[0]).toBe(next);

	const past = await callTool(h, "recall_herder", { runId: RUN, fromEvent: 500 });
	expect(past.text.endsWith("\n\nNo event 500: the journal has 200 events.")).toBe(true);
	expect(past.details).toEqual({ runId: RUN, events: [] });
});

it("keeps a run's first page within the budget, cutting long step labels and counting the steps it leaves out", async () => {
	const steps = Array.from({ length: 60 }, (_, i) => ({ key: `step-${i}`, role: "worker", task: "t".repeat(500), label: `${i} ${"l".repeat(1000)}`, status: "ok", attempts: 1 }));
	const events = [{ seq: 0, t: "plan.updated", at: "2026-10-21T10:00:00.000Z", data: { v: 1, t: "plan.updated" } }];
	pika.routes.set(`herder/runs/${RUN}`, { body: { run: { ...SUMMARY, title: "T".repeat(1000) }, goal: "g".repeat(GOAL_MAX), plan: "p".repeat(PLAN_MAX), events, steps } });
	const result = await callTool(h, "recall_herder", { runId: RUN });
	expect(result.text.length).toBeLessThanOrEqual(BUDGET + 500);
	expect(result.text).toContain(`Herder run ${RUN}: "${"T".repeat(299)}…"`);
	expect(result.text).toContain(`- step-0 · worker · task ${"t".repeat(99)}… · "0 ${"l".repeat(197)}…" · ok · 1 attempt`);
	const listed = result.text.split("\n").filter((line) => line.startsWith("- step-")).length;
	expect(listed).toBeGreaterThan(5);
	expect(listed).toBeLessThan(60);
	expect(result.text).toContain(`\n… ${60 - listed} more steps\n`);
	expect(result.text).toContain("\n## Journal\n[#0 · 2026-10-21 10:00 UTC] plan updated\n");
});

it("tells an unknown run from a server without Herder runs", async () => {
	pika.routes.set("herder/runs", { body: { items: [], nextCursor: null } });
	expect(await callTool(h, "recall_herder", { runId: "nope" })).toMatchObject({ isError: true, text: "no recorded Herder run has id nope; list runs with recall_herder()." });
	expect(pika.requestsTo("herder/runs")).toHaveLength(1);
	pika.routes.delete("herder/runs");
	const old = "the pika server's agent read API has no Herder runs (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.";
	expect(await callTool(h, "recall_herder", { runId: "nope" })).toMatchObject({ isError: true, text: old });
	expect(await callTool(h, "recall_herder", {})).toMatchObject({ isError: true, text: old });
	pika.features = ["relay"];
	expect(await callTool(h, "recall_herder", {})).toMatchObject({ isError: true, text: `the pika server at ${pika.url} has no agent read API (HTTP 404): it needs a newer pika. Ask the user to upgrade the server.` });
});

it("names a step session's run in its overview", async () => {
	pika.routes.set("sessions/step-s2", { body: { id: "step-s2", title: "Implement T1", herderRunId: RUN, parentSessionId: "orch-1", children: [] } });
	pika.routes.set("sessions/step-s2/trace", { body: { turns: [], records: [], children: [] } });
	pika.routes.set("sessions/step-s2/turns", { body: { items: [], nextCursor: null } });
	const result = await callTool(h, "recall_read", { sessionId: "step-s2" });
	expect(result.text).toContain(`Parent session orch-1\nA step of Herder run ${RUN}; read the run with recall_herder({ runId: "${RUN}" })\n`);
});
