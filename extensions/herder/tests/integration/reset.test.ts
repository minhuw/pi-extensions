import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { applyHerderReset } from "../../src/application/tools.ts";
import { initPlanDir, projectStatuses } from "../../src/core/plans.ts";
import { ensureService, requestManagerOperation,
	requestService, stopService } from "../../src/client/index.ts";
import { resetHerderPlanSet } from "../../src/daemon/git/reset-plan-set.ts";
import { canonicalWorktreeRoot, legacyWorktreeRoot } from "../../src/daemon/git/worktree-locations.ts";
import { RunStore } from "../../src/daemon/run-store.ts";
import { withTemporaryExecutableOnPath } from "../support/temp-executable.ts";

function command(cwd: string, args: string[], allowFailure = false): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
	return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function git(cwd: string, ...args: string[]): string { return command(cwd, args).stdout.trim(); }
function withPathlessWorktree<T>(branch: string, callback: () => T): T {
	const originalPath = process.env.PATH ?? "";
	const realPath = originalPath.replaceAll("'", "'\\\"'\\\"'");
	return withTemporaryExecutableOnPath({
		prefix: "herder-reset-shim-",
		script: `#!/bin/sh
real_git() { PATH='${realPath}'; export PATH; command git "$@"; }
case "$*" in
	*"worktree list --porcelain -z"*) real_git "$@"; printf 'branch refs/heads/${branch}\\0\\0'; exit ;;
esac
real_git "$@"
`,
	}, callback);
}


function planBody(id: string, title: string): string {
	return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`fixture\`, 2026-08-11
- **Kind**: behavioral
- **Parent objective**: Exercise reset.

## Why this matters

The reset fixture is deterministic.

## Current state

The fixture is ready.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exits 0 |

## Dependency contract

- **Consumes**: none.
- **Provides**: reset coverage.
- **Safe intermediate state**: only the declared fixture path changes.

## Scope

**In scope**:
- \`fixture.txt\`

**Out of scope**:
- Herder execution state.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit.

## Steps

### Step 1: Exercise reset

Keep the fixture bounded.

**Verify**: \`true\` → exits 0.

## Test plan

- Run the focused fixture test.

## Review map

- **Outcome**: reset removes the execution namespace.
- **Modified symbols**: none.
- **Direct contracts**: reset safety.
- **Expected unchanged behavior**: plan files remain intact.
- **Proof**: this integration test.
- **Expected diff**: none.

## Done criteria

- [ ] Reset can initialize a fresh run again.

## STOP conditions

Stop if user files or plan files would be removed.

## Maintenance notes

Keep this fixture deterministic.
`;
}

type Fixture = { root: string; repo: string; planDir: string; planName: string; readme: string; planFile: string; ignore: string; base: string };

function fixture(initialStatus = "TODO"): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-reset-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	command(repo, ["init", "-q", "-b", "main"]);
	command(repo, ["config", "user.name", "Herder reset test"]);
	command(repo, ["config", "user.email", "reset@example.invalid"]);
	fs.writeFileSync(path.join(repo, "fixture.txt"), "base\n");
	command(repo, ["add", "fixture.txt"]);
	command(repo, ["commit", "-q", "-m", "test: reset base"]);
	const base = git(repo, "rev-parse", "HEAD");
	const planDir = path.join(repo, "herder-plans");
	initPlanDir(planDir, { track: true });
	const readme = path.join(planDir, "README.md");
	const planFile = path.join(planDir, "001-reset.md");
	fs.writeFileSync(readme, `# Herder Plans\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|---|---|---|---|---|---|\n| [001](001-reset.md) | Reset fixture | P1 | S | — | ${initialStatus} |\n\n## Dependency notes\n\nNone.\n\n## Considered and rejected\n\nNone.\n`);
	fs.writeFileSync(planFile, planBody("001", "Reset fixture"));
	command(repo, ["add", "herder-plans"]);
	command(repo, ["commit", "-q", "-m", "test: add reset plan"]);
	return {
		root, repo, planDir, planName: path.basename(planDir), readme, planFile,
		ignore: fs.readFileSync(path.join(planDir, ".gitignore"), "utf8"), base,
	};
}

async function initializedFixture(): Promise<Fixture> {
	const value = fixture();
	const service = await ensureService(value.planDir);
	const response = await requestManagerOperation(service, "start", {
		mode: "fire", repositoryRoot: value.repo, planDirectory: value.planDir, profile: "eclipse", maxParallel: 1,
	});
	assert.equal((response.reply as Record<string, unknown>).status, "running");
	await stopService(value.planDir);
	const worktreeRoot = canonicalWorktreeRoot(value.planDir);
	for (const worktree of [path.join(worktreeRoot, "integration"), path.join(worktreeRoot, "001")]) command(value.repo, ["worktree", "unlock", worktree], true);
	return value;
}

function namespaceSnapshot(value: Fixture): string {
	return JSON.stringify({
		branches: git(value.repo, "for-each-ref", "--format=%(refname) %(objectname)", `refs/heads/herder/${value.planName}/`),
		refs: git(value.repo, "for-each-ref", "--format=%(refname) %(objectname)", `refs/plan-herder/${value.planName}/`),
		worktrees: git(value.repo, "worktree", "list", "--porcelain"),
		readme: fs.readFileSync(value.readme, "utf8"),
		plan: fs.readFileSync(value.planFile, "utf8"),
	});
}

function remove(value: Fixture): void { fs.rmSync(value.root, { recursive: true, force: true }); }

test("pathless owned worktree records reject whole-set reset before mutation", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const before = namespaceSnapshot(value);
		assert.throws(() => withPathlessWorktree(`herder/${value.planName}/001`, () => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir })), /pathless worktree record/);
		assert.equal(namespaceSnapshot(value), before);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});
test("reset removes the real Herder namespace, restores immutable statuses, preserves setup, and permits a fresh fire", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const beforePlan = fs.readFileSync(value.planFile, "utf8");
		const beforeIgnore = value.ignore;
		projectStatuses(value.planDir, [{ id: "001", status: "BLOCKED", detail: "temporary execution detail" }]);
		const store = new RunStore(value.planDir);
		try { store.updateRun({ status: "complete" }); } finally { store.close(); }
		const planRoot = canonicalWorktreeRoot(value.planDir);
		assert.equal(fs.realpathSync(path.join(planRoot, "integration")), fs.realpathSync(path.join(planRoot, "integration")));
		command(value.repo, ["update-ref", `refs/plan-herder/${value.planName}/completed/001`, value.base]);
		const result = resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir });
		assert.deepEqual(result.resetPlans, ["001"]);
		assert.equal(git(value.repo, "for-each-ref", `refs/heads/herder/${value.planName}/`), "");
		assert.equal(git(value.repo, "for-each-ref", `refs/plan-herder/${value.planName}/`), "");
		assert.equal(git(value.repo, "worktree", "list", "--porcelain").includes(planRoot), false);
		assert.equal(fs.existsSync(path.join(planRoot, "integration")), false);
		assert.equal(fs.existsSync(path.join(planRoot, "001")), false);
		assert.equal(fs.readFileSync(value.planFile, "utf8"), beforePlan);
		assert.match(fs.readFileSync(value.readme, "utf8"), /\| TODO \|/);
		assert.doesNotMatch(fs.readFileSync(value.readme, "utf8"), /temporary execution detail/);
		assert.equal(fs.readFileSync(path.join(value.planDir, ".gitignore"), "utf8"), beforeIgnore);
		const empty = new RunStore(value.planDir);
		try { assert.equal(empty.getRun(), null); } finally { empty.close(); }
		const fresh = await ensureService(value.planDir);
		const started = await requestManagerOperation(fresh, "start", {
			mode: "fire", repositoryRoot: value.repo, planDirectory: value.planDir, profile: "eclipse", maxParallel: 1,
		});
		assert.equal((started.reply as Record<string, unknown>).status, "running");
		await stopService(value.planDir);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("merged integration refuses without mutating artifacts or statuses", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const integration = `herder/${value.planName}/integration`;
		const integrationRoot = path.join(canonicalWorktreeRoot(value.planDir), "integration");
		fs.writeFileSync(path.join(integrationRoot, "merged.txt"), "merged\n");
		command(integrationRoot, ["add", "merged.txt"]);
		command(integrationRoot, ["commit", "-q", "-m", "test: merge integration"]);
		command(value.repo, ["merge", "-q", "--ff-only", integration]);
		const before = namespaceSnapshot(value);
		await assert.rejects(async () => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir }), /already been merged/);
		assert.equal(namespaceSnapshot(value), before);
		assert.notEqual(git(value.repo, "show-ref", "--verify", `refs/heads/${integration}`), "");
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("dirty, foreign, and missing worktrees refuse before mutation", { timeout: 30_000 }, async () => {
	for (const mode of ["dirty", "foreign", "missing"] as const) {
		const value = await initializedFixture();
		try {
			const planRoot = canonicalWorktreeRoot(value.planDir);
			const planWorktree = path.join(planRoot, "001");
			if (mode === "dirty") fs.writeFileSync(path.join(planWorktree, "dirty.txt"), "dirty\n");
			if (mode === "foreign") {
				const foreign = path.join(value.root, "foreign");
				command(value.repo, ["worktree", "add", "-q", "--detach", foreign, value.base]);
				command(value.repo, ["worktree", "move", planWorktree, foreign]);
			}
			if (mode === "missing") fs.rmSync(planWorktree, { recursive: true, force: true });
			const before = namespaceSnapshot(value);
			await assert.rejects(async () => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir }), /dirty|foreign|moved|missing|cannot remove/i);
			assert.equal(namespaceSnapshot(value), before, mode);
		} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
	}
});

test("locked Herder-owned worktrees reset successfully", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const planRoot = canonicalWorktreeRoot(value.planDir);
		const planWorktree = path.join(planRoot, "001");
		command(value.repo, ["worktree", "lock", "--reason", "test", planWorktree]);
		const result = resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir });
		assert.deepEqual(result.removedWorktrees.map((worktree) => path.basename(worktree)).sort(), ["001", "integration"]);
		assert.equal(git(value.repo, "for-each-ref", `refs/heads/herder/${value.planName}/`), "");
		assert.equal(git(value.repo, "worktree", "list", "--porcelain").includes(planRoot), false);
		assert.equal(fs.existsSync(path.join(planRoot, "001")), false);
		assert.equal(fs.existsSync(path.join(planRoot, "integration")), false);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("reset drops a recovery rationale stored on TODO and still restores the index", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const store = new RunStore(value.planDir);
		try {
			const run = store.getRun()!;
			const specs = store.getPlanSpecs(run.runId, run.currentGeneration);
			store.putPlanSpecs(specs.map((spec) => spec.planId === "001"
				? { ...spec, initialStatusDetail: "Revised only the target plan. Shape and validation both pass." }
				: spec));
		} finally { store.close(); }
		projectStatuses(value.planDir, [{ id: "001", status: "DONE" }]);
		const result = resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir });
		assert.deepEqual(result.resetPlans, ["001"]);
		assert.equal(git(value.repo, "for-each-ref", `refs/heads/herder/${value.planName}/`), "");
		assert.match(fs.readFileSync(value.readme, "utf8"), /\| TODO \|/);
		assert.doesNotMatch(fs.readFileSync(value.readme, "utf8"), /Revised only the target plan/);
		const empty = new RunStore(value.planDir);
		try { assert.equal(empty.getRun(), null); } finally { empty.close(); }
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("reset completes after a previous attempt already removed the Git namespace", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const store = new RunStore(value.planDir);
		try {
			const run = store.getRun()!;
			const specs = store.getPlanSpecs(run.runId, run.currentGeneration);
			store.putPlanSpecs(specs.map((spec) => spec.planId === "001"
				? { ...spec, initialStatusDetail: "Revised only the target plan. The compiled identity is unchanged." }
				: spec));
		} finally { store.close(); }
		const planRoot = canonicalWorktreeRoot(value.planDir);
		for (const name of ["integration", "001"]) {
			command(value.repo, ["worktree", "unlock", path.join(planRoot, name)], true);
			command(value.repo, ["worktree", "remove", "--", path.join(planRoot, name)]);
		}
		for (const ref of [
			...git(value.repo, "for-each-ref", "--format=%(refname)", `refs/heads/herder/${value.planName}/`).split(/\r?\n/),
			...git(value.repo, "for-each-ref", "--format=%(refname)", `refs/plan-herder/${value.planName}/`).split(/\r?\n/),
		].filter(Boolean)) command(value.repo, ["update-ref", "-d", ref]);
		assert.equal(git(value.repo, "for-each-ref", `refs/heads/herder/${value.planName}/`), "");
		assert.equal(git(value.repo, "for-each-ref", `refs/plan-herder/${value.planName}/`), "");
		const leftover = new RunStore(value.planDir);
		try { assert.ok(leftover.getRun()); } finally { leftover.close(); }
		const result = resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir });
		assert.deepEqual(result.removedBranches, []);
		assert.deepEqual(result.removedWorktrees, []);
		assert.deepEqual(result.removedRefs, []);
		assert.deepEqual(result.resetPlans, ["001"]);
		assert.match(fs.readFileSync(value.readme, "utf8"), /\| TODO \|/);
		assert.doesNotMatch(fs.readFileSync(value.readme, "utf8"), /Revised only the target plan/);
		const empty = new RunStore(value.planDir);
		try { assert.equal(empty.getRun(), null); } finally { empty.close(); }
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("reset accepts the legacy sibling worktree location", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const canonical = canonicalWorktreeRoot(value.planDir);
		const leftover = legacyWorktreeRoot(value.repo, value.planName);
		fs.mkdirSync(leftover, { recursive: true });
		for (const name of ["integration", "001"]) {
			command(value.repo, ["worktree", "unlock", path.join(canonical, name)], true);
			command(value.repo, ["worktree", "move", path.join(canonical, name), path.join(leftover, name)]);
		}
		const result = resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir });
		assert.deepEqual(result.removedWorktrees.map((worktree) => path.basename(worktree)).sort(), ["001", "integration"]);
		assert.equal(git(value.repo, "for-each-ref", `refs/heads/herder/${value.planName}/`), "");
		assert.equal(fs.existsSync(path.join(leftover, "integration")), false);
		assert.equal(fs.existsSync(path.join(leftover, "001")), false);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("applyHerderReset stops an active service before resetting", async () => {
	const value = await initializedFixture();
	try {
		await ensureService(value.planDir);
		const result = await applyHerderReset({ repoRoot: value.repo, planDirectory: value.planDir });
		assert.equal(result.planName, "herder-plans");
		assert.equal((await requestService(await ensureService(value.planDir), "/v1/status", undefined)).reply !== undefined, true);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});
