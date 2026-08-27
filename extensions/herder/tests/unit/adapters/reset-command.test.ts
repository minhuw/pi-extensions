import assert from "node:assert/strict";
import test from "node:test";
import { formatResetResult, runResetCommand } from "../../../adapters/reset-command.ts";

test("reset command asks for confirmation before applying and formats the result", async () => {
	const calls: string[] = [];
	const message = await runResetCommand({
		repositoryRoot: "/repo",
		planDirectory: "/repo/custom-plans",
		confirm: async (title, body) => {
			calls.push(`${title}: ${body}`);
			return true;
		},
		apply: async (request) => {
			assert.deepEqual(request, { repoRoot: "/repo", planDirectory: "/repo/custom-plans" });
			return { planName: "custom-plans", removedBranches: ["integration", "001"], removedWorktrees: ["integration", "001"], removedRefs: ["base"], resetPlans: ["001"] };
		},
	});
	assert.equal(calls.length, 1);
	assert.match(calls[0]!, /Plan Markdown and tracking setup are preserved/);
	assert.equal(message, "Herder reset executed for custom-plans · removed 2 branches, 2 worktrees, and 1 coordination refs · restored 1 plan statuses.");
});

test("reset command cancellation never invokes the reset application", async () => {
	let applied = false;
	const message = await runResetCommand({
		repositoryRoot: "/repo",
		planDirectory: "/repo/herder-plans",
		confirm: async () => false,
		apply: async () => {
			applied = true;
			throw new Error("must not apply");
		},
	});
	assert.equal(applied, false);
	assert.equal(message, "Herder reset cancelled; no Git or plan state was changed.");
});

test("reset result formatter reports all destructive artifact classes", () => {
	assert.match(formatResetResult({ planName: "plans", removedBranches: ["a"], removedWorktrees: [], removedRefs: ["b", "c"], resetPlans: ["001", "002"] }), /removed 1 branches, 0 worktrees, and 2 coordination refs · restored 2 plan statuses/);
});
