import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { applyHerderReset } from "../../src/application/tools.ts";
import { buildGraph, initPlanDir, projectStatuses } from "../../src/core/plans.ts";
import { ensureService, requestManagerOperation,
	requestService, stopService } from "../../src/client/index.ts";
import { resetHerderPlanSet } from "../../src/daemon/git/reset-plan-set.ts";
import { compileGraphIdentity } from "../../src/core/plan-identity.ts";
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
- **Planned at**: commit \`abc1234\`, 2026-08-11
- **Kind**: behavioral
- **Parent objective**: Exercise reset.

## Outcome and acceptance

The reset fixture is deterministic.

| ID | Required behavior | Proof |
|---|---|---|
| A1 | reset removes the execution namespace. | V1 |

## Boundaries

**Write paths**
- \`fixture.txt\`

**Out of scope**:
- Herder execution state.

- **Modified symbols**: none.
- **Direct contracts**: reset safety.
- **Expected unchanged behavior**: plan files remain intact.
- **Expected diff**: none.

## Starting conditions

**Observed baseline**

The fixture is ready.

**Required starting state**

The stated fixture assumptions and direct interfaces still hold. Run the T1 probe before edits; report unavailable prerequisites without treating them as code defects.

**Expected dependency changes**

Dependencies: none.

## Implementation route

### Step 1: Exercise reset

Keep the fixture bounded.

Suggested route above implements A1; V1 is its acceptance proof. Binding decisions: retain the declared boundaries and direct interfaces.

## Verification

| ID | Phase | Criteria | Toolchain | Command | Expected |
|---|---|---|---|---|---|
| V1 | acceptance | A1 | T1 | \`npm run test:herder -- extensions/herder/tests/integration/reset.test.ts\` | exit 0; named fixture assertions preserve the documented lifecycle and safety behavior |

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
|---|---|---|---|---|---|
| T1 | npm project scripts | . | Node >=22.19; repository locked dependencies installed | \`node --version\` | \`package.json\`; \`package-lock.json\` |

- Run the focused fixture test.

## Escalation and handoff

- **Provides**: reset coverage.
- **Safe intermediate state**: only the declared fixture path changes.

Stop if user files or plan files would be removed.

Environment or invocation failure: report the exact manager, command, cwd, error, and missing prerequisite; do not guess a substitute. Missing product authority requires a decision.

Deferred work: Keep this fixture deterministic.
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
	const store = new RunStore(value.planDir, { readOnly: true });
	let evidence;
	try {
		const run = store.getRun();
		evidence = { run, actions: run && store.getActions(run.runId), specs: run && store.getPlanSpecs(run.runId) };
	} finally { store.close(); }
	return JSON.stringify({
		evidence,
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
test("interrupted ancestry probes reject whole-set reset before mutation", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const before = namespaceSnapshot(value);
		const originalPath = process.env.PATH ?? "";
		const realPath = originalPath.replaceAll("'", "'\\\"'\\\"'");
		assert.throws(() => withTemporaryExecutableOnPath({
			prefix: "herder-reset-sigterm-",
			script: `#!/bin/sh
real_git() { PATH='${realPath}'; export PATH; command git "$@"; }
case "$*" in
	*"merge-base --is-ancestor"*) kill -TERM $$ ;;
esac
real_git "$@"
`,
		}, () => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir })), /Cannot compare/);
		assert.equal(namespaceSnapshot(value), before);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});
test("reset removes the real Herder namespace, restores immutable statuses, preserves setup, and permits two complete reset/fire cycles", { timeout: 60_000 }, async () => {
	const value = await initializedFixture();
	try {
		const beforePlan = fs.readFileSync(value.planFile, "utf8");
		const beforeIgnore = value.ignore;
		for (let cycle = 0; cycle < 2; cycle++) {
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
		}
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

test("foreign and missing worktrees refuse before mutation", { timeout: 30_000 }, async () => {
	for (const mode of ["foreign", "missing"] as const) {
		const value = await initializedFixture();
		try {
			const planRoot = canonicalWorktreeRoot(value.planDir);
			const planWorktree = path.join(planRoot, "001");
			if (mode === "foreign") {
				const foreign = path.join(value.root, "foreign");
				command(value.repo, ["worktree", "add", "-q", "--detach", foreign, value.base]);
				command(value.repo, ["worktree", "move", planWorktree, foreign]);
			}
			if (mode === "missing") fs.rmSync(planWorktree, { recursive: true, force: true });
			const before = namespaceSnapshot(value);
			await assert.rejects(async () => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir }), /foreign|moved|missing|cannot remove/i);
			assert.equal(namespaceSnapshot(value), before, mode);
		} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
	}
});

for (const location of ["canonical", "legacy"] as const) {
	for (const relative of ["001", "integration"]) {
		for (const attachment of ["detached", "foreign"] as const) {
			for (const empty of [false, true]) {
				test(`reset refuses ${attachment} ${location}/${relative} with ${empty ? "empty" : "intact"} namespace`, { timeout: 30_000 }, async () => {
					const value = await initializedFixture();
					try {
						const canonical = canonicalWorktreeRoot(value.planDir);
						const root = location === "canonical" ? canonical : legacyWorktreeRoot(value.repo, value.planName);
						const worktree = path.join(root, relative);
						if (location === "legacy") {
							fs.mkdirSync(root, { recursive: true });
							// Keep the correctly owned canonical checkout too: both locations need independent validation.
							command(value.repo, ["worktree", "add", "-q", "--detach", worktree, value.base]);
						} else command(worktree, ["checkout", "--detach"]);
						if (attachment === "foreign") command(worktree, ["checkout", "-b", "foreign"]);
						fs.writeFileSync(path.join(worktree, "fixture.txt"), "staged\n");
						command(worktree, ["add", "fixture.txt"]);
						fs.appendFileSync(path.join(worktree, "fixture.txt"), "unstaged\n");
						fs.writeFileSync(path.join(worktree, "untracked.txt"), "keep\n");
						if (empty) {
							for (const name of ["001", "integration"]) {
								const owned = path.join(canonical, name);
								if (owned !== worktree) command(value.repo, ["worktree", "remove", "--force", owned]);
							}
							for (const prefix of [`refs/heads/herder/${value.planName}/`, `refs/plan-herder/${value.planName}/`]) {
								for (const ref of git(value.repo, "for-each-ref", "--format=%(refname)", prefix).split(/\r?\n/).filter(Boolean)) command(value.repo, ["update-ref", "-d", ref]);
							}
						}
						projectStatuses(value.planDir, [{ id: "001", status: "BLOCKED", detail: "preserve evidence" }]);
						const before = namespaceSnapshot(value);
						const refs = git(value.repo, "show-ref");
						const index = git(worktree, "diff", "--cached");
						assert.throws(() => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir }), /refused worktree attachment/);
						assert.equal(namespaceSnapshot(value), before);
						assert.equal(git(value.repo, "show-ref"), refs);
						assert.equal(git(worktree, "diff", "--cached"), index);
						assert.equal(fs.readFileSync(path.join(worktree, "fixture.txt"), "utf8"), "staged\nunstaged\n");
						assert.equal(fs.readFileSync(path.join(worktree, "untracked.txt"), "utf8"), "keep\n");
					} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
				});
			}
		}
	}
}

test("reset checks filesystem-equivalent case variants without folding unrelated paths", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const root = canonicalWorktreeRoot(value.planDir);
		for (const relative of ["001", "integration"]) command(value.repo, ["worktree", "remove", "--force", path.join(root, relative)]);
		for (const prefix of [`refs/heads/herder/${value.planName}/`, `refs/plan-herder/${value.planName}/`]) {
			for (const ref of git(value.repo, "for-each-ref", "--format=%(refname)", prefix).split(/\r?\n/).filter(Boolean)) command(value.repo, ["update-ref", "-d", ref]);
		}
		const alternate = path.join(root, "Integration");
		command(value.repo, ["worktree", "add", "-q", "--detach", alternate, value.base]);
		fs.writeFileSync(path.join(alternate, "keep.txt"), "keep\n");
		const expected = path.join(root, "integration");
		if (fs.existsSync(expected)) {
			const a = fs.statSync(alternate, { bigint: true }), b = fs.statSync(expected, { bigint: true });
			assert.equal(a.dev, b.dev);
			assert.equal(a.ino, b.ino);
			const before = namespaceSnapshot(value);
			assert.throws(() => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir }), /refused worktree attachment/);
			assert.equal(namespaceSnapshot(value), before);
		} else {
			// On case-sensitive storage this is an unrelated worktree, not an expected path.
			assert.deepEqual(resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir }).removedWorktrees, []);
		}
		assert.ok(git(value.repo, "worktree", "list", "--porcelain").includes(alternate));
		assert.equal(fs.readFileSync(path.join(alternate, "keep.txt"), "utf8"), "keep\n");
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("reset refuses conflicting expected-path aliases without losing either identity", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const canonical = canonicalWorktreeRoot(value.planDir);
		const legacy = legacyWorktreeRoot(value.repo, value.planName);
		fs.mkdirSync(legacy, { recursive: true });
		const integration = path.join(legacy, "integration"), plan = path.join(canonical, "integration");
		command(value.repo, ["worktree", "move", plan, integration]);
		command(value.repo, ["worktree", "move", path.join(canonical, "001"), plan]);
		fs.symlinkSync(plan, path.join(canonical, "001"), "dir");
		for (const worktree of [integration, plan]) {
			fs.writeFileSync(path.join(worktree, "fixture.txt"), "dirty\n");
			command(worktree, ["add", "fixture.txt"]);
			fs.appendFileSync(path.join(worktree, "fixture.txt"), "unstaged\n");
			fs.writeFileSync(path.join(worktree, "keep.txt"), "keep\n");
		}
		const before = namespaceSnapshot(value);
		const indexes = [integration, plan].map((worktree) => git(worktree, "diff", "--cached"));
		assert.throws(() => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir }), /refused worktree attachment/);
		assert.equal(namespaceSnapshot(value), before);
		assert.deepEqual([integration, plan].map((worktree) => git(worktree, "diff", "--cached")), indexes);
		for (const worktree of [integration, plan]) {
			assert.equal(fs.readFileSync(path.join(worktree, "fixture.txt"), "utf8"), "dirty\nunstaged\n");
			assert.equal(fs.readFileSync(path.join(worktree, "keep.txt"), "utf8"), "keep\n");
		}
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("empty namespace revalidates a detached worktree registered after preflight", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const root = canonicalWorktreeRoot(value.planDir);
		for (const relative of ["001", "integration"]) command(value.repo, ["worktree", "remove", "--force", path.join(root, relative)]);
		for (const prefix of [`refs/heads/herder/${value.planName}/`, `refs/plan-herder/${value.planName}/`]) {
			for (const ref of git(value.repo, "for-each-ref", "--format=%(refname)", prefix).split(/\r?\n/).filter(Boolean)) command(value.repo, ["update-ref", "-d", ref]);
		}
		const worktree = path.join(root, "001");
		// Record the exact expected post-injection state, then recreate it after the first inventory read.
		command(value.repo, ["worktree", "add", "-q", "--detach", worktree, value.base]);
		const before = namespaceSnapshot(value);
		command(value.repo, ["worktree", "remove", worktree]);
		const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
		const marker = path.join(value.root, "injected");
		assert.throws(() => withTemporaryExecutableOnPath({
			prefix: "herder-reset-inventory-race-",
			script: `#!/bin/sh
real_git() { ( PATH=${quote(process.env.PATH ?? "")}; export PATH; command git "$@"; ); }
case "$*" in
	*"worktree list --porcelain -z"|*"worktree list --porcelain")
		real_git "$@" || exit $?
		if [ ! -e ${quote(marker)} ]; then
			real_git -C ${quote(value.repo)} worktree add -q --detach ${quote(worktree)} ${quote(value.base)} || exit $?
			printf 'injected' > ${quote(marker)}
		fi
		exit 0 ;;
esac
real_git "$@"
`,
		}, () => resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir })), /namespace changed after preflight|refused worktree attachment/);
		assert.equal(fs.readFileSync(marker, "utf8"), "injected");
		assert.equal(namespaceSnapshot(value), before);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("dirty and locked Herder-owned worktrees reset successfully without changing the user checkout", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const planRoot = canonicalWorktreeRoot(value.planDir);
		const planWorktree = path.join(planRoot, "001");
		for (const name of ["001", "integration"]) {
			const worktree = path.join(planRoot, name);
			fs.writeFileSync(path.join(worktree, "fixture.txt"), "staged\n");
			command(worktree, ["add", "fixture.txt"]);
			fs.appendFileSync(path.join(worktree, "fixture.txt"), "unstaged\n");
			fs.writeFileSync(path.join(worktree, "untracked.txt"), "untracked\n");
		}
		fs.writeFileSync(path.join(value.repo, "fixture.txt"), "user changes\n");
		fs.writeFileSync(path.join(value.repo, "untracked.txt"), "user file\n");
		command(value.repo, ["worktree", "lock", "--reason", "test", planWorktree]);
		const unrelated = path.join(value.root, "unrelated");
		command(value.repo, ["worktree", "add", "-q", "--detach", unrelated, value.base]);
		fs.writeFileSync(path.join(unrelated, "keep.txt"), "unrelated\n");
		const result = resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.planDir });
		assert.deepEqual(result.removedWorktrees.map((worktree) => path.basename(worktree)).sort(), ["001", "integration"]);
		assert.equal(git(value.repo, "for-each-ref", `refs/heads/herder/${value.planName}/`), "");
		assert.equal(git(value.repo, "worktree", "list", "--porcelain").includes(planRoot), false);
		assert.equal(fs.existsSync(path.join(planRoot, "001")), false);
		assert.equal(fs.existsSync(path.join(planRoot, "integration")), false);
		assert.equal(fs.readFileSync(path.join(value.repo, "fixture.txt"), "utf8"), "user changes\n");
		assert.equal(fs.readFileSync(path.join(value.repo, "untracked.txt"), "utf8"), "user file\n");
		assert.equal(fs.readFileSync(path.join(unrelated, "keep.txt"), "utf8"), "unrelated\n");
		assert.ok(git(value.repo, "worktree", "list", "--porcelain").includes(unrelated));
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

function resetInput(value: Fixture) { return { repoRoot: value.repo, planDirectory: value.planDir }; }
function resetIntent(value: Fixture) {
	return JSON.parse(fs.readFileSync(path.join(value.planDir, ".herder", "reset-intent.json"), "utf8"));
}
function interruptDeletion(value: Fixture, operation: "worktree" | "branch" | "ref" | "unlock" = "worktree"): void {
	const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
	const pattern = operation === "worktree" ? "worktree remove --force" : operation === "unlock" ? "worktree unlock" :
		`update-ref --no-deref -d refs/${operation === "branch" ? "heads/herder" : "plan-herder"}/${value.planName}/`;
	assert.throws(() => withTemporaryExecutableOnPath({
		prefix: "herder-reset-interrupt-",
		script: `#!/bin/sh
real_git() { ( PATH=${quote(process.env.PATH ?? "")}; export PATH; command git "$@"; ); }
case "$*" in
	*${quote(pattern)}*) real_git "$@" || exit $?; echo 'injected deletion boundary' >&2; exit 73 ;;
esac
real_git "$@"
`,
	}, () => resetHerderPlanSet(resetInput(value))), operation === "branch" || operation === "ref" ? /could not delete moved ref/ : /injected deletion boundary/);
}

for (const operation of ["worktree", "branch", "ref", "unlock"] as const) {
	test(`durable reset resumes interrupted ${operation} deletion and replays its original result`, { timeout: 30_000 }, async () => {
		const value = await initializedFixture();
		try {
			if (operation === "unlock") command(value.repo, ["worktree", "lock", "--reason", "test", path.join(canonicalWorktreeRoot(value.planDir), "001")]);
			const plan = fs.readFileSync(value.planFile, "utf8");
			interruptDeletion(value, operation);
			const intent = resetIntent(value);
			assert.equal(intent.pending, true);
			assert.equal(fs.statSync(path.join(value.planDir, ".herder", "reset-intent.json")).mode & 0o777, 0o600);
			assert.deepEqual(resetHerderPlanSet(resetInput(value)), intent.manifest.result);
			assert.equal(resetIntent(value).completed, true);
			assert.deepEqual(resetHerderPlanSet(resetInput(value)), intent.manifest.result);
			assert.equal(fs.readFileSync(value.planFile, "utf8"), plan);
			assert.equal(git(value.repo, "for-each-ref", `refs/heads/herder/${value.planName}/`), "");
			assert.equal(git(value.repo, "for-each-ref", `refs/plan-herder/${value.planName}/`), "");
		} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
	});
}

test("interrupted reset survives service restart presentation updates but rejects changed execution identity", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const store = new RunStore(value.planDir);
		try { store.updateRun({ dashboardUrl: "http://127.0.0.1:1/" }); } finally { store.close(); }
		command(value.repo, ["worktree", "lock", "--reason", "test", path.join(canonicalWorktreeRoot(value.planDir), "001")]);
		interruptDeletion(value, "unlock");
		const intent = resetIntent(value);
		await ensureService(value.planDir);
		await stopService(value.planDir);
		const restarted = new RunStore(value.planDir);
		try {
			const run = restarted.getRun()!;
			assert.equal(run.runId, intent.manifest.run.runId);
			assert.notEqual(run.dashboardUrl, intent.manifest.run.dashboardUrl);
			assert.notEqual(run.updatedAt, intent.manifest.run.updatedAt);
			restarted.updateRun({ status: "paused", terminalDetail: "Service restarted during reset." });
			for (const change of [{ graphSha256: "0".repeat(64) }, { currentGeneration: run.currentGeneration + 1 }]) {
				restarted.updateRun(change);
				const before = namespaceSnapshot(value);
				assert.throws(() => resetHerderPlanSet(resetInput(value)), /run identity changed/);
				assert.equal(namespaceSnapshot(value), before);
				restarted.updateRun({ graphSha256: run.graphSha256, currentGeneration: run.currentGeneration });
			}
		} finally { restarted.close(); }
		assert.deepEqual(resetHerderPlanSet(resetInput(value)), intent.manifest.result);
		assert.equal(resetIntent(value).completed, true);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

for (const boundary of ["before", "after"] as const) {
	test(`durable reset resumes ${boundary} the execution DB clear`, { timeout: 30_000 }, async (t) => {
		const value = await initializedFixture();
		try {
			projectStatuses(value.planDir, [{ id: "001", status: "BLOCKED", detail: "execution failure" }]);
			const original = RunStore.prototype.resetExecutionState;
			const mocked = t.mock.method(RunStore.prototype, "resetExecutionState", function (this: RunStore) {
				if (boundary === "after") original.call(this);
				throw new Error("injected DB boundary");
			});
			assert.throws(() => resetHerderPlanSet(resetInput(value)), /injected DB boundary/);
			mocked.mock.restore();
			const intent = resetIntent(value);
			assert.equal(intent.databasePending, true);
			assert.equal(intent.completed, false);
			const store = new RunStore(value.planDir, { readOnly: true });
			try { assert.equal(!!store.getRun(), boundary === "before"); } finally { store.close(); }
			assert.match(fs.readFileSync(value.readme, "utf8"), /\| TODO \|/);
			assert.deepEqual(resetHerderPlanSet(resetInput(value)), intent.manifest.result);
			assert.deepEqual(resetHerderPlanSet(resetInput(value)), intent.manifest.result);
		} finally { t.mock.restoreAll(); await stopService(value.planDir).catch(() => {}); remove(value); }
	});
}

function revisionInput(value: Fixture) {
	const store = new RunStore(value.planDir, { readOnly: true });
	try {
		const run = store.getRun()!;
		return { ...resetInput(value), revision: { runId: run.runId, baseCommit: run.baseCommit, graphSha256: compileGraphIdentity(buildGraph(value.planDir)) } };
	} finally { store.close(); }
}

test("revision uses stored ownership after IDs/topology change, discards integrated work and resets every revised status to TODO", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const root = canonicalWorktreeRoot(value.planDir);
		const planWorktree = path.join(root, "001"), integration = path.join(root, "integration");
		fs.writeFileSync(path.join(planWorktree, "fixture.txt"), "old implementation\n");
		command(planWorktree, ["commit", "-qam", "test: old implementation"]);
		command(integration, ["merge", "--ff-only", `herder/${value.planName}/001`]);
		command(value.repo, ["update-ref", `refs/plan-herder/${value.planName}/completed/001`, git(integration, "rev-parse", "HEAD")]);
		const store = new RunStore(value.planDir);
		try {
			const run = store.getRun()!;
			store.putPlanSpecs(store.getPlanSpecs(run.runId).map((spec) => ({ ...spec, initialStatus: "DONE" })));
			store.updateRun({ status: "complete" });
		} finally { store.close(); }
		// Author removes 001, adds a dependency chain with mixed initial statuses.
		fs.renameSync(value.planFile, path.join(value.planDir, "old-reset.txt"));
		const rows: string[] = [];
		for (const [id, dependency, status] of [["002", "none", "DONE"], ["003", "002", "BLOCKED — revise"], ["004", "003", "REJECTED — revise"]]) {
			fs.writeFileSync(path.join(value.planDir, `${id}-reset.md`), planBody(id, "Revised reset").replace("**Depends on**: none", `**Depends on**: ${dependency}`).replace("Dependencies: none.", dependency === "none" ? "Dependencies: none." : `| Plan | Consumes |\n|---|---|\n| ${dependency} | Reset coverage from the dependency. |`));
			rows.push(`| [${id}](${id}-reset.md) | Revised reset | P1 | S | ${dependency === "none" ? "—" : dependency} | ${status} |`);
		}
		fs.writeFileSync(value.readme, fs.readFileSync(value.readme, "utf8").replace(/^\| \[001\].*$/m, rows.join("\n")));
		assert.equal(buildGraph(value.planDir).shapeReady, true);
		assert.throws(() => resetHerderPlanSet(resetInput(value)), /stored plan graph/);
		const input = revisionInput(value);
		const plans = ["002", "003", "004"].map((id) => fs.readFileSync(path.join(value.planDir, `${id}-reset.md`), "utf8"));
		const result = resetHerderPlanSet(input);
		assert.deepEqual(result.resetPlans, ["002", "003", "004"]);
		assert.ok(result.removedBranches.includes(`herder/${value.planName}/001`));
		assert.ok(result.removedRefs.includes(`refs/plan-herder/${value.planName}/completed/001`));
		assert.deepEqual(buildGraph(value.planDir).plans.map((p) => p.status), ["TODO", "TODO", "TODO"]);
		assert.deepEqual(["002", "003", "004"].map((id) => fs.readFileSync(path.join(value.planDir, `${id}-reset.md`), "utf8")), plans);
		assert.equal(fs.readFileSync(path.join(value.repo, "fixture.txt"), "utf8"), "base\n");
		assert.equal(git(value.repo, "rev-parse", "HEAD"), input.revision.baseCommit);
		assert.deepEqual(resetHerderPlanSet(input), result);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("revision authorization rejects wrong run/hash/base, changed HEAD and invalid shape before mutation", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const input = revisionInput(value);
		for (const revision of [
			{ ...input.revision, runId: "foreign-run" },
			{ ...input.revision, graphSha256: "0".repeat(64) },
			{ ...input.revision, baseCommit: value.base },
		]) {
			const before = namespaceSnapshot(value);
			assert.throws(() => resetHerderPlanSet({ ...input, revision }), /graph hash|recorded runId/);
			assert.equal(namespaceSnapshot(value), before);
		}
		command(value.repo, ["commit", "--allow-empty", "-qm", "test: moved HEAD"]);
		const before = namespaceSnapshot(value);
		assert.throws(() => resetHerderPlanSet(input), /checkout HEAD/);
		assert.equal(namespaceSnapshot(value), before);
		fs.appendFileSync(value.planFile, `\n${"word ".repeat(1300)}\n`);
		const invalid = revisionInput(value);
		assert.equal(buildGraph(value.planDir).shapeReady, false);
		assert.throws(() => resetHerderPlanSet(invalid), /shape-ready/);
		assert.equal(fs.existsSync(path.join(value.planDir, ".herder", "reset-intent.json")), false);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("pending reset rejects changed input/graph, new/moved/unexpectedly missing refs and foreign/symlink attachments", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const revision = revisionInput(value);
		interruptDeletion(value);
		const intent = resetIntent(value);
		const expectUnchanged = (pattern: RegExp) => {
			const before = namespaceSnapshot(value);
			assert.throws(() => resetHerderPlanSet(resetInput(value)), pattern);
			assert.equal(namespaceSnapshot(value), before);
		};
		assert.throws(() => resetHerderPlanSet(revision), /input or graph/);
		const plan = fs.readFileSync(value.planFile, "utf8");
		fs.appendFileSync(value.planFile, "\nA newly authorized requirement.\n");
		expectUnchanged(/input or graph/);
		fs.writeFileSync(value.planFile, plan);
		const foreignRef = `refs/plan-herder/${value.planName}/completed/999`;
		command(value.repo, ["update-ref", foreignRef, value.base]);
		expectUnchanged(/new or foreign (refs|loose ref)/);
		command(value.repo, ["update-ref", "-d", foreignRef]);
		const baseRef = `refs/plan-herder/${value.planName}/base`, base = git(value.repo, "rev-parse", baseRef);
		command(value.repo, ["update-ref", baseRef, value.base]);
		expectUnchanged(/moved ref/);
		command(value.repo, ["update-ref", "-d", baseRef]);
		expectUnchanged(/unexpectedly missing/);
		command(value.repo, ["update-ref", baseRef, base]);
		command(value.repo, ["symbolic-ref", baseRef, "refs/heads/main"]);
		expectUnchanged(/symbolic ref artifact/);
		command(value.repo, ["update-ref", "--no-deref", "-d", baseRef]);
		command(value.repo, ["update-ref", baseRef, base]);
		const danglingRef = path.join(value.repo, ".git", foreignRef);
		fs.mkdirSync(path.dirname(danglingRef), { recursive: true });
		fs.symlinkSync("missing-ref", danglingRef);
		expectUnchanged(/symlink artifact/);
		fs.unlinkSync(danglingRef);
		const deleted = intent.manifest.owned[intent.next].path;
		fs.symlinkSync(value.repo, deleted, "dir");
		expectUnchanged(/symlink artifact/);
		fs.unlinkSync(deleted);
		command(value.repo, ["worktree", "add", "-q", "--detach", deleted, base]);
		expectUnchanged(/foreign worktree attachment/);
		command(value.repo, ["worktree", "remove", "--force", deleted]);
		assert.deepEqual(resetHerderPlanSet(resetInput(value)), intent.manifest.result);
		// Recreated deleted refs are not "already missing" on a completed replay.
		command(value.repo, ["update-ref", baseRef, base]);
		expectUnchanged(/new or unexpectedly missing artifact/);
		command(value.repo, ["update-ref", "-d", baseRef]);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

for (const completed of [false, true]) test(`${completed ? "completed" : "DB-cleared pending"} reset refuses stale revision authority over a successor run`, { timeout: 30_000 }, async (t) => {
	const value = await initializedFixture();
	try {
		const input = revisionInput(value);
		if (completed) resetHerderPlanSet(input);
		else {
			const original = RunStore.prototype.resetExecutionState;
			const mocked = t.mock.method(RunStore.prototype, "resetExecutionState", function (this: RunStore) {
				original.call(this);
				throw new Error("injected after DB clear");
			});
			assert.throws(() => resetHerderPlanSet(input), /injected after DB clear/);
			mocked.mock.restore();
		}
		const fresh = await ensureService(value.planDir);
		await requestManagerOperation(fresh, "start", { mode: "fire", repositoryRoot: value.repo, planDirectory: value.planDir, profile: "eclipse", maxParallel: 1 });
		await stopService(value.planDir);
		const before = namespaceSnapshot(value);
		assert.throws(() => resetHerderPlanSet(input), /successor run/);
		assert.equal(namespaceSnapshot(value), before);
		const receipt = fs.readFileSync(path.join(value.planDir, ".herder", "reset-intent.json"), "utf8");
		const freshInput = revisionInput(value);
		if (completed) {
			assert.notEqual(freshInput.revision.runId, input.revision.runId);
			assert.throws(() => resetHerderPlanSet({ ...freshInput, revision: { ...freshInput.revision, baseCommit: value.base } }), /recorded runId/);
			assert.equal(namespaceSnapshot(value), before);
			assert.equal(fs.readFileSync(path.join(value.planDir, ".herder", "reset-intent.json"), "utf8"), receipt);
			assert.deepEqual(resetHerderPlanSet(freshInput).resetPlans, ["001"]);
			assert.equal(resetIntent(value).manifest.run.runId, freshInput.revision.runId);
			assert.equal(resetIntent(value).completed, true);
			assert.throws(() => resetHerderPlanSet(input), /input or graph/);
		} else {
			assert.throws(() => resetHerderPlanSet(freshInput), /input or graph/);
			assert.equal(namespaceSnapshot(value), before);
		}
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("reset intent refuses symlinks and public files without following them", { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const file = path.join(value.planDir, ".herder", "reset-intent.json");
		fs.symlinkSync(value.planFile, file);
		let before = namespaceSnapshot(value);
		assert.throws(() => resetHerderPlanSet(resetInput(value)), /symlink artifact/);
		assert.equal(namespaceSnapshot(value), before);
		fs.unlinkSync(file);
		interruptDeletion(value);
		fs.chmodSync(file, 0o644);
		before = namespaceSnapshot(value);
		assert.throws(() => resetHerderPlanSet(resetInput(value)), /private, owned regular file/);
		assert.equal(namespaceSnapshot(value), before);
		fs.chmodSync(file, 0o600);
		resetHerderPlanSet(resetInput(value));
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

for (const partial of ["directory", "attachment"] as const) test(`pending worktree removal accepts only its own missing ${partial} with the original registration`, { timeout: 30_000 }, async () => {
	const value = await initializedFixture();
	try {
		const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
		assert.throws(() => withTemporaryExecutableOnPath({
			prefix: "herder-reset-partial-worktree-",
			script: `#!/bin/sh
real_git() { ( PATH=${quote(process.env.PATH ?? "")}; export PATH; command git "$@"; ); }
case "$*" in
	*"worktree remove --force"*)
		for worktree do :; done
		${partial === "directory" ? 'rm -rf -- "$worktree"' : 'rm -- "$worktree/.git"'}
		echo 'injected partial worktree removal' >&2
		exit 73 ;;
esac
real_git "$@"
`,
		}, () => resetHerderPlanSet(resetInput(value))), /injected partial worktree removal/);
		const intent = resetIntent(value);
		const pending = intent.manifest.owned[intent.next];
		assert.equal(fs.existsSync(pending.path), partial === "attachment");
		assert.equal(fs.existsSync(path.join(pending.path, ".git")), false);
		assert.ok(git(value.repo, "worktree", "list", "--porcelain").includes(pending.path));
		if (partial === "attachment") {
			const stat = fs.statSync(pending.path, { bigint: true });
			assert.equal(`inode:${stat.dev}:${stat.ino}`, pending.identity);
			// A replacement directory without .git must not inherit the pending deletion.
			const original = `${pending.path}-original`;
			fs.renameSync(pending.path, original);
			fs.mkdirSync(pending.path);
			fs.writeFileSync(path.join(pending.path, "keep.txt"), "foreign\n");
			const before = namespaceSnapshot(value);
			assert.throws(() => resetHerderPlanSet(resetInput(value)), /foreign worktree attachment/);
			assert.equal(namespaceSnapshot(value), before);
			assert.equal(fs.readFileSync(path.join(pending.path, "keep.txt"), "utf8"), "foreign\n");
			fs.rmSync(pending.path, { recursive: true });
			fs.renameSync(original, pending.path);
		}
		assert.deepEqual(resetHerderPlanSet(resetInput(value)), intent.manifest.result);
		assert.equal(fs.existsSync(pending.path), false);
		assert.equal(git(value.repo, "worktree", "list", "--porcelain").includes(pending.path), false);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});

test("reset preserves filesystem-equivalent owned path spelling across replay", { timeout: 30_000 }, async (t) => {
	const value = await initializedFixture();
	try {
		const root = canonicalWorktreeRoot(value.planDir);
		const canonical = path.join(root, "integration"), alternate = path.join(root, "Integration");
		if (!fs.existsSync(alternate)) { t.skip("Requires case-insensitive storage"); return; }
		command(value.repo, ["worktree", "move", canonical, path.join(root, "moving")]);
		command(value.repo, ["worktree", "move", path.join(root, "moving"), alternate]);
		const registeredPath = fs.realpathSync(alternate);
		interruptDeletion(value, "branch");
		const intent = resetIntent(value);
		assert.ok(intent.manifest.result.removedWorktrees.includes(registeredPath));
		assert.deepEqual(resetHerderPlanSet(resetInput(value)), intent.manifest.result);
	} finally { await stopService(value.planDir).catch(() => {}); remove(value); }
});
