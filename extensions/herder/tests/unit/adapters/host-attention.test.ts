import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmHostAttention } from "../../../adapters/run-revision.ts";
import { attentionResolutionFromRequest } from "../../../adapters/attention.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { assertHostAttentionGrant } from "../../../src/core/run-revision.ts";
import { attentionCapabilityToken, attentionRequestSha256, sha256, stableJson, type ManagerAttentionRequest } from "../../../src/shared/protocol.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

test("round choices require interactive confirmation and bind the exact acceptance payload", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-host-attention-"));
	const { repo, originalHead } = initFixtureRepo(root, { name: "Host", email: "host@example.invalid", files: { "src/value.mjs": "export const value = 1;\n" } });
	const directory = path.join(repo, "herder-plans");
	initPlanDir(directory);
	fs.writeFileSync(path.join(directory, "README.md"), "# Plans\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|---|---|---|---|---|---|\n| [001](001-value.md) | Value | P1 | S | — | TODO |\n\n## Dependency notes\n\nNone.\n\n## Considered and rejected\n\nNone.\n");
	fs.writeFileSync(path.join(directory, "001-value.md"), fixturePlan({ id: "001", title: "Value", head: originalHead }));
	const manager = new HerderRunManager(directory);
	try {
		await manager.start({ mode: "fire", repositoryRoot: repo, planDirectory: directory, profile: "eclipse", maxParallel: 1 });
		const run = manager.store.getRun()!;
		const detail = "Choose unresolved findings";
		const request: ManagerAttentionRequest = {
			schemaVersion: 1, requestId: "host-choice", requestSha256: "", capabilityToken: attentionCapabilityToken("host-choice"),
			runId: run.runId, planId: "001", generation: 1, round: 1, actionId: null,
			kind: "user_decision", state: "awaiting_input", cause: "judge_needs_input", detail, detailSha256: sha256(detail),
			question: detail, continuation: { role: "plan-judge", phase: "NEEDS_INPUT" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		request.requestSha256 = attentionRequestSha256(request);
		manager.store.putAttention(request);
		const grant = path.join(directory, ".herder", "attention-host-grant.json");
		let calls = 0;
		const ctx = { hasUI: false, ui: { confirm: async () => { calls++; return false; } } } as unknown as Pick<ExtensionContext, "hasUI" | "ui">;
		for (const action of ["retry", "accept", "reject"]) {
			const resolution = { ...attentionResolutionFromRequest(request), action, answer: "Accept F1 unresolved", rationale: "User's exact choice" };
			await assert.rejects(confirmHostAttention(directory, resolution, ctx), /interactive host confirmation/);
			assert.equal(calls, 0);
			await assert.rejects(confirmHostAttention(directory, resolution, { ...ctx, hasUI: true }), /dismissed/);
			assert.equal(fs.existsSync(grant), false);
			calls = 0;
		}
		const resolution = { ...attentionResolutionFromRequest(request), action: "accept", answer: "Accept F1 unresolved", rationale: "User's exact choice" };
		await confirmHostAttention(directory, resolution, { hasUI: true, ui: { confirm: async (title: string, text: string) => {
			assert.match(title, /Accept unresolved findings as-is, not passed checks/);
			assert.ok(text.includes(request.requestSha256));
			assert.ok(text.includes(sha256(stableJson(resolution))));
			assert.ok(text.includes(resolution.answer));
			assert.match(text, /HEAD: [a-f0-9]{40}/);
			assert.match(text, /Tree: [a-f0-9]{40}/);
			return true;
		} } as never });
		assertHostAttentionGrant(run, resolution);
		assert.throws(() => assertHostAttentionGrant(run, { ...resolution, answer: "Different gaps" }), /stale|match/);
		assert.equal(manager.store.getAttention(request.requestId)!.state, "awaiting_input", "confirmation alone does not resolve or run anything");
		const previousGrant = fs.readFileSync(grant, "utf8");
		await assert.rejects(confirmHostAttention(directory, resolution, { hasUI: true, ui: { confirm: async () => {
			fs.writeFileSync(path.join(manager.store.getPlan(run.runId, "001")!.worktree, "src/value.mjs"), "export const value = 99;\n");
			return true;
		} } as never }), /changed during host confirmation/);
		assert.equal(fs.readFileSync(grant, "utf8"), previousGrant, "changed trees cannot replace the exact grant");
	} finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
