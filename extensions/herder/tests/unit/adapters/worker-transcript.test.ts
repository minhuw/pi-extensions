import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ManagerAction } from "../../../src/shared/protocol.ts";
import {
	createWorkerInputEntry,
	createWorkerOutputEntry,
	workerInputDisplay,
	workerOutputDisplay,
} from "../../../adapters/worker-transcript.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function action(prompt = [
	"HERDER_MANAGER_WORKER_V1",
	"RUN_ID: run-1",
	"ACTION_ID: action-1",
	"ROLE: plan-implementer",
	"PLAN: 001",
	"MODE: INITIAL",
	"REPOSITORY_WORKTREE: /tmp/worktree-001",
	"REPAIR_CONTRACT:",
	"none",
].join("\n")): ManagerAction {
	return {
		actionId: "action-1",
		attemptId: "attempt-1",
		runId: "run-1",
		planId: "001",
		generation: 1,
		round: 1,
		role: "plan-implementer",
		agentType: "herder.plan-implementer",
		model: "gpt-6-luna",
		effort: "max",
		serviceTier: "fast",
		workerMode: "INITIAL",
		taskName: "herder-001-implementer-r1-1",
		worktree: "/tmp/worktree-001",
		branch: "herder/plans/001",
		assignmentPath: "/tmp/worktree-001/herder-plans/001.md",
		assignmentSha256: "a".repeat(64),
		leaseReason: "lease-001",
		prompt,
	};
}

test("worker input entries preserve exact bounded assignment context", () => {
	const exactPrompt = `  ${action().prompt}\n`;
	const entry = createWorkerInputEntry(action(exactPrompt), "pi-worker:session-1", 1_000);
	assert.equal(entry.startedAt, 1_000);
	assert.equal(entry.handle, "pi-worker:session-1");
	assert.equal(entry.serviceTier, "fast");
	assert.equal(entry.prompt, exactPrompt);
	assert.match(entry.prompt, /REPAIR_CONTRACT:/);

	const collapsed = workerInputDisplay(entry, false, theme);
	assert.match(collapsed, /Herder Implementer/);
	assert.match(collapsed, /Plan 001 · GPT-6-luna · MAX · Fast/);
	assert.match(collapsed, /round 1 · INITIAL · herder-001-implementer-r1-1/);
	assert.match(collapsed, /HERDER_MANAGER_WORKER_V1/);
	assert.match(collapsed, /more lines/);
	assert.doesNotMatch(collapsed, /REPAIR_CONTRACT:/);

	const expanded = workerInputDisplay(entry, true, theme);
	assert.match(expanded, /REPAIR_CONTRACT:/);
	assert.match(expanded, /worktree: \/tmp\/worktree-001/);
	assert.match(expanded, /assignment: \/tmp\/worktree-001\/herder-plans\/001\.md/);
});

test("worker output entries render returned and interrupted child evidence", () => {
	const input = createWorkerInputEntry(action(), "pi-worker:session-1", 1_000);
	const returned = createWorkerOutputEntry(input, {
		actionId: input.actionId,
		hostHandle: input.handle,
		response: "STATUS: COMPLETE\nCOMMITS: abcdef1\nCHECKS: npm test\nFILES CHANGED: a.ts\nDISCOVERED_PATHS: none\nNOTES: done",
		usage: { inputTokens: 1_500, outputTokens: 500 },
	}, 4_000);
	assert.equal(returned.status, "returned");
	assert.equal(returned.durationMs, 3_000);
	const collapsed = workerOutputDisplay(returned, false, theme);
	assert.match(collapsed, /Herder Implementer/);
	assert.match(collapsed, /Plan 001 · GPT-6-luna · MAX · Fast/);
	assert.match(collapsed, /round 1 · returned · 2\.0k tokens · 3s/);
	assert.match(collapsed, /STATUS: COMPLETE/);
	assert.match(collapsed, /Recorded work: done/);
	assert.doesNotMatch(collapsed, /CHECKS: npm test|✓/);
	assert.match(collapsed, /report only; not manager acceptance/);
	assert.match(collapsed, /Original worker response \(ctrl\+o to expand\)/);
	assert.match(workerOutputDisplay(returned, true, theme), /NOTES: done/);

	const interrupted = createWorkerOutputEntry(input, {
		actionId: input.actionId,
		hostHandle: input.handle,
		response: "partial response",
		interrupted: true,
		error: Array.from({ length: 200 }, (_, index) => `provider error ${index}`).join("\n"),
	}, 5_000);
	assert.equal(interrupted.status, "interrupted");
	const interruptedDisplay = workerOutputDisplay(interrupted, false, theme);
	assert.match(interruptedDisplay, /interrupted/);
	assert.match(interruptedDisplay, /provider error 0/);
	assert.doesNotMatch(interruptedDisplay, /provider error 99/);
});

test("worker UI labels an unpinned service tier as standard", () => {
	const standardAction = action();
	delete standardAction.serviceTier;
	const entry = createWorkerInputEntry(standardAction, "pi-worker:session-standard", 1_000);
	assert.match(workerInputDisplay(entry, false, theme), /Plan 001 · GPT-6-luna · MAX · Standard/);
});

test("worker transcript entries cap oversized child payloads", () => {
	const prompt = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
	const entry = createWorkerInputEntry(action(prompt), "pi-worker:session-1", 1_000);
	assert.match(entry.prompt, /Herder transcript truncated to 400\/2100 lines/);
});


test("failed and stopped reports lead with their cause, not successful checks or transport", () => {
	for (const [planId, status, commits] of [["003", "FAILED", "abcdef1"], ["004", "STOPPED", "none"]]) {
		const input = createWorkerInputEntry({ ...action(), planId: planId! }, "worker", 0);
		const reason = `V3 not verified: ${"evidence ".repeat(80)}missing final prerequisite`;
		const response = `STATUS: ${status}\nCOMMITS: ${commits}\nCHECKS: test — passed\ntypecheck — passed\nFILES CHANGED: a.ts\nNOTES: Recorded implementation\nSTOPPED BECAUSE: ${reason}`;
		const entry = createWorkerOutputEntry(input, { actionId: input.actionId, response }, 1000);
		const collapsed = workerOutputDisplay(entry, false, theme);
		assert.ok(collapsed.includes(`Worker-reported STATUS: ${status}`));
		assert.ok(collapsed.includes(reason));
		assert.match(collapsed, /Recorded work: Recorded implementation/);
		assert.match(collapsed, /before any retry/);
		assert.doesNotMatch(collapsed, /✓|CHECKS:|test — passed/);
		const expanded = workerOutputDisplay(entry, true, theme);
		for (const line of response.split("\n")) assert.ok(expanded.includes(line));
		assert.ok(expanded.indexOf(`Reason: ${reason}`) < expanded.indexOf("CHECKS:"));
		assert.equal(entry.response, response);
	}
});

test("unknown, interruption and transport error outrank reported COMPLETE", () => {
	const input = createWorkerInputEntry(action(), "worker", 0);
	for (const terminal of [
		{ response: "STATUS: COMPLETE\nNOTES: partial", interrupted: true },
		{ response: "STATUS: COMPLETE\nNOTES: partial", error: "transport disconnected" },
		{ response: "STATUS: COMPLETE", failureKind: "review_budget_exhausted" as const },
		{ response: "STATUS: INVALID" },
		{ response: undefined },
	]) {
		const entry = createWorkerOutputEntry(input, { actionId: input.actionId, ...terminal }, 1000);
		const text = workerOutputDisplay(entry, false, theme);
		assert.match(text, /Outcome: UNKNOWN/);
		assert.doesNotMatch(text, /✓|Worker-reported STATUS: COMPLETE|Await manager review dispatch/);
		if (terminal.error) assert.ok(text.indexOf(terminal.error) < text.indexOf("Outcome: UNKNOWN"));
		if (terminal.response) assert.ok(workerOutputDisplay(entry, true, theme).includes(terminal.response.split("\n")[0]!));
	}
});

test("Reviewer APPROVE and Judge DONE are reports, not plan or run approval", () => {
	for (const [role, response, expected] of [
		["plan-reviewer", "VERDICT: APPROVE\nSCOPE: PASS\nRATIONALE: patch inspected", /Judge adjudication.*not plan approval/],
		["plan-judge", "DECISION: DONE\nRATIONALE: review complete", /integration\/final verification.*not run completion/],
	] as const) {
		const input = createWorkerInputEntry({ ...action(), role }, "worker", 0);
		const entry = createWorkerOutputEntry(input, { actionId: input.actionId, response }, 1000);
		const text = workerOutputDisplay(entry, false, theme);
		assert.match(text, /Worker-reported (VERDICT: APPROVE|DECISION: DONE)/);
		assert.match(text, /not manager acceptance/);
		assert.match(text, expected);
		assert.doesNotMatch(text, /✓/);
	}
});


test("Judge NEEDS_INPUT preserves its distinct question and deduplicates identical rationale", () => {
	const input = createWorkerInputEntry({ ...action(), role: "plan-judge" }, "worker", 0);
	const question = "Which requirement is authoritative? " + "Context for the decision. ".repeat(25);
	for (const rationale of ["Ambiguous requirement", question]) {
		const entry = createWorkerOutputEntry(input, { actionId: input.actionId, response: `DECISION: NEEDS_INPUT\nRATIONALE: ${rationale}\nQUESTION: ${question}` });
		const text = workerOutputDisplay(entry, false, theme);
		assert.ok(text.includes(`Question: ${question.trim()}`));
		assert.equal(text.split(question.trim()).length - 1, 1);
		if (rationale !== question) assert.match(text, /Reason: Ambiguous requirement/);
	}
});

test("presentation is extracted before long checks clip the stop reason", () => {
	const input = createWorkerInputEntry(action(), "worker-long", 0);
	const reason = "V3 not verified because the remote target is unavailable.";
	const response = `STATUS: STOPPED\nCHECKS: first check\n${Array.from({ length: 420 }, (_, i) => `check ${i} — passed`).join("\n")}\nSTOPPED BECAUSE: ${reason}\nNOTES: Changes preserved`;
	const entry = createWorkerOutputEntry(input, { actionId: input.actionId, response });
	assert.equal(entry.presentation?.stopReason, reason);
	assert.doesNotMatch(entry.response!, /V3 not verified/);
	assert.deepEqual(Object.keys(entry.presentation!).sort(), ["kind", "outcome", "stopReason", "summary"]);
	for (const expanded of [false, true]) {
		const text = workerOutputDisplay(entry, expanded, theme);
		assert.match(text, /Worker-reported STATUS: STOPPED/);
		assert.ok(text.includes(`Reason: ${reason}`));
		assert.match(text, /Evidence truncated: expansion is also bounded/);
		assert.match(text, /Full evidence remains in the Herder runtime/);
		assert.match(text, /action: action-1.*handle: worker-long/);
	}
	const legacy = { ...entry };
	delete legacy.presentation;
	const text = workerOutputDisplay(legacy, false, theme);
	assert.match(text, /Outcome: UNKNOWN.*incomplete legacy transcript/);
	assert.doesNotMatch(text, /Worker-reported STATUS:/);
	assert.match(text, /Full evidence remains in the Herder runtime/);
	assert.match(text, /action: action-1.*handle: worker-long/);
});

test("transport errors override retained COMPLETE and clean legacy entries still parse", () => {
	const input = createWorkerInputEntry(action(), "worker", 0);
	const entry = createWorkerOutputEntry(input, { actionId: input.actionId, response: "STATUS: COMPLETE\nNOTES: preserved" });
	assert.equal(entry.presentation?.outcome, "COMPLETE");
	for (const failure of [{ error: "lost transport" }, { status: "interrupted" as const }, { failureKind: "review_budget_exhausted" as const }]) {
		const text = workerOutputDisplay({ ...entry, ...failure }, false, theme);
		assert.match(text, /Outcome: UNKNOWN.*transport failed/);
		assert.doesNotMatch(text, /Worker-reported STATUS: COMPLETE/);
	}
	delete entry.presentation;
	assert.match(workerOutputDisplay(entry, false, theme), /Worker-reported STATUS: COMPLETE/);
});

test("long critical questions and stop reasons survive while incidental summaries stay bounded", () => {
	const input = createWorkerInputEntry({ ...action(), role: "plan-judge" }, "worker", 0);
	const question = `${"Context. ".repeat(2400)}Which origin is authorized?`;
	const entry = createWorkerOutputEntry(input, { actionId: input.actionId, response: `DECISION: NEEDS_INPUT\nRATIONALE: ${"r".repeat(20000)}\nQUESTION: ${question}` });
	assert.ok(entry.presentation!.summary.length < 4500);
	assert.equal(entry.presentation!.question, question);
	assert.ok(workerOutputDisplay(entry, false, theme).includes(`Question: ${question}`));
	assert.match(workerOutputDisplay(entry, false, theme), /Full evidence remains in the Herder runtime/);
	const implementer = createWorkerInputEntry(action(), "worker", 0);
	const reason = `${"Evidence. ".repeat(2400)}Changing the upstream contract is explicitly out of scope.`;
	const stopped = createWorkerOutputEntry(implementer, { actionId: implementer.actionId, response: `STATUS: STOPPED\nSTOPPED BECAUSE: ${reason}` });
	assert.equal(stopped.presentation!.stopReason, reason);
	assert.ok(workerOutputDisplay(stopped, false, theme).includes(`Reason: ${reason}`));
});
