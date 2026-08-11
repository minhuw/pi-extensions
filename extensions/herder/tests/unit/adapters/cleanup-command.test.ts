import assert from "node:assert/strict";
import test from "node:test";
import { parseCleanupArguments } from "../../../adapters/arguments.ts";
import { runCleanupCommand } from "../../../adapters/cleanup-command.ts";
import type { CleanupApplyResult, CleanupPreview } from "../../../src/application/tools.ts";
import type { CleanupResult } from "../../../src/daemon/git/cleanup-run.ts";

function cleanupResult(plan: string, action = true, removed = false): CleanupResult {
	return {
		repoRoot: "/repo",
		planDir: "/repo/herder-plans",
		planName: "herder-plans",
		integrationBranch: "herder/herder-plans/integration",
		integrationHead: "head",
		plan,
		dryRun: !removed,
		includeFailed: plan === "002",
		finalize: false,
		handoffTarget: null,
		actions: action ? [{ plan, branch: `herder/herder-plans/${plan}`, mode: plan === "002" ? "failed-evidence" : "completed-plan" }] : [],
		removed: removed ? [{ plan }] : [],
		skipped: [],
		finalization: { requested: false, eligible: false, blockers: [], refsPlanned: [], refsRemoved: [] },
		handoff: { requested: false, targetBranch: null, targetHead: null, eligible: false, blockers: [], integrationWorktree: "/tmp/integration", removed: false },
		preserved: { integrationBranch: "herder/herder-plans/integration", integrationWorktree: "/tmp/integration", coordinationRefs: "refs/plan-herder/herder-plans/", logs: true },
	};
}

function preview(input: Partial<CleanupPreview> = {}): CleanupPreview {
	return {
		version: 1,
		durableStatus: "complete",
		terminal: true,
		canApply: true,
		selectedPlanIds: ["001"],
		failedPlanIds: [],
		skippedPlanIds: [],
		outcomes: [{ planId: "001", status: "DONE", result: cleanupResult("001") }],
		blockers: [],
		normalizedPreview: "preview",
		...input,
	};
}

function finalizeCleanupResult(removed = false): CleanupResult {
	const result = cleanupResult("001", true, removed);
	return {
		...result,
		finalize: true,
		finalization: {
			requested: true,
			eligible: true,
			blockers: [],
			refsPlanned: [
				{ ref: "refs/plan-herder/herder-plans/base", target: "head", kind: "base" },
				{ ref: "refs/plan-herder/herder-plans/completed/001", target: "head", kind: "completed", plan: "001" },
			],
			refsRemoved: removed
				? [
					{ ref: "refs/plan-herder/herder-plans/base", target: "head", kind: "base" },
					{ ref: "refs/plan-herder/herder-plans/completed/001", target: "head", kind: "completed", plan: "001" },
				]
				: [],
		},
	};
}

test("cleanup parser is fail-closed and preserves the exact command shape", () => {
	assert.deepEqual(parseCleanupArguments("custom-plans --plan 7 --include-failed"), {
		planDir: "custom-plans",
		planId: "7",
		includeFailed: true,
		finalize: false,
	});
	assert.deepEqual(parseCleanupArguments("--finalize --handoff-target release --include-failed"), {
		planDir: "herder-plans",
		includeFailed: true,
		finalize: true,
		handoffTarget: "release",
	});
	assert.deepEqual(parseCleanupArguments(""), { planDir: "herder-plans", includeFailed: false, finalize: false });
	assert.throws(() => parseCleanupArguments("--plan 7 --plan 8"), /more than once/);
	assert.throws(() => parseCleanupArguments("--finalize --finalize"), /more than once/);
	assert.throws(() => parseCleanupArguments("--handoff-target"), /requires a value/);
	assert.throws(() => parseCleanupArguments("--handoff-target release"), /requires --finalize/);
	assert.throws(() => parseCleanupArguments("--finalize --plan 7"), /cannot be combined/);
	assert.throws(() => parseCleanupArguments("--include-failed --unknown"), /Unknown option/);
	assert.throws(() => parseCleanupArguments("--plan TODO"), /numeric/);
});

test("failed evidence requires a second confirmation and applies only after both succeed", async () => {
	const confirmations: string[] = [];
	const entries: unknown[] = [];
	let applyCalls = 0;
	const failedPreview = preview({
		selectedPlanIds: ["002"],
		failedPlanIds: ["002"],
		outcomes: [{ planId: "002", status: "BLOCKED", result: cleanupResult("002") }],
	});
	const result = await runCleanupCommand("--plan 2 --include-failed", {
		repositoryRoot: "/repo",
		planDirectory: "/repo/herder-plans",
		preview: async () => failedPreview,
		apply: async () => {
			applyCalls += 1;
			return { ...failedPreview, executed: true, outcomes: [{ ...failedPreview.outcomes[0]!, result: cleanupResult("002", true, true) }] } satisfies CleanupApplyResult;
		},
		confirm: async (title) => {
			confirmations.push(title);
			return true;
		},
		appendEntry: (entry) => entries.push(entry),
	});
	assert.equal(applyCalls, 1);
	assert.deepEqual(confirmations, ["Clean up completed Herder plans?", "Remove failed Herder evidence?"]);
	assert.equal(result.cancelled, false);
	assert.equal(result.applied?.executed, true);
	assert.equal(entries.length, 1);
	assert.deepEqual((entries[0] as Record<string, unknown>).removed, ["002"]);
});

test("transcript publication failure is surfaced instead of reporting cleanup success", async () => {
	let applyCalls = 0;
	await assert.rejects(
		() => runCleanupCommand("--plan 1", {
			repositoryRoot: "/repo",
			planDirectory: "/repo/herder-plans",
			preview: async () => preview(),
			apply: async () => {
				applyCalls += 1;
				return { ...preview(), executed: true, outcomes: [{ ...preview().outcomes[0]!, result: cleanupResult("001", true, true) }] };
			},
			confirm: async () => true,
			appendEntry: () => { throw new Error("transcript unavailable"); },
		}),
		/transcript unavailable/,
	);
	assert.equal(applyCalls, 1);
});

test("finalization presents refs and integration state in bounded transcript evidence", async () => {
	const confirmations: string[] = [];
	const entries: unknown[] = [];
	const finalizePreview = preview({
		selectedPlanIds: ["001"],
		outcomes: [{ planId: "RUN", status: "UNKNOWN", result: finalizeCleanupResult() }],
	});
	const result = await runCleanupCommand("--finalize", {
		repositoryRoot: "/repo",
		planDirectory: "/repo/herder-plans",
		preview: async () => finalizePreview,
		apply: async () => ({
			...finalizePreview,
			outcomes: [{ planId: "RUN", status: "UNKNOWN", result: finalizeCleanupResult(true) }],
			executed: true,
		}),
		confirm: async (title) => {
			confirmations.push(title);
			return true;
		},
		appendEntry: (entry) => entries.push(entry),
	});
	assert.equal(result.cancelled, false);
	assert.deepEqual(confirmations, ["Finalize Herder cleanup?"]);
	assert.equal(entries.length, 1);
	const entry = entries[0] as Record<string, unknown>;
	assert.equal(entry.finalize, true);
	assert.deepEqual(entry.plannedRefs, ["base", "completed:001"]);
	assert.deepEqual(entry.removedRefs, ["base", "completed:001"]);
	assert.equal(entry.integration, "preserved");
	assert.equal(Object.hasOwn(entry, "paths"), false);
	assert.equal(Object.hasOwn(entry, "hashes"), false);
});

test("cancellation is mutation-free and records bounded transcript evidence", async () => {
	const entries: unknown[] = [];
	let applyCalls = 0;
	const result = await runCleanupCommand("--plan 1", {
		repositoryRoot: "/repo",
		planDirectory: "/repo/herder-plans",
		preview: async () => preview(),
		apply: async () => {
			applyCalls += 1;
			return { ...preview(), executed: true };
		},
		confirm: async () => false,
		appendEntry: (entry) => entries.push(entry),
	});
	assert.equal(applyCalls, 0);
	assert.equal(result.cancelled, true);
	assert.equal(entries.length, 1);
	const entry = entries[0] as Record<string, unknown>;
	assert.equal(entry.executed, false);
	assert.equal(Object.hasOwn(entry, "paths"), false);
	assert.equal(Object.hasOwn(entry, "hashes"), false);
});

test("active or missing durable runs are preview-only", async () => {
	let confirms = 0;
	let applies = 0;
	const result = await runCleanupCommand("", {
		repositoryRoot: "/repo",
		planDirectory: "/repo/herder-plans",
		preview: async () => preview({ durableStatus: "active", terminal: false, canApply: false, blockers: ["run-not-terminal"] }),
		apply: async () => {
			applies += 1;
			return { ...preview(), executed: true };
		},
		confirm: async () => {
			confirms += 1;
			return true;
		},
	});
	assert.equal(confirms, 0);
	assert.equal(applies, 0);
	assert.match(result.message, /preview-only/);
});
