// Merging a ticket into the main checkout's branch; see DESIGN.md "Merging".
import { existsSync } from "node:fs";
import { FINAL_STATES, type MergeDeps, type MergeOutcome } from "./types.ts";

/** What the worker is sent when its branch no longer rebases cleanly onto the target's tip `sha`. */
export function rebasePrompt(target: string, sha: string): string {
	return (
		`Merge requested: your branch no longer applies on top of \`${target}\` (\`${sha}\`). ` +
		`Rebase onto \`${sha}\`, resolve the conflicts keeping both sides' intent, rerun the relevant checks, commit, and report ready. ` +
		`Do not modify \`${target}\` yourself.`
	);
}

/** What the worker is sent when a merge finds uncommitted changes in its worktree. */
export const DIRTY_WORKTREE_PROMPT =
	"Merge requested, but your worktree has uncommitted changes. Commit what belongs to this ticket on your branch, discard the rest, and report ready again.";

const refused = (reason: string): MergeOutcome => ({ kind: "refused", reason });
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const short = (sha: string) => sha.slice(0, 12);
const message = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error));

export async function mergeTicket(deps: MergeDeps, id: number): Promise<MergeOutcome> {
	const { store, git, repo } = deps;

	// 1. Refusals.
	const ticket = store.get(id);
	if (!ticket) return refused(`Ticket #${id} does not exist.`);
	if (FINAL_STATES.has(ticket.state)) return refused(`Ticket #${id} is already ${ticket.state}; only open tickets can be merged.`);
	if (deps.isRunning(id)) return refused(`Ticket #${id}'s worker is still running; merge it after it reports.`);
	if (!existsSync(ticket.worktree)) return refused(`Ticket #${id}'s worktree ${ticket.worktree} is missing.`);
	if (!(await git.isClean(ticket.worktree))) {
		try {
			await deps.send(id, DIRTY_WORKTREE_PROMPT);
		} catch (error) {
			return refused(`Ticket #${id}'s worktree has uncommitted changes, and its worker could not be asked to commit them: ${message(error)}`);
		}
		return refused(`Ticket #${id}'s worktree has uncommitted changes; its worker was asked to commit or discard them.`);
	}
	if (!(await git.branchExists(repo, ticket.branch))) return refused(`Ticket #${id}'s branch ${ticket.branch} does not exist.`);
	const worktreeBranch = await git.branch(ticket.worktree);
	if (worktreeBranch !== ticket.branch) {
		return refused(`Ticket #${id}'s worktree is on ${worktreeBranch ?? "a detached HEAD"}, not on its branch ${ticket.branch}.`);
	}
	const { ahead } = await git.aheadBehind(repo, ticket.branch, ticket.base);
	if (ahead === 0) return refused(`Ticket #${id} has no commits ahead of its base ${short(ticket.base)}; there is nothing to merge.`);
	const target = await git.branch(repo.topLevel);
	if (!target) return refused("The main checkout is on a detached HEAD; check out the branch to merge into, then merge again.");

	// 2. The target's tip.
	const tip = await git.revParse(repo.topLevel, "HEAD");

	// 3. Rebase when the target moved.
	if (!(await git.isAncestor(repo, tip, ticket.branch))) {
		const result = await git.rebase(ticket.worktree, tip);
		if (!result.ok) {
			store.update(id, { mergeRequested: true }, { type: "merge-handed-to-worker", target, onto: tip, conflicts: result.conflicts });
			await deps.send(id, rebasePrompt(target, tip));
			return {
				kind: "handed-to-worker",
				reason: `Ticket #${id} conflicts with ${target} in ${result.conflicts.join(", ")}; its worker was asked to rebase onto ${short(tip)}, and the merge runs again when it reports ready.`,
			};
		}
		if (result.rebased) store.update(id, {}, { type: "rebased", target, onto: tip });
	}

	// 4. Fast-forward the main checkout.
	const { ahead: commits } = await git.aheadBehind(repo, ticket.branch, tip);
	const forwarded = await git.fastForward(repo.topLevel, ticket.branch);
	if (!forwarded.ok) return refused(`git refused to fast-forward ${target} to ${ticket.branch}: ${oneLine(forwarded.error)}`);

	// 5. Clean up and record.
	await deps.stop(id);
	await git.removeWorktree(repo, ticket.worktree);
	let branchKept: string | undefined;
	try {
		await git.deleteBranch(repo, ticket.branch);
	} catch (error) {
		branchKept = `branch ${ticket.branch} was kept: ${message(error)}`;
	}
	store.update(
		id,
		{ state: "merged", mergedAt: Date.now(), mergedInto: target, mergeRequested: undefined },
		{ type: "merged", into: target, commits, branchDeleted: branchKept === undefined, ...(branchKept ? { note: branchKept } : {}) },
	);
	return { kind: "merged", into: target, commits };
}
