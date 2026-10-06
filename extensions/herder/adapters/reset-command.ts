import { applyHerderReset } from "../src/application/tools.ts";
import type { HerderResetInput, HerderResetResult } from "../src/daemon/git/reset-plan-set.ts";

export interface ResetCommandDependencies {
	apply?: (request: HerderResetInput) => Promise<HerderResetResult | undefined>;
	confirm?: (title: string, message: string) => Promise<boolean>;
}

export function formatResetResult(result: HerderResetResult): string {
	return `Herder reset executed for ${result.planName} · removed ${result.removedBranches.length} branches, ${result.removedWorktrees.length} worktrees, and ${result.removedRefs.length} coordination refs · restored ${result.resetPlans.length} plan statuses.`;
}

export async function runResetCommand(
	context: { repositoryRoot: string; planDirectory: string } & ResetCommandDependencies,
): Promise<string> {
	const request: HerderResetInput = { repoRoot: context.repositoryRoot, planDirectory: context.planDirectory };
	const confirm = context.confirm ?? (async () => false);
	if (!(await confirm("Reset Herder plan set?", "This supersedes and abandons any unfinished revision and removes all owned Herder branches, worktrees, coordination refs, and execution state, including unreviewed commits. All budget allocations, usage accounting, stop reasons, and grants are erased; the next Fire starts with default budgets. Revise/resume preserve accounting. Dirty, untracked, and ignored files in Herder-owned worktrees will be permanently discarded. Plan Markdown and tracking setup are preserved (execution statuses are reset where possible). Your current checkout and its commits are preserved."))) return "Herder reset cancelled; no Git or plan state was changed.";
	const result = await (context.apply ?? ((value) => applyHerderReset(value)))(request);
	return result ? formatResetResult(result) : "Herder reset cancelled; no Git or plan state was changed.";
}
