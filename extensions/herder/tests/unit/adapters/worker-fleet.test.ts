import assert from "node:assert/strict";
import test from "node:test";
import { workerFleetLines } from "../../../adapters/worker-fleet.ts";

test("Pi worker fleet is compact and information dense", () => {
	assert.deepEqual(workerFleetLines([{
		handle: "pi-worker:one",
		actionId: "action-1",
		planId: "018",
		role: "plan-reviewer",
		model: "gpt-5.6-sol",
		effort: "xhigh",
		status: "running",
		startedAt: 1_000,
		turns: 2,
		toolUses: 3,
		tokens: 12_400,
		activity: "bash",
	}], 66_000), ["● 018 reviewer · bash · 3 tools · 12k · 1m05s"]);
});
