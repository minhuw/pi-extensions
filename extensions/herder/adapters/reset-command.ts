import { applyHerderReset } from "../src/application/tools.ts";
import type { HerderResetInput, HerderResetResult } from "../src/daemon/git/reset-plan-set.ts";

export interface ResetCommandDependencies {
	apply?: (request: HerderResetInput) => Promise<HerderResetResult>;
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
	if (!(await confirm("Reset Herder plan set?", "This removes all Herder branches, worktrees, coordination refs, and execution state. Plan Markdown and tracking setup are preserved."))) return "Herder reset cancelled; no Git or plan state was changed.";
	const result = await (context.apply ?? ((value) => applyHerderReset(value)))(request);
	return formatResetResult(result);
}
