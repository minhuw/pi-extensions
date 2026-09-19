import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { grantUserBudget, parseBudgetArguments } from "../../../adapters/budget.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

test("budget command parses exact positive increments and rejects ambiguous or missing amounts", () => {
	assert.deepEqual(parseBudgetArguments('7 "plans with spaces" --plan 2 --rounds 1 --recoveries 2'), {
		amount: 7, planDirectory: "plans with spaces", planId: "002", implementationRounds: 1, infrastructureRecoveries: 2,
	});
	for (const args of ["", "0", "-1", "1.5", "9007199254740992", "3 --rounds 1", "3 --plan bad", "3 --unknown 1"]) assert.throws(() => parseBudgetArguments(args));
});

test("host budget grant requires UI, exact confirmation, freshness and durable audit", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-budget-ui-"));
	const { repo } = initFixtureRepo(root, { name: "Budget", email: "budget@example.invalid", files: { "src/value.mjs": "export const value = 1;\n" } });
	const directory = path.join(repo, "herder-plans");
	initPlanDir(directory);
	const readme = path.join(directory, "README.md");
	fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace(/(\|[-| ]+\|\r?\n)/, "$1| [001](001-value.md) | Value | P1 | S | — | BLOCKED — needs decision |\n"));
	fs.writeFileSync(path.join(directory, "001-value.md"), fixturePlan({ id: "001", title: "Value" }));
	const manager = new HerderRunManager(directory);
	try {
		await manager.start({ mode: "fire", repositoryRoot: repo, planDirectory: directory, profile: "eclipse", maxParallel: 1 });
		const run = manager.store.getRun()!;
		const original = manager.store.getBudget(run.runId)!;
		await assert.rejects(grantUserBudget(directory, { amount: 4 }, { hasUI: false, ui: {} as never }, () => {}), /interactive/);
		await assert.rejects(grantUserBudget(directory, { amount: 4 }, { hasUI: true, ui: { confirm: async () => false } as never }, () => {}), /dismissed/);
		assert.deepEqual(manager.store.getBudget(run.runId), original);
		await grantUserBudget(directory, { amount: 4, planId: "001", implementationRounds: 1 }, { hasUI: true, ui: { confirm: async (_title: string, body: string) => {
			for (const exact of [run.runId, run.graphSha256, "Generation: 1", "Additional executions: 4", "Additional implementation rounds: 1"]) assert.ok(body.includes(exact));
			return true;
		} } as never }, () => {});
		assert.equal(manager.store.getBudget(run.runId)?.limit, original.limit + 4);
		assert.equal(manager.store.getBudget(run.runId)?.used, original.used);
		assert.equal(manager.store.getRun()?.status, run.status);
		assert.equal(Number((manager.store.database.prepare("SELECT COUNT(*) AS n FROM manager_budget_grants").get() as { n: number }).n), 1);
		await assert.rejects(grantUserBudget(directory, { amount: 2 }, { hasUI: true, ui: { confirm: async () => {
			const changed = new RunStore(directory);
			try { changed.updateRun({ terminalDetail: "Changed during confirmation" }); } finally { changed.close(); }
			return true;
		} } as never }, () => {}), /changed during confirmation/);
		assert.equal(manager.store.getBudget(run.runId)?.limit, original.limit + 4);
	} finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
