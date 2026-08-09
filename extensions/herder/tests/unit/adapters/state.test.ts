import assert from "node:assert/strict";
import test from "node:test";
import { HERDER_STATE_ENTRY, restoreLastRun, sameHerderRunState, type HerderRunState } from "../../../adapters/state.ts";

test("session restoration uses the newest valid Herder entry", () => {
	const state: HerderRunState = {
		version: 1,
		mode: "fire",
		status: "running",
		runId: "run-1",
		repoRoot: "/tmp/repo",
		planDir: "/tmp/repo/herder-plans",
		profile: "poorman",
		maxParallel: 5,
		dashboardEnabled: true,
		startedAt: 1,
		updatedAt: 2,
	};
	assert.deepEqual(restoreLastRun([
		{ type: "custom", customType: HERDER_STATE_ENTRY, data: { nope: true } },
		{ type: "custom", customType: HERDER_STATE_ENTRY, data: state },
	]), state);
});

test("state persistence ignores heartbeat-only timestamp changes", () => {
	const state: HerderRunState = {
		version: 1,
		mode: "fire",
		status: "running",
		runId: "run-1",
		repoRoot: "/tmp/repo",
		planDir: "/tmp/repo/herder-plans",
		profile: "eclipse",
		maxParallel: 5,
		dashboardEnabled: true,
		startedAt: 1,
		updatedAt: 2,
	};
	assert.equal(sameHerderRunState(state, { ...state, updatedAt: 3 }), true);
	assert.equal(sameHerderRunState(state, { ...state, status: "complete", updatedAt: 3 }), false);
});
