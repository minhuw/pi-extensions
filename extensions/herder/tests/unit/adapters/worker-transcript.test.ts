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
		model: "gpt-5.6-luna",
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
	assert.match(collapsed, /Plan 001 · round 1 · INITIAL/);
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
	assert.match(collapsed, /2\.0k tokens · 3s/);
	assert.match(collapsed, /STATUS: COMPLETE/);
	assert.doesNotMatch(collapsed, /NOTES: done/);
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

test("worker transcript entries cap oversized child payloads", () => {
	const prompt = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
	const entry = createWorkerInputEntry(action(prompt), "pi-worker:session-1", 1_000);
	assert.match(entry.prompt, /Herder transcript truncated to 400\/2100 lines/);
});
