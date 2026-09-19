import { HerderRunManager } from "../core/run-manager.ts";
import { assertHostAttentionGrant, assertApprovedRevisionGraph, readRunRevision, verifyRevisionCheckout, writeRunRevision, revisionDriver, type RunRevision } from "../core/run-revision.ts";
import { withServiceExclusion } from "../client/index.ts";
import { RunStore, type StoredRun } from "../daemon/run-store.ts";
import { cleanupIdentity, stageSelectiveReversal, validateSelectiveArtifacts, SelectiveReversalConflict } from "../daemon/git/selective-revision.ts";
import { runGit } from "../daemon/git/primitives.ts";
import { stableJson, type AttentionResolutionInput, type ManagerAttentionRequest, type ManagerReply } from "../shared/protocol.ts";

function crashRevisionForTest(point: string): void {
	if (process.env.HERDER_TEST_RUN_REVISION_CRASH_AT === point) process.kill(process.pid, "SIGKILL");
}

/** A user-requested scope amendment also works when the stop has no worker attention. */
export async function beginRequestedRunRevision(run: StoredRun, request: ManagerAttentionRequest, resolution: AttentionResolutionInput): Promise<{ reply: ManagerReply }> {
	return withServiceExclusion(run.planDirectory, async () => {
		const manager = new HerderRunManager(run.planDirectory);
		try {
			if (stableJson(manager.store.getRun()) !== stableJson(run) || manager.store.getNextAttention(run.runId)) throw new Error("Run changed during scope confirmation");
			if (["complete", "stopped"].includes(run.status)) throw new Error("Terminal runs cannot be amended; preserve their history");
			assertHostAttentionGrant(run, resolution);
			manager.store.putAttention(request);
			return { reply: await manager.event({ eventId: `user-scope:${request.requestId}`, kind: "attention", attention: resolution }) };
		} finally { manager.close(); }
	}, { purpose: "revision" });
}

/** Host-only finish. The model cannot provide confirmation or reset identities. */
export async function finishRunRevision(directory: string, editToken: string): Promise<{ reply?: ManagerReply; abandoned?: true }> {
	return withServiceExclusion(directory, async () => {
		const record = readRunRevision(directory);
		if (!record || record.editToken !== editToken) throw new Error("Whole-run finish has no matching durable edit");
		if (!record.selective || record.decision !== "revise_run") throw new Error("Legacy destructive revision/abandonment replay is paused: preserve execution and budgets; explicit operator recovery is required");
		return finishSelectiveRevision(record);
	}, { purpose: "revision" });
}

/** Same run, new graph generation. Every mutation replays from immutable confirmed evidence. */
async function finishSelectiveRevision(initial: RunRevision): Promise<{ reply: ManagerReply }> {
	let record = initial;
	const directory = record.run.planDirectory;
	if (!["confirmed", "resetting", "restarting", "complete"].includes(record.state)) throw new Error("Selective finish requires host confirmation");
	const save = (next: RunRevision) => { writeRunRevision(directory, next, record); record = next; };
	await verifyRevisionCheckout(record);
	const driver = revisionDriver(record.run);
	const store = new RunStore(directory);
	try {
		const current = store.getRun();
		const selective = record.selective!;
		if (!current || current.runId !== record.run.runId
			|| (["repositoryRoot", "planDirectory", "planName", "host", "profileName", "profileSha256", "maxParallel", "integrationBranch", "integrationWorktree", "baseCommit", "checkoutStateToken"] as const).some(key => current[key] !== record.run[key])
			|| !((current.currentGeneration === selective.sourceGeneration && current.graphSha256 === record.run.graphSha256)
				|| (current.currentGeneration === selective.nextGeneration && current.graphSha256 === record.graphSha256))) throw new Error("Selective revision execution identity changed");
		if (current.currentGeneration === selective.sourceGeneration) {
			const request = store.getAttention(record.request.requestId);
			if (!request || request.state === "resolved" || request.requestSha256 !== record.request.requestSha256) throw new Error("Selective revision attention changed");
			if (store.countActions(current.runId, { states: ["proposed", "dispatched"] })) throw new Error("All workers must settle before selective revision");
		} else if (!["restarting", "complete"].includes(record.state)) throw new Error("Selective revision advanced before its adoption intent");
		if (record.state !== "complete") assertApprovedRevisionGraph(record);
		if (record.state === "confirmed") {
			validateSelectiveArtifacts(record.run, record.selective!, driver);
			let publication;
			try { publication = stageSelectiveReversal(record.run, record.selective!); }
			catch (error) {
				if (error instanceof SelectiveReversalConflict) {
					assertApprovedRevisionGraph(record);
					const { publication: _publication, published: _published, resumed: _resumed, ...original } = record.selective!;
					validateSelectiveArtifacts(record.run, original, driver);
					save({ ...record, state: "prepared", selective: original });
					error.message += "\nRevision is editable again. Refine the plan graph and call finish_edit for fresh confirmation, or explicitly abandon_run.";
				}
				throw error;
			}
			validateSelectiveArtifacts(record.run, record.selective!, driver);
			save({ ...record, state: "resetting", selective: { ...record.selective!, publication } });
			crashRevisionForTest("before_publication");
		}
		if (record.state === "resetting") {
			let selective = record.selective!;
			if (!selective.publication) throw new Error("Selective revision lost staged publication evidence");
			validateSelectiveArtifacts(record.run, selective, driver, store, record.request);
			if (driver.branchHead(record.run.integrationBranch) === selective.integrationHead && selective.publication.head !== selective.integrationHead) {
				if (runGit(record.run.repositoryRoot, ["rev-parse", `${selective.publication.head}^`]).stdout.trim() !== selective.integrationHead
					|| runGit(record.run.repositoryRoot, ["rev-parse", `${selective.publication.head}^{tree}`]).stdout.trim() !== selective.publication.tree) throw new Error("Staged selective publication changed");
				runGit(record.run.integrationWorktree, ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", selective.publication.head]);
			}
			if (!selective.published) {
				save({ ...record, selective: { ...selective, published: true } });
				selective = record.selective!;
			}
			crashRevisionForTest("after_publication");
			for (const artifact of selective.artifacts) {
				validateSelectiveArtifacts(record.run, selective, driver, store, record.request);
				const identity = cleanupIdentity(record.run, artifact, { requestId: record.request.requestId, requestSha256: record.request.requestSha256 });
				driver.resetPlanExecution({ branch: artifact.plan.branch, worktree: artifact.plan.worktree, expectedHead: artifact.head, expectedTree: artifact.tree, additionalRefs: artifact.refs,
					cleanupIdentity: identity, recordedCleanup: store.getAttentionCleanupEvidence(identity) ?? undefined,
					onPrepare: step => { store.recordAttentionCleanupStep(identity, step); crashRevisionForTest(`before_cleanup_${step}`); },
					onComplete: step => { crashRevisionForTest(`after_cleanup_${step}`); store.recordAttentionCleanupCompletion(identity, step); } });
			}
			validateSelectiveArtifacts(record.run, selective, driver, store, record.request);
			crashRevisionForTest("after_reset");
			save({ ...record, state: "restarting" });
			crashRevisionForTest("after_restarting");
		}
		if (record.state === "restarting") {
			if (!record.selective!.published) throw new Error("Selective cutover lacks completed publication evidence");
			validateSelectiveArtifacts(record.run, record.selective!, driver, store, record.request);
		}
	} finally { store.close(); }
	const manager = new HerderRunManager(directory);
	try {
		if (record.state === "restarting") {
			manager.adoptSelectiveRevision(record);
			crashRevisionForTest("after_restart");
			save({ ...record, state: "complete" });
			crashRevisionForTest("after_complete");
		}
		if (record.selective!.resumed) return { reply: manager.reply() };
		const reply = await manager.start({ mode: "resume", repositoryRoot: record.run.repositoryRoot, planDirectory: directory, profile: record.run.profileName, maxParallel: record.run.maxParallel });
		crashRevisionForTest("after_schedule");
		save({ ...record, selective: { ...record.selective!, resumed: true } });
		return { reply };
	} finally { manager.close(); }
}
