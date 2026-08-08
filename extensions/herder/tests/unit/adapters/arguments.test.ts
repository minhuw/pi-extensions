import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFireArguments, parseGrillPlanTarget, parsePlanCommandArguments, parsePlanDirArguments, tokenizeArguments } from "../../../adapters/arguments.ts";
import { resolvePlanDirectory, resolvePlanDirectoryTarget } from "../../../adapters/paths.ts";

test("tokenizes shell-style plan paths without invoking a shell", () => {
	assert.deepEqual(tokenizeArguments(`"plans with spaces" --profile 'poorman'`), ["plans with spaces", "--profile", "poorman"]);
	assert.deepEqual(tokenizeArguments("plans\\ with\\ spaces"), ["plans with spaces"]);
	assert.throws(() => tokenizeArguments("'unfinished"), /unterminated quote/);
});

test("extracts an active-Fire Grill target without consuming the skill arguments", () => {
	assert.deepEqual(parseGrillPlanTarget("--plan 7 --plan-dir custom-plans"), { planId: "7", planDir: "custom-plans" });
	assert.deepEqual(parseGrillPlanTarget("refine this later"), null);
	assert.throws(() => parseGrillPlanTarget("--plan 1 --plan 2"), /more than once/);
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

test("argument validation is fail-closed", () => {
	assert.throws(() => parseFireArguments("--max-parallel 0", "fire"), /between 1 and 32/);
	assert.throws(() => parseFireArguments("--dashboard-port 65536", "fire"), /0 through 65535/);
	assert.throws(() => parseFireArguments("--unknown", "fire"), /Unknown option/);
	assert.throws(() => parseFireArguments("one two", "fire"), /Unexpected argument/);
	assert.deepEqual(parsePlanDirArguments(""), {});
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
