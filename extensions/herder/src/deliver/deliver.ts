// Delivery to the user's checkout after verification and confirmation (§12).
import { runChecks } from "../checks/runner.ts";
import { LIMITS } from "../config.ts";
import { integrationRef, refPrefix, runPaths, worktreePath } from "../run/paths.ts";
import type { RunStore } from "../run/store.ts";
import type { AgentRunner, CheckResult, CheckSpec, DeliveryCompletedEvent, DeliveryMode, DeliveryStartedEvent, Faults, JournalInput, RoleDefinition, Vcs } from "../types.ts";
import { hasHerderTrailer, RefConflictError, removeWorktrees } from "../vcs/git.ts";
import { acceptCuration } from "./curate.ts";

export interface DeliverDeps {
	runId: string; store: RunStore; vcs: Vcs; runner: AgentRunner; roles: ReadonlyMap<string, RoleDefinition>; checks: readonly CheckSpec[];
	title: string; faults?: Faults; signal?: AbortSignal; onProgress?: () => void;
	/** Interactive approval of the summary; nothing reaches the user's checkout or branches unless it resolves true. */
	confirm(summary: string): Promise<boolean>;
}
export interface DeliveryRequest { mode: DeliveryMode; curate?: boolean }
/**
 * `curation` says why a requested curation was not used; `conflicts` lists the paths a replay stopped on; `warning`
 * reports a failed cleanup after a delivery that happened.
 */
export interface DeliveryOutcome {
	status: "delivered" | "refused" | "cancelled"; reason?: string; mode: DeliveryMode; target?: string; tip?: string; commits?: string[];
	rebasedOnto?: string; curated?: boolean; curation?: string; conflicts?: string[]; checks?: CheckResult[]; warning?: string;
}

const MODES: readonly DeliveryMode[] = ["series", "branch", "squash", "uncommitted"];
export const CURATE_SLOT = "curate";
export const DELIVER_SLOT = "deliver";
export const curatedRef = (runId: string) => `${refPrefix(runId)}/curated`;
export const reviewBranch = (runId: string) => `herder/${runId}`;
const short = (sha: string) => sha.slice(0, 12);
const subject = (message: string) => message.split("\n", 1)[0]!;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Deletes `refs/herder/<runId>/*` and the run's worktrees; the run directory stays. Attempts both, then throws the first error. */
export function cleanupRun(vcs: Vcs, commonDir: string, runId: string): void {
	const errors: unknown[] = [];
	for (const step of [() => vcs.deleteRefs(refPrefix(runId)), () => removeWorktrees(vcs, runPaths(commonDir, runId).worktrees)]) {
		try { step(); } catch (error) { errors.push(error); }
	}
	if (errors.length) throw errors[0];
}

interface Expected { head: string; branch: string | null }

/** Why the checkout cannot take `mode` now; with `expected`, also refuses a checkout that moved since preparation. */
function guard(vcs: Vcs, mode: DeliveryMode, expected?: Expected): string | undefined {
	if (mode === "branch") return undefined;
	const branch = vcs.currentBranch();
	if (mode !== "uncommitted" && branch === null) return "the checkout is on a detached HEAD; check out the branch to deliver to";
	if (!vcs.isClean()) return "the checkout has uncommitted or untracked changes; commit or stash them first";
	if (!expected) return undefined;
	if (mode !== "uncommitted" && branch !== expected.branch) return `the checkout switched from ${expected.branch} to ${branch} after the delivery was prepared; deliver again`;
	const head = vcs.head();
	if (head !== expected.head) return `HEAD moved from ${short(expected.head)} to ${short(head)} after the delivery was prepared; deliver again`;
	return undefined;
}

function curatorPrompt(vcs: Vcs, runId: string, base: string, head: string): string {
	const series = vcs.revList(`${base}..${head}`).map((commit) => {
		const [parent] = vcs.parentsOf(commit);
		return `### ${commit}\n${vcs.message(commit).trimEnd()}\n\n${vcs.diffStat(`${parent}..${commit}`)}`;
	});
	return [
		`Curate the commit series of Herder run ${runId} into a clean, logical series.`,
		`Base: ${base}`,
		`Head (reproduce this tree exactly): ${head}`,
		"Your worktree is checked out on a detached HEAD at the base. Create the new series as ordinary commits on that detached HEAD and leave HEAD at the new tip. `git diff " + head + " HEAD` must print nothing when you finish. No `Herder-*` trailers in any message.",
		`Original series (oldest first):\n\n${series.join("\n\n")}`,
	].join("\n\n");
}

async function curate(deps: DeliverDeps, base: string, head: string, signal: AbortSignal): Promise<{ tip?: string; reason?: string }> {
	const { vcs, runId } = deps;
	const role = deps.roles.get("curator");
	if (!role) return { reason: "no curator role is defined" };
	const path = worktreePath(vcs.commonDir(), runId, CURATE_SLOT);
	vcs.removeWorktree(path);
	try {
		vcs.addWorktree(path, base);
		await deps.runner.run({ role, prompt: curatorPrompt(vcs, runId, base, head), cwd: path, signal, timeoutMs: LIMITS.timeoutMs, stallMs: LIMITS.stallMs });
		const tip = vcs.worktreeHead(path);
		const verdict = acceptCuration(vcs, base, head, tip);
		if (!verdict.ok) return { reason: `curation rejected: ${verdict.reason}` };
		vcs.updateRef(curatedRef(runId), tip);
		return { tip };
	} catch (error) {
		if (signal.aborted) throw error;
		return { reason: `curation failed: ${errorText(error)}` };
	} finally {
		vcs.removeWorktree(path);
	}
}

async function deliveryChecks(deps: DeliverDeps, tip: string, signal: AbortSignal): Promise<CheckResult[]> {
	const { vcs, runId, store } = deps;
	if (!deps.checks.length) return [];
	const path = worktreePath(vcs.commonDir(), runId, DELIVER_SLOT);
	vcs.removeWorktree(path);
	try {
		vcs.addWorktree(path, tip);
		const results = await runChecks(deps.checks, { cwd: path, commit: tip, outputs: store.outputs, signal });
		for (const r of results) store.journal.append({ t: "check.completed", checkId: r.id, commit: tip, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, logRef: r.logRef, tail: r.tail, purpose: "deliver" });
		deps.onProgress?.();
		return results;
	} finally {
		vcs.removeWorktree(path);
	}
}

function finish(deps: DeliverDeps, event: JournalInput<DeliveryCompletedEvent>, journaled: boolean, extra: Partial<DeliveryOutcome> = {}): DeliveryOutcome {
	const { store, vcs, runId } = deps;
	if (!journaled) store.journal.append(event);
	// Best effort before run.finished: a failed cleanup must neither fail a delivery that happened nor leave the run open.
	let warning: string | undefined;
	try {
		cleanupRun(vcs, vcs.commonDir(), runId);
	} catch (error) {
		warning = `cleanup failed (refs/herder/${runId}/ or the run's worktrees may remain): ${errorText(error)}`;
	}
	store.journal.append({ t: "run.finished", status: "delivered", reason: `delivered as ${event.mode} to ${event.target}` });
	deps.onProgress?.();
	const { mode, target, tip, commits, rebasedOnto, checks, curated } = event;
	return { ...extra, status: "delivered", mode, target, tip, commits, rebasedOnto, checks, curated, ...(warning ? { warning } : {}) };
}

/** The deliver checks journaled for the replayed tip right before the latest `delivery.started` (which does not carry them). */
function replayChecks(deps: DeliverDeps): CheckResult[] {
	let batch: CheckResult[] = [], latest: CheckResult[] = [];
	for (const event of deps.store.journal.read()) {
		if (event.t === "delivery.started") latest = batch;
		if (event.t !== "check.completed" || event.purpose !== "deliver") continue;
		if (batch[0]?.commit !== event.commit) batch = [];
		const { checkId: id, commit, exitCode, timedOut, durationMs, tail, logRef } = event;
		batch.push({ id, commit, exitCode, timedOut, durationMs, tail, logRef, passed: exitCode === 0 && !timedOut });
	}
	return latest;
}

/**
 * A `delivery.started` without `delivery.completed`: the process died around the write. Returns the event to finish
 * with when the write happened, `{}` when it evidently did not (a normal delivery follows), or a refusal when the
 * checkout cannot tell. Only evidence of the write counts: the user may have committed or edited since.
 */
function interrupted(deps: DeliverDeps, started: DeliveryStartedEvent): { done?: JournalInput<DeliveryCompletedEvent>; refuse?: string } {
	const { vcs } = deps;
	const { mode, target, tip, onto, commits, rebasedOnto, curated } = started;
	const done = (at = tip) => ({ done: { t: "delivery.completed" as const, mode, target, tip: at, commits, rebasedOnto, ...(rebasedOnto ? { checks: replayChecks(deps) } : {}), curated } });
	const prefix = `a ${mode} delivery to ${target} was interrupted`;
	if (mode === "branch") {
		const at = vcs.readRef(`refs/heads/${target}`);
		if (at === tip) return done();
		return at === null ? {} : { refuse: `${prefix}, and branch ${target} now points at ${short(at)} instead of ${short(tip)}; delete or rename it to deliver again` };
	}
	const head = vcs.head();
	const reaches = (from: string, to: string) => from === to || !vcs.revList(`${from}..${to}`).length;
	const offLine = { refuse: `${prefix}, and HEAD is now ${short(head)}, which does not contain the HEAD it wrote onto (${short(onto)}); check whether the changes arrived, then reset to ${short(onto)} to deliver again or abort the run` };
	if (mode === "series") return reaches(head, tip) ? done() : reaches(head, onto) ? {} : offLine;
	if (mode === "squash") {
		if (!reaches(head, onto)) return offLine;
		const tree = vcs.treeOf(tip);
		const written = vcs.revList(`${onto}..${head}`).find((commit) => {
			const parents = vcs.parentsOf(commit);
			return parents.length === 1 && parents[0] === onto && vcs.treeOf(commit) === tree;
		});
		if (written === undefined) return {};
		// Recording another commit than the journaled one would disagree with the branch; an amended or rebuilt one is the user's.
		return written === tip ? done() : { refuse: `${prefix}, and ${target} has ${short(written)} with the delivered tree instead of the delivered commit ${short(tip)}; check whether it is the delivery, then abort the run or reset to ${short(onto)} to deliver again` };
	}
	// A re-apply onto a clean moved HEAD that already has the changes fails atomically in the apply.
	if (head !== onto) return vcs.isClean() ? {} : { refuse: `${prefix}, HEAD moved from ${short(onto)} to ${short(head)}, and the checkout has uncommitted changes; check whether the changes arrived, then commit or clean them to deliver again or abort the run` };
	if (vcs.isClean()) return {};
	const tree = vcs.checkoutTree();
	if (tree === vcs.treeOf(tip)) return done();
	if (tree === vcs.treeOf(onto)) return {};
	return { refuse: `${prefix}, and the checkout has other changes than the delivered ones; inspect them, then clean the checkout to deliver again or abort the run` };
}

/**
 * Preflight, optional curation, replay onto a moved checkout with rechecks, confirmation, then the write for `mode`.
 * Everything before the confirmation touches only objects, `refs/herder/`, and Herder worktrees.
 */
export async function deliver(deps: DeliverDeps, request: DeliveryRequest): Promise<DeliveryOutcome> {
	const { runId, store, vcs } = deps;
	const mode = request.mode ?? "series";
	if (!MODES.includes(mode)) throw new Error(`unknown delivery mode ${JSON.stringify(mode)}; expected one of ${MODES.join(", ")}`);
	const signal = deps.signal ?? new AbortController().signal;
	const refuse = (reason: string, extra: Partial<DeliveryOutcome> = {}): DeliveryOutcome => ({ ...extra, status: "refused", reason, mode });

	const state = store.state();
	if (state.finished) return refuse(`run ${runId} is already finished (${state.finished.status})`);
	// A crash between delivery.completed and run.finished: the write happened, only the bookkeeping is missing.
	if (state.delivery) return finish(deps, state.delivery, true);
	if (state.deliveryStarted) {
		const { done, refuse: refused } = interrupted(deps, state.deliveryStarted);
		if (done) return finish(deps, done, false);
		if (refused) return refuse(refused);
	}
	const base = state.base;
	const head = vcs.readRef(integrationRef(runId));
	if (base === undefined || head === null) return refuse(`run ${runId} has no base or integration head`);
	const verification = state.verification;
	if (!verification) return refuse("the run has not been verified; verify it before delivery");
	if (verification.verdict !== "met") return refuse(`the verification verdict is ${verification.verdict}; delivery requires met`);
	if (verification.head !== head) return refuse(`verification ran at ${short(verification.head)}, but the integration head is now ${short(head)}; verify again`);
	if (head === base) return refuse("nothing to deliver: no changes were integrated");
	const blocked = guard(vcs, mode);
	if (blocked) return refuse(blocked);
	if (mode === "branch" && vcs.readRef(`refs/heads/${reviewBranch(runId)}`) !== null) return refuse(`branch ${reviewBranch(runId)} already exists`);
	const title = deps.title.trim() || `Herder run ${runId}`;
	if (mode === "squash" && hasHerderTrailer(title)) return refuse("the goal title looks like a Herder trailer");

	let series = head, curated = false, curation: string | undefined;
	if (request.curate) {
		const result = await curate(deps, base, head, signal);
		if (result.tip) { series = result.tip; curated = true; } else curation = result.reason;
	}
	const extra = (): Partial<DeliveryOutcome> => ({ curated, ...(curation ? { curation } : {}) });

	// Replay onto the checkout's HEAD when it moved; commits whose changes it already has are dropped. A review branch
	// starts at the base: it does not depend on whatever is checked out, and its tree is the verified tree.
	const onto = mode === "branch" ? base : vcs.head();
	const expected: Expected = { head: onto, branch: vcs.currentBranch() };
	let tip = series, rebasedOnto: string | undefined, checks: CheckResult[] | undefined;
	if (onto !== base) {
		let parent = onto;
		for (const commit of vcs.revList(`${base}..${series}`)) {
			const merged = vcs.mergeTree(parent, commit, vcs.parentsOf(commit)[0]);
			if (!merged.clean) return refuse(`replaying ${short(commit)} (${subject(vcs.message(commit))}) onto ${short(onto)} conflicts in ${merged.conflicts.join(", ")}; deliver with mode "branch" (a review branch on the run's base, no replay), or resolve the conflict on your branch and deliver again`, { ...extra(), conflicts: merged.conflicts });
			if (merged.tree !== vcs.treeOf(parent)) parent = vcs.commitTree(merged.tree, [parent], vcs.message(commit));
		}
		tip = parent;
		rebasedOnto = onto;
		checks = await deliveryChecks(deps, tip, signal);
		const failed = checks.filter((check) => !check.passed);
		if (failed.length) return refuse(`checks failed at the replayed tip ${short(tip)}: ${failed.map((check) => check.id).join(", ")}`, { ...extra(), tip, rebasedOnto, checks });
	} else if (vcs.treeOf(tip) !== vcs.treeOf(head)) {
		return refuse("the delivery tip's tree differs from the verified tree", extra());
	}
	const commits = vcs.revList(`${onto}..${tip}`);
	const marked = commits.find((commit) => hasHerderTrailer(vcs.message(commit)));
	if (marked) return refuse(`commit ${short(marked)} carries a Herder trailer; it cannot be delivered`, extra());

	const target = mode === "uncommitted" ? vcs.topLevel() : mode === "branch" ? reviewBranch(runId) : expected.branch!;
	const lines = [`Deliver Herder run ${runId} (${title}) as ${mode} to ${target}.`];
	if (rebasedOnto) lines.push(`The checkout moved since the run started: replayed onto ${short(rebasedOnto)}; ${checks!.length ? `checks passed at the new tip (${checks!.map((check) => check.id).join(", ")})` : "no checks are defined"}.`);
	if (curated) lines.push("Using the curated series (same final tree as the verified head).");
	if (curation) lines.push(`Keeping the original series: ${curation}.`);
	if (mode === "branch") lines.push(`Branch ${target} at ${short(tip)}, on the run's base ${short(base)}; the checkout is not touched.`);
	else if (mode === "squash") lines.push(`One commit "${title}" with the tree of ${short(tip)}, on top of ${short(onto)}.`);
	else if (mode === "uncommitted") lines.push(`The changes of ${commits.length} commit(s) are applied to the working tree, unstaged.`);
	lines.push(`Commits (oldest first):`, ...commits.map((commit) => `  ${short(commit)} ${subject(vcs.message(commit))}`));
	if (!await deps.confirm(lines.join("\n"))) return { status: "cancelled", reason: "the user declined the delivery", mode, ...extra() };

	const moved = guard(vcs, mode, expected);
	if (moved) return refuse(moved, extra());
	let delivered = mode === "uncommitted" ? [] : commits;
	if (mode === "squash") {
		if (vcs.treeOf(tip) === vcs.treeOf(onto)) return finish(deps, { t: "delivery.completed", mode, target, tip: onto, commits: [], rebasedOnto, checks, curated }, false, extra());
		tip = vcs.commitTree(vcs.treeOf(tip), [onto], title);
		delivered = [tip];
	}
	store.journal.append({ t: "delivery.started", mode, target, tip, onto, commits: delivered, rebasedOnto, curated });
	if (mode === "series" || mode === "squash") vcs.fastForward(tip);
	else if (mode === "uncommitted") vcs.applyDiff(onto, tip);
	else {
		try {
			vcs.updateRef(`refs/heads/${target}`, tip, null);
		} catch (error) {
			if (error instanceof RefConflictError) return refuse(`branch ${target} already exists`, extra());
			throw error;
		}
	}
	return finish(deps, { t: "delivery.completed", mode, target, tip, commits: delivered, rebasedOnto, checks, curated }, false, extra());
}
