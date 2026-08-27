import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAttachArguments, parseCleanupArguments, parseFireArguments, parseGrillPlanTarget, parsePlanCommandArguments, parsePlanDirArguments, parseResetArguments, parseReworkArguments, tokenizeArguments } from "../../../adapters/arguments.ts";
import { resolvePlanDirectory, resolvePlanDirectoryTarget } from "../../../adapters/paths.ts";

test("tokenizes shell-style plan paths without invoking a shell", () => {
	assert.deepEqual(tokenizeArguments(`"plans with spaces" --profile 'poorman'`), ["plans with spaces", "--profile", "poorman"]);
	assert.deepEqual(tokenizeArguments("plans\\ with\\ spaces"), ["plans with spaces"]);
	assert.throws(() => tokenizeArguments("'unfinished"), /unterminated quote/);
});

test("extracts standalone and active-Fire Grill targets without consuming skill arguments", () => {
	assert.deepEqual(parseGrillPlanTarget("--plan 7 --plan-dir custom-plans"), { planId: "7", planDir: "custom-plans" });
	assert.deepEqual(parseGrillPlanTarget("--plan 007-plan.md --split --plan-dir custom-plans"), { planId: "007-plan.md", planDir: "custom-plans", split: true });
	assert.deepEqual(parseGrillPlanTarget("refine this later"), null);
	assert.throws(() => parseGrillPlanTarget("--plan 1 --plan 2"), /more than once/);
	assert.throws(() => parseGrillPlanTarget("--plan 1 --split --split"), /--split was provided more than once/);
	assert.throws(() => parseGrillPlanTarget("--split"), /--split requires --plan/);
});

test("reset accepts an optional plan directory and rejects options", () => {
	assert.deepEqual(parseResetArguments(""), { planDir: "herder-plans" });
	assert.deepEqual(parseResetArguments("custom-plans"), { planDir: "custom-plans" });
	assert.throws(() => parseResetArguments("one two"), /Usage/);
	assert.throws(() => parseResetArguments("--force"), /Unknown option/);
});
test("rework requires a plan id and an optional plan directory", () => {
	assert.deepEqual(parseReworkArguments("009"), { planId: "009" });
	assert.deepEqual(parseReworkArguments("9 herder-plans"), { planId: "9", planDir: "herder-plans" });
	assert.deepEqual(parseReworkArguments("009-blocked.md custom-plans"), { planId: "009-blocked.md", planDir: "custom-plans" });
	assert.throws(() => parseReworkArguments(""), /Usage/);
	assert.throws(() => parseReworkArguments("009 extra leftover"), /Usage/);
	assert.throws(() => parseReworkArguments("--plan 009"), /Unknown option/);
	assert.throws(() => parseReworkArguments("not-a-plan"), /numeric ID/);
});
test("fire defaults to a five-worker pool and an ephemeral dashboard port", () => {
	assert.deepEqual(parseFireArguments("", "fire"), {
		mode: "fire",
		planDir: "herder-plans",
		maxParallel: 5,
		dashboardPort: 0,
	});
	assert.deepEqual(parseFireArguments("", "resume"), {
		mode: "resume",
		planDir: "herder-plans",
		dashboardPort: 0,
	});
	assert.deepEqual(parseFireArguments("", "revise"), {
		mode: "revise",
		planDir: "herder-plans",
		dashboardPort: 0,
	});
	assert.deepEqual(parseFireArguments("custom --profile poorman --max-parallel 7 --dashboard-port 4312", "resume"), {
		mode: "resume",
		planDir: "custom",
		profile: "poorman",
		maxParallel: 7,
		dashboardPort: 4312,
	});
});

test("attach accepts only a plan directory and dashboard port", () => {
	assert.deepEqual(parseAttachArguments(""), { planDir: "herder-plans", dashboardPort: 0 });
	assert.deepEqual(parseAttachArguments('"plans with spaces" --dashboard-port 4312'), { planDir: "plans with spaces", dashboardPort: 4312 });
	assert.throws(() => parseAttachArguments("--profile eclipse"), /Unknown option: --profile/);
	assert.throws(() => parseAttachArguments("--max-parallel 2"), /Unknown option: --max-parallel/);
	assert.throws(() => parseAttachArguments("--dashboard-port 65536"), /0 through 65535/);
	assert.throws(() => parseAttachArguments("one two"), /Unexpected argument/);
});

test("argument validation is fail-closed", () => {
	assert.throws(() => parseFireArguments("--max-parallel", "revise"), /only supported by \/herder-fire and \/herder-resume/);
	assert.throws(() => parseFireArguments("--max-parallel 7", "revise"), /only supported by \/herder-fire and \/herder-resume/);
	assert.throws(() => parseFireArguments("--max-parallel 5", "revise"), /only supported by \/herder-fire and \/herder-resume/);
	assert.throws(() => parseFireArguments("--max-parallel 0", "fire"), /between 1 and 32/);
	assert.throws(() => parseFireArguments("--dashboard-port 65536", "fire"), /0 through 65535/);
	assert.throws(() => parseFireArguments("--unknown", "fire"), /Unknown option/);
	assert.throws(() => parseFireArguments("one two", "fire"), /Unexpected argument/);
	assert.deepEqual(parsePlanDirArguments(""), {});
});

test("cleanup accepts ordinary, deep, and force modes and rejects removed destructive options", () => {
	assert.deepEqual(parseCleanupArguments(""), { planDir: "herder-plans", includeFailed: false, deep: false, force: false });
	assert.deepEqual(parseCleanupArguments("plans --plan 7 --include-failed"), { planDir: "plans", planId: "7", includeFailed: true, deep: false, force: false });
	assert.deepEqual(parseCleanupArguments("plans --deep"), { planDir: "plans", includeFailed: false, deep: true, force: false });
	assert.deepEqual(parseCleanupArguments("--deep --include-failed"), { planDir: "herder-plans", includeFailed: true, deep: true, force: false });
	assert.deepEqual(parseCleanupArguments("plans --force"), { planDir: "plans", includeFailed: false, deep: false, force: true });
	assert.deepEqual(parseCleanupArguments("--force"), { planDir: "herder-plans", includeFailed: false, deep: false, force: true });
	assert.throws(() => parseCleanupArguments("--plan 7 --plan 8"), /more than once/);
	assert.throws(() => parseCleanupArguments("--deep --deep"), /more than once/);
	assert.throws(() => parseCleanupArguments("--force --force"), /more than once/);
	assert.throws(() => parseCleanupArguments("--deep --plan 7"), /plan-set-level/);
	assert.throws(() => parseCleanupArguments("--force --deep"), /cannot be combined/);
	assert.throws(() => parseCleanupArguments("--force --plan 7"), /cannot be combined/);
	assert.throws(() => parseCleanupArguments("--include-failed --unknown"), /Unknown option/);
	assert.throws(() => parseCleanupArguments("--plan TODO"), /numeric/);
	assert.throws(() => parseCleanupArguments("--finalize"), /use --deep/);
	assert.throws(() => parseCleanupArguments("--handoff-target main"), /use --deep/);
});

test("parses Pi-native deterministic plan commands", () => {
	assert.deepEqual(parsePlanCommandArguments("init --track"), {
		operation: "init",
		planDir: "herder-plans",
		track: true,
	});
	assert.deepEqual(parsePlanCommandArguments("ready \"plans with spaces\""), {
		operation: "ready",
		planDir: "plans with spaces",
	});
	assert.deepEqual(parsePlanCommandArguments("snapshot 7 custom-plans"), {
		operation: "snapshot",
		planDir: "custom-plans",
		planId: "7",
	});
	assert.deepEqual(parsePlanCommandArguments("report RUN"), {
		operation: "report",
		planDir: "herder-plans",
		planId: "RUN",
	});
	assert.throws(() => parsePlanCommandArguments(""), /Usage:/);
	assert.throws(() => parsePlanCommandArguments("ready --track"), /only with.*init/);
	assert.throws(() => parsePlanCommandArguments("unknown"), /Unknown Herder plan operation/);
});

test("plan paths cannot escape the repository lexically or through symlinks", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-pi-paths-"));
	try {
		const repo = path.join(root, "repo");
		const planDir = path.join(repo, "herder-plans");
		const outside = path.join(root, "outside");
		mkdirSync(planDir, { recursive: true });
		mkdirSync(outside);
		assert.equal(resolvePlanDirectory(repo, "herder-plans"), realpathSync(planDir));
		assert.equal(resolvePlanDirectoryTarget(repo, "new/plans"), path.join(realpathSync(repo), "new/plans"));
		assert.throws(() => resolvePlanDirectory(repo, ".."), /must stay inside/);
		assert.throws(() => resolvePlanDirectoryTarget(repo, "."), /must stay inside/);
		symlinkSync(outside, path.join(repo, "escaped-plans"));
		assert.throws(() => resolvePlanDirectory(repo, "escaped-plans"), /must stay inside/);
		assert.throws(() => resolvePlanDirectoryTarget(repo, "escaped-plans/new"), /must stay inside/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
