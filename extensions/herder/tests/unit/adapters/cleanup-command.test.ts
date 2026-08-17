import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	cleanupTranscriptDisplay,
	createCleanupTranscriptEntry,
} from "../../../adapters/cleanup-transcript.ts";
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
		deep: false,
		force: false,
		actions: action ? [{ plan, branch: `herder/herder-plans/${plan}`, mode: plan === "002" ? "failed-evidence" : "completed-plan" }] : [],
		removed: removed ? [{ plan }] : [],
		skipped: [],
		destruction: { requested: false, eligible: false, blockers: [], refsPlanned: [], refsRemoved: [], integrationWorktree: "/tmp/integration", integrationRemoved: false, planDirectoryRemoved: false },
		preserved: { integrationBranch: "herder/herder-plans/integration", integrationWorktree: "/tmp/integration", coordinationRefs: "refs/plan-herder/herder-plans/", planDirectory: true },
	};
}

function preview(input: Partial<CleanupPreview> = {}): CleanupPreview {
	return {
		version: 1,
		durableStatus: "complete",
		terminal: true,
		canApply: true,
		force: false,
		selectedPlanIds: ["001"],
		failedPlanIds: [],
		skippedPlanIds: [],
		outcomes: [{ planId: "001", status: "DONE", result: cleanupResult("001") }],
		blockers: [],
		normalizedPreview: "preview",
		...input,
	};
}

function deepCleanupResult(removed = false): CleanupResult {
	const result = cleanupResult("001", true, removed);
	return {
		...result,
		deep: true,
		destruction: {
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
			integrationWorktree: "/tmp/integration",
			integrationRemoved: removed,
			planDirectoryRemoved: removed,
		},
	};
}

const transcriptTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("cleanup transcripts render standard, deep, and force v2 entries", () => {
	const standard = createCleanupTranscriptEntry({ mode: "standard", preview: "eligible", executed: true, removed: ["001"] });
	const standardDisplay = cleanupTranscriptDisplay(standard, transcriptTheme);
	assert.match(standardDisplay, /standard · executed/);
	assert.match(standardDisplay, /removed: 001/);
	assert.doesNotMatch(standardDisplay, /planned refs:/);

	const deep = createCleanupTranscriptEntry({ mode: "deep", deep: true, preview: "eligible", executed: true, plannedRefs: ["base"], removedRefs: ["base"] });
	assert.equal(deep.version, 2);
	const deepDisplay = cleanupTranscriptDisplay(deep, transcriptTheme);
	assert.match(deepDisplay, /deep · executed/);
	assert.match(deepDisplay, /planned refs: base/);

	const force = createCleanupTranscriptEntry({ mode: "force", preview: "eligible", executed: true, plannedRefs: ["base"], removedRefs: ["base"] });
	assert.match(cleanupTranscriptDisplay(force, transcriptTheme), /force · executed/);
});

test("cleanup parser is fail-closed and preserves the exact command shape", () => {
	assert.deepEqual(parseCleanupArguments("custom-plans --plan 7 --include-failed"), {
		planDir: "custom-plans",
		planId: "7",
		includeFailed: true,
		deep: false,
		force: false,
	});
	assert.deepEqual(parseCleanupArguments("--deep --include-failed"), { planDir: "herder-plans", includeFailed: true, deep: true, force: false });
	assert.deepEqual(parseCleanupArguments("--force"), { planDir: "herder-plans", includeFailed: false, deep: false, force: true });
	assert.deepEqual(parseCleanupArguments(""), { planDir: "herder-plans", includeFailed: false, deep: false, force: false });
	assert.throws(() => parseCleanupArguments("--plan 7 --plan 8"), /more than once/);
	assert.throws(() => parseCleanupArguments("--deep --deep"), /more than once/);
	assert.throws(() => parseCleanupArguments("--force --force"), /more than once/);
	assert.throws(() => parseCleanupArguments("--finalize"), /use --deep/);
	assert.throws(() => parseCleanupArguments("--handoff-target release"), /use --deep/);
	assert.throws(() => parseCleanupArguments("--deep --plan 7"), /cannot be combined/);
	assert.throws(() => parseCleanupArguments("--force --deep"), /cannot be combined/);
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

test("deep cleanup presents refs and integration state in bounded transcript evidence", async () => {
	const confirmations: string[] = [];
	const entries: unknown[] = [];
	const finalizePreview = preview({
		selectedPlanIds: ["001"],
		outcomes: [{ planId: "RUN", status: "UNKNOWN", result: deepCleanupResult() }],
	});
	const result = await runCleanupCommand("--deep", {
		repositoryRoot: "/repo",
		planDirectory: "/repo/herder-plans",
		preview: async () => finalizePreview,
		apply: async () => ({
			...finalizePreview,
			outcomes: [{ planId: "RUN", status: "UNKNOWN", result: deepCleanupResult(true) }],
			executed: true,
		}),
		confirm: async (title) => {
			confirmations.push(title);
			return true;
		},
		appendEntry: (entry) => entries.push(entry),
	});
	assert.equal(result.cancelled, false);
	assert.deepEqual(confirmations, ["Deep-clean Herder plan set?"]);
	assert.equal(entries.length, 1);
	const entry = entries[0] as Record<string, unknown>;
	assert.equal(entry.deep, true);
	assert.deepEqual(entry.plannedRefs, ["base", "completed:001"]);
	assert.deepEqual(entry.removedRefs, ["base", "completed:001"]);
	assert.equal(entry.integration, "removed");
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

test("force cleanup can apply while the durable run is still active", async () => {
	const confirmations: string[] = [];
	const forcePreview = preview({
		durableStatus: "active",
		terminal: false,
		canApply: true,
		force: true,
		outcomes: [{ planId: "RUN", status: "UNKNOWN", result: { ...deepCleanupResult(), force: true } }],
	});
	const result = await runCleanupCommand("--force", {
		repositoryRoot: "/repo",
		planDirectory: "/repo/herder-plans",
		preview: async () => forcePreview,
		apply: async () => ({
			...forcePreview,
			outcomes: [{ planId: "RUN", status: "UNKNOWN", result: { ...deepCleanupResult(true), force: true } }],
			executed: true,
		}),
		confirm: async (title) => {
			confirmations.push(title);
			return true;
		},
	});
	assert.deepEqual(confirmations, ["Unconditionally destroy this Herder plan set?"]);
	assert.equal(result.cancelled, false);
	assert.equal(result.applied?.executed, true);
	assert.match(result.message, /Force cleanup executed/);
});
