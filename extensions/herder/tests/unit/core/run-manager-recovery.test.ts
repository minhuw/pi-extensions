import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureService, requestService, stopService } from "../../../src/client/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { git, runCommand } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { sha256, stableJson, type AttentionResolutionInput } from "../../../src/shared/protocol.ts";

type JsonRecord = Record<string, unknown>;
type Fixture = { repo: string; planDirectory: string };
type Service = Awaited<ReturnType<typeof ensureService>>;

function object(value: unknown): JsonRecord {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as JsonRecord;
}

function writePlan(title: string, status: string, dependency = "none"): string {
	return `# Plan 001: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: ${dependency}
- **Category**: tests
- **Planned at**: commit \`fixture\`, 2026-08-11
- **Kind**: behavioral
- **Parent objective**: Exercise asynchronous target-local recovery.

## Why this matters

The fixture proves recovery preserves unrelated execution.

## Current state

- The target is intentionally ${status.toLowerCase()}.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused | \`node --test\` | exits 0 |

## Dependency contract

- **Consumes**: none.
- **Provides**: a bounded recovery fixture.
- **Safe intermediate state**: only the declared fixture path changes.

## Scope

**In scope** (declared write paths):
- \`src/value.mjs\`

**Out of scope**:
- Manager state and plan graph files.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit.

## Steps

### Step 1: Keep the fixture bounded

Use the declared fixture path only.

**Verify**: \`node --test\` → exits 0.

## Test plan

- Keep this plan independent and deterministic.

## Review map

- **Outcome**: the manager can recover this target.
- **Modified symbols**: the fixture value.
- **Direct contracts**: the manager attention protocol.
- **Expected unchanged behavior**: unrelated plans continue.
- **Proof**: the focused test command.
- **Expected diff**: one fixture path.

## Done criteria

- [ ] The target recovery is durable.

## STOP conditions

Stop if recovery would touch an unrelated plan or graph edge.

## Maintenance notes

Keep the target-local recovery evidence exact.
`;
}

function writeUnrelatedPlan(): string {
	return writePlan("Unrelated ready plan", "TODO").replace("# Plan 001:", "# Plan 002:");
}

function fixture(root: string): Fixture {
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Recovery Test"]);
	git(repo, ["config", "user.email", "recovery@example.invalid"]);
	fs.mkdirSync(path.join(repo, "src"));
	fs.writeFileSync(path.join(repo, "src/value.mjs"), "export const value = 1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "test: add recovery fixture"]);
	const planDirectory = path.join(repo, "herder-plans");
	initPlanDir(planDirectory);
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Recovery plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-blocked.md) | Blocked target | P1 | S | — | BLOCKED — needs attention |
| [002](002-ready.md) | Unrelated ready plan | P1 | S | — | TODO |

## Dependency notes

The plans are independent.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDirectory, "001-blocked.md"), writePlan("Blocked target", "blocked"));
	fs.writeFileSync(path.join(planDirectory, "002-ready.md"), writeUnrelatedPlan());
	return { repo, planDirectory };
}

function attentionResolution(attention: JsonRecord, runId: string, action: string, rationale: string): AttentionResolutionInput {
	const recovery = object(attention.recovery);
	return {
		schemaVersion: 1,
		requestId: String(attention.requestId),
		requestSha256: String(attention.requestSha256),
		capabilityToken: String(attention.capabilityToken),
		runId,
		planId: String(attention.planId),
		generation: Number(attention.generation),
		round: Number(attention.round),
		action,
		rationale,
		git: recovery as unknown as AttentionResolutionInput["git"],
	};
}

async function managerReply(service: Service, endpoint: string, input: JsonRecord): Promise<JsonRecord> {
	return object(object(await requestService(service, endpoint, input)).reply);
}

function cleanup(fixtureValue: Fixture): void {
	fs.rmSync(`${fixtureValue.repo}-herder-worktrees`, { recursive: true, force: true });
}

test("target recovery advances a fresh generation while unrelated work remains schedulable", { timeout: 45_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-target-recovery-"));
	const fixtureValue = fixture(root);
	let service: Service | undefined;
	try {
		service = await ensureService(fixtureValue.planDirectory);
		const started = await managerReply(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixtureValue.repo,
			planDirectory: fixtureValue.planDirectory,
			profile: "eclipse",
			maxParallel: 2,
		});
		assert.equal(started.status, "running");
		const attention = object(started.attention);
		assert.equal(attention.planId, "001");
		assert.equal(attention.kind, "plan_recovery");
		const actions = (started.actions as unknown[]).map(object);
		assert.deepEqual(actions.map((action) => action.planId), ["002"]);

		const resolution = attentionResolution(attention, String(started.runId), "unchanged_retry", "The compiled target remains valid and can retry unchanged.");
		const resolved = await managerReply(service, "/v1/event", {
			eventId: `recovery:${sha256(stableJson(resolution))}`,
			kind: "attention",
			attention: resolution,
		});
		assert.equal(resolved.status, "running");
		const store = new RunStore(fixtureValue.planDirectory);
		try {
			const run = store.getRun();
			assert.ok(run);
			assert.equal(run.currentGeneration, 2);
			assert.equal(store.getAttention(String(attention.requestId))?.state, "resolved");
			const specs = store.getPlanSpecs(run.runId);
			assert.equal(specs.find((spec) => spec.planId === "001")?.initialStatus, "TODO");
			assert.equal(store.getPlan(run.runId, "001")?.generation, 2, "the target runtime is recreated in the new generation");
			assert.ok(store.getAction(run.runId + ":002-g1-r1-implementer-1"));
		} finally {
			store.close();
		}
		assert.ok((resolved.actions as unknown[]).map(object).some((action) => action.planId === "001"), "the recovered target is backfillable");
	} finally {
		if (service) await stopService(fixtureValue.planDirectory).catch(() => {});
		cleanup(fixtureValue);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("exhausted target recovery deletes dirty failed execution state before rescheduling", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-target-recovery-dirty-"));
	const fixtureValue = fixture(root);
	let service: Service | undefined;
	try {
		const readme = path.join(fixtureValue.planDirectory, "README.md");
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("BLOCKED — needs attention", "TODO"));
		service = await ensureService(fixtureValue.planDirectory);
		let reply = await managerReply(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixtureValue.repo,
			planDirectory: fixtureValue.planDirectory,
			profile: "eclipse",
			maxParallel: 2,
		});
		let target = object((reply.actions as unknown[]).map(object).find((action) => action.planId === "001"));
		assert.ok(target);
		let oldWorktree = String(target.worktree);
		for (let round = 1; round <= 6; round += 1) {
			await managerReply(service, "/v1/event", {
				eventId: `dirty-dispatch-${round}`,
				kind: "dispatch_results",
				dispatchResults: [{ actionId: target.actionId, accepted: true, hostHandle: `dirty-${round}` }],
			});
			oldWorktree = String(target.worktree);
			if (round === 6) fs.writeFileSync(path.join(oldWorktree, "discarded-untracked.txt"), "discard me\n");
			reply = await managerReply(service, "/v1/event", {
				eventId: `dirty-terminal-${round}`,
				kind: "terminals",
				terminals: [{ actionId: target.actionId, hostHandle: `dirty-${round}`, response: "STATUS: FAILED\nCOMMITS: none\nCHECKS: none\nFILES CHANGED: none\nDISCOVERED_PATHS: none\nNOTES: bounded failure\nUSAGE: input_tokens=1; output_tokens=1; source=test-host" }],
			});
			if (round < 6) target = object((reply.actions as unknown[]).map(object).find((action) => action.planId === "001"));
		}
		const attention = object(reply.attention);
		assert.equal(attention.cause, "implementer_exhausted");
		const resolved = await managerReply(service, "/v1/event", {
			eventId: "dirty-recovery-apply",
			kind: "attention",
			attention: attentionResolution(attention, String(reply.runId), "unchanged_retry", "The failed target remains valid after the bounded retry budget."),
		});
		assert.equal(resolved.status, "running");
		assert.equal(fs.existsSync(path.join(oldWorktree, "discarded-untracked.txt")), false);
		const store = new RunStore(fixtureValue.planDirectory);
		try {
			const run = store.getRun();
			assert.ok(run);
			assert.equal(run.currentGeneration, 2);
			assert.equal(store.getPlan(run.runId, "001")?.round, 1);
			assert.equal(store.getPlan(run.runId, "001")?.generation, 2);
			assert.equal(store.getActions(run.runId).filter((action) => action.planId === "001").length, 7);
		} finally {
			store.close();
		}
	} finally {
		if (service) await stopService(fixtureValue.planDirectory).catch(() => {});
		cleanup(fixtureValue);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("target-only revisions and permitted rejection produce immutable next generations", { timeout: 45_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-target-recovery-decisions-"));
	const fixtureValue = fixture(root);
	let service: Service | undefined;
	try {
		service = await ensureService(fixtureValue.planDirectory);
		const started = await managerReply(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixtureValue.repo,
			planDirectory: fixtureValue.planDirectory,
			profile: "eclipse",
			maxParallel: 2,
		});
		const attention = object(started.attention);
		fs.writeFileSync(path.join(fixtureValue.planDirectory, "001-blocked.md"), fs.readFileSync(path.join(fixtureValue.planDirectory, "001-blocked.md"), "utf8").replace("# Plan 001: Blocked target", "# Plan 001: Revised target"));
		const revised = await managerReply(service, "/v1/event", {
			eventId: "recovery-revise-target",
			kind: "attention",
			attention: attentionResolution(attention, String(started.runId), "revise", "The target revision keeps the same graph identity and scope."),
		});
		assert.equal(revised.status, "running");
		const store = new RunStore(fixtureValue.planDirectory);
		try {
			const run = store.getRun();
			assert.ok(run);
			assert.equal(run.currentGeneration, 2);
			assert.match(store.getPlanSpecs(run.runId).find((spec) => spec.planId === "001")?.assignment.planText || "", /Revised target/);
			assert.equal(store.getGenerations(run.runId).length, 2);
			assert.equal(store.getAttention(String(attention.requestId))?.state, "resolved");
		} finally {
			store.close();
		}
	} finally {
		if (service) await stopService(fixtureValue.planDirectory).catch(() => {});
		cleanup(fixtureValue);
		fs.rmSync(root, { recursive: true, force: true });
	}

	const rejectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herder-target-recovery-reject-"));
	const rejectedFixture = fixture(rejectedRoot);
	service = undefined;
	try {
		service = await ensureService(rejectedFixture.planDirectory);
		const started = await managerReply(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: rejectedFixture.repo,
			planDirectory: rejectedFixture.planDirectory,
			profile: "eclipse",
			maxParallel: 2,
		});
		const attention = object(started.attention);
		const rejected = await managerReply(service, "/v1/event", {
			eventId: "recovery-reject-target",
			kind: "attention",
			attention: attentionResolution(attention, String(started.runId), "reject", "The target is not justified for this run."),
		});
		assert.equal(rejected.status, "running");
		const store = new RunStore(rejectedFixture.planDirectory);
		try {
			const run = store.getRun();
			assert.ok(run);
			assert.equal(store.getPlanSpecs(run.runId).find((spec) => spec.planId === "001")?.initialStatus, "REJECTED");
			assert.equal(store.getAttention(String(attention.requestId))?.state, "resolved");
			assert.equal(store.getActions(run.runId, ["proposed", "dispatched"]).some((action) => action.planId === "001"), false);
		} finally {
			store.close();
		}
	} finally {
		if (service) await stopService(rejectedFixture.planDirectory).catch(() => {});
		cleanup(rejectedFixture);
		fs.rmSync(rejectedRoot, { recursive: true, force: true });
	}
});

test("recovery resolution rejects a mismatched capability or Git identity before mutation", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-target-recovery-binding-"));
	const fixtureValue = fixture(root);
	let service: Service | undefined;
	try {
		service = await ensureService(fixtureValue.planDirectory);
		const started = await managerReply(service, "/v1/start", {
			mode: "fire",
			repositoryRoot: fixtureValue.repo,
			planDirectory: fixtureValue.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
		});
		const attention = object(started.attention);
		const resolution = attentionResolution(attention, String(started.runId), "unchanged_retry", "The target remains valid.");
		await assert.rejects(
			() => managerReply(service!, "/v1/event", { eventId: "bad-capability", kind: "attention", attention: { ...resolution, capabilityToken: "0".repeat(64) } }),
			/capability token/,
		);
		const store = new RunStore(fixtureValue.planDirectory);
		try {
			assert.equal(store.getAttention(String(attention.requestId))?.state, "pending");
			assert.equal(store.getRun()?.currentGeneration, 1);
		} finally {
			store.close();
		}
	} finally {
		if (service) await stopService(fixtureValue.planDirectory).catch(() => {});
		cleanup(fixtureValue);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
