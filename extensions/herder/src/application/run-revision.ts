import { buildGraph } from "../core/plans.ts";
import { compileGraphIdentity } from "../core/plan-identity.ts";
import { graphInputSha256 } from "../core/plan-edit.ts";
import { HerderRunManager } from "../core/run-manager.ts";
import { assertApprovedRevisionGraph, readRunRevision, restoreRevisionGraph, verifyRevisionCheckout, writeRunRevision, type RunRevision } from "../core/run-revision.ts";
import { withServiceExclusion } from "../client/index.ts";
import { RunStore } from "../daemon/run-store.ts";
import { resetHerderPlanSet } from "../daemon/git/reset-plan-set.ts";
import type { ManagerReply } from "../shared/protocol.ts";

function crashRevisionForTest(point: string): void {
	if (process.env.HERDER_TEST_RUN_REVISION_CRASH_AT === point) process.kill(process.pid, "SIGKILL");
}

/** Host-only finish. The model cannot provide confirmation or reset identities. */
export async function finishRunRevision(directory: string, editToken: string): Promise<{ reply?: ManagerReply; abandoned?: true }> {
	return withServiceExclusion(directory, async () => {
		let record = readRunRevision(directory);
		if (!record || record.editToken !== editToken) throw new Error("Whole-run finish has no matching durable edit");
		if (!["confirmed", "resetting", "restarting", "complete", "abandoned"].includes(record.state)) throw new Error("Whole-run finish requires host confirmation");
		const advance = (state: RunRevision["state"]) => {
			const next = { ...record!, state };
			writeRunRevision(directory, next, record);
			record = next;
		};
		await verifyRevisionCheckout(record);
		const store = new RunStore(directory);
		let current;
		try {
			current = store.getRun();
			if (current && current.runId !== record.run.runId && current.runId !== record.successorRunId) throw new Error("Whole-run finish refuses a successor execution");
			if (current?.runId === record.run.runId) {
				if (current.baseCommit !== record.run.baseCommit || current.checkoutStateToken !== record.run.checkoutStateToken || current.currentGeneration !== record.run.currentGeneration || current.graphSha256 !== record.run.graphSha256) throw new Error("Original execution identity changed");
				const request = store.getAttention(record.request.requestId);
				if (!request || request.state === "resolved" || request.requestSha256 !== record.request.requestSha256) throw new Error("Whole-run attention binding changed");
				if (store.countActions(current.runId, { states: ["proposed", "dispatched"] }) !== 0) throw new Error("All run workers must settle before whole-run cleanup");
			}
		} finally { store.close(); }
		if (record.state === "abandoned") {
			if (current) throw new Error("Abandoned execution has a successor; refusing replay");
			return { abandoned: true };
		}
		if (record.state === "complete") {
			if (current?.runId !== record.successorRunId) throw new Error("Replacement execution changed after finish");
			const manager = new HerderRunManager(directory);
			try {
				// Crash after completion was persisted but before the first scheduling pass.
				// Never resume a successor that already owns any worker history.
				if (current.status === "running" && manager.store.countActions(current.runId) === 0) return { reply: await manager.start({ mode: "resume", repositoryRoot: record.run.repositoryRoot, planDirectory: directory, profile: record.run.profileName, maxParallel: record.run.maxParallel }) };
				return { reply: manager.reply() };
			} finally { manager.close(); }
		}
		if (record.state === "confirmed") {
			if (current?.runId !== record.run.runId) throw new Error("Confirmed revision no longer owns the original execution");
			if (graphInputSha256(directory) !== record.inputSha256) throw new Error("Graph changed after host confirmation");
			if (record.decision === "revise_run" && compileGraphIdentity(buildGraph(directory)) !== record.graphSha256) throw new Error("Replacement graph changed");
			advance("resetting"); // Write-ahead authority BEFORE any destructive mutation.
		}
		if (record.state === "resetting") {
			if (current && current.runId !== record.run.runId) throw new Error("Reset replay refuses a successor execution");
			if (record.decision === "revise_run" && graphInputSha256(directory) !== record.inputSha256) throw new Error("Replacement Markdown changed during reset replay");
			if (record.decision === "abandon_run") restoreRevisionGraph(record);
			const input = { repoRoot: record.run.repositoryRoot, planDirectory: directory,
				revision: { runId: record.run.runId, graphSha256: record.graphSha256!, baseCommit: record.run.baseCommit } };
			resetHerderPlanSet(input);
			crashRevisionForTest("after_reset");
			if (record.decision === "abandon_run") {
				restoreRevisionGraph(record, true);
				advance("abandoned");
				return { abandoned: true };
			}
			advance("restarting");
			crashRevisionForTest("after_restarting");
		}
		assertApprovedRevisionGraph(record);
		const manager = new HerderRunManager(directory);
		try {
			const reply = await manager.start({ mode: current?.runId === record.successorRunId ? "resume" : "fire",
				repositoryRoot: record.run.repositoryRoot, planDirectory: directory, planName: record.run.planName,
				profile: record.run.profileName, maxParallel: record.run.maxParallel,
				...(record.run.dashboardUrl ? { dashboardUrl: record.run.dashboardUrl } : {}) });
			if (reply.runId !== record.successorRunId) throw new Error("Replacement Fire returned an unexpected run identity");
			crashRevisionForTest("after_restart");
			advance("complete");
			crashRevisionForTest("after_complete");
			return { reply: await manager.start({ mode: "resume", repositoryRoot: record.run.repositoryRoot, planDirectory: directory,
				profile: record.run.profileName, maxParallel: record.run.maxParallel }) };
		} finally { manager.close(); }
	}, { purpose: "revision" });
}
