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
		startedAt: 1,
		updatedAt: 2,
	};
	assert.deepEqual(restoreLastRun([
		{ type: "custom", customType: HERDER_STATE_ENTRY, data: { nope: true } },
		{ type: "custom", customType: HERDER_STATE_ENTRY, data: state },
	]), state);
});

test("session restoration accepts attach mode", () => {
	const state: HerderRunState = {
		version: 1,
		mode: "attach",
		status: "paused",
		runId: "run-attached",
		repoRoot: "/tmp/repo",
		planDir: "/tmp/repo/herder-plans",
		profile: "eclipse",
		maxParallel: 3,
		startedAt: 1,
		updatedAt: 2,
	};
	assert.deepEqual(restoreLastRun([{ type: "custom", customType: HERDER_STATE_ENTRY, data: state }]), state);
});

test("historical state with legacy fields remains restorable", () => {
	const state: HerderRunState = {
		version: 1,
		mode: "resume",
		status: "running",
		runId: "run-legacy",
		repoRoot: "/tmp/repo",
		planDir: "/tmp/repo/herder-plans",
		profile: "eclipse",
		maxParallel: 2,
		startedAt: 1,
		updatedAt: 2,
	};
	const legacyState = { ...state, asyncDir: "/tmp/async", dashboardEnabled: true };
	assert.deepEqual(restoreLastRun([{ type: "custom", customType: HERDER_STATE_ENTRY, data: legacyState }]), legacyState);
	assert.equal(sameHerderRunState(state, legacyState), true);
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
		startedAt: 1,
		updatedAt: 2,
	};
	assert.equal(sameHerderRunState(state, { ...state, updatedAt: 3 }), true);
	assert.equal(sameHerderRunState(state, { ...state, status: "complete", updatedAt: 3 }), false);
});
