import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { applyHerderReset } from "../../src/application/tools.ts";
import { initPlanDir, projectStatuses } from "../../src/core/plans.ts";
import { ensureService, requestService, stopService } from "../../src/client/index.ts";
import { resetHerderPlanSet } from "../../src/daemon/git/reset-plan-set.ts";
import { RunStore } from "../../src/daemon/run-store.ts";

function command(cwd: string, args: string[], allowFailure = false): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
	return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function git(cwd: string, ...args: string[]): string { return command(cwd, args).stdout.trim(); }
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
	const response = await requestService(service, "/v1/start", {
		mode: "fire", repositoryRoot: value.repo, planDirectory: value.planDir, profile: "eclipse", maxParallel: 1,
	});
	assert.equal((response.reply as Record<string, unknown>).status, "running");
	await stopService(value.planDir);
	const worktreeRoot = path.join(`${value.repo}-herder-worktrees`, value.planName);
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

test("reset removes the real Herder namespace, restores immutable statuses, preserves setup, and permits a fresh fire", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const beforePlan = fs.readFileSync(value.planFile, "utf8");
		const beforeIgnore = value.ignore;
		projectStatuses(value.planDir, [{ id: "001", status: "BLOCKED", detail: "temporary execution detail" }]);
		const store = new RunStore(value.planDir);
		try { store.updateRun({ status: "complete" }); } finally { store.close(); }
		const planRoot = `${value.repo}-herder-worktrees/${value.planName}`;
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
		const started = await requestService(fresh, "/v1/start", {
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
		const integrationRoot = path.join(`${value.repo}-herder-worktrees`, value.planName, "integration");
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

test("dirty, foreign, missing, and locked worktrees refuse before mutation", { timeout: 30_000 }, async () => {
	for (const mode of ["dirty", "foreign", "missing", "locked"] as const) {
		const value = await initializedFixture();
		try {
			const planRoot = path.join(`${value.repo}-herder-worktrees`, value.planName);
			const planWorktree = path.join(planRoot, "001");
			if (mode === "dirty") fs.writeFileSync(path.join(planWorktree, "dirty.txt"), "dirty\n");
			if (mode === "foreign") {
				const foreign = path.join(value.root, "foreign");
				command(value.repo, ["worktree", "add", "-q", "--detach", foreign, value.base]);
				command(value.repo, ["worktree", "move", planWorktree, foreign]);
			}
			if (mode === "missing") fs.rmSync(planWorktree, { recursive: true, force: true });
			if (mode === "locked") command(value.repo, ["worktree", "lock", "--reason", "test", planWorktree]);
			const before = namespaceSnapshot(value);
			await assert.rejects(async () => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir }), /dirty|foreign|moved|missing|locked|cannot remove/i);
			assert.equal(namespaceSnapshot(value), before, mode);
		} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
	}
});

test("applyHerderReset delegates service exclusion and refuses an active nonterminal service", async () => {
	const value = await initializedFixture();
	try {
		const service = await ensureService(value.planDir);
		await assert.rejects(
			() => applyHerderReset({ repoRoot: value.repo, planDirectory: value.planDir }),
			/active|terminal run/i,
		);
		assert.equal((await requestService(service, "/v1/status", undefined)).reply !== undefined, true);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});
