import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePiProfile } from "./profile-registry.ts";
import { buildGraph, projectStatuses } from "./plans.ts";
import { compileGraphIdentity, compilePlanSpecs } from "./plan-identity.ts";
import { captureReworkSnapshot, ensurePrivateDirectory, fsyncDirectory, graphInputSha256, readRegularBytes, readReworkSnapshotFile, restoreGraphSnapshot } from "./plan-edit.ts";
import { GitDriver } from "../daemon/git-driver.ts";
import type { StoredRun, StoredPlanEdit } from "../daemon/run-store.ts";
import { sha256, stableJson, type AttentionResolutionInput } from "../shared/protocol.ts";

import { prepareSelectiveRevision, validateSelectiveArtifacts, selectivePreviewSha256, type SelectiveRevision } from "../daemon/git/selective-revision.ts";

export interface RunRevision {
	selective?: SelectiveRevision;
	/** Completed same-run revision attribution, carried into the next draft. */
	priorSelectiveCommits?: string[];
	version: 1;
	editToken: string;
	run: StoredRun;
	request: AttentionResolutionInput;
	snapshotSha256: string;
	state: "draft" | "prepared" | "confirmed" | "resetting" | "restarting" | "complete" | "abandoned";
	decision: "revise_run" | "abandon_run";
	successorRunId: string;
	graphSha256?: string;
	inputSha256?: string;
	abandonSnapshotSha256?: string;
}

const recordPath = (directory: string) => path.join(directory, ".herder", "run-revision.json");
export const revisionPending = (record: RunRevision | null): record is RunRevision => Boolean(record && !["complete", "abandoned"].includes(record.state));

/** Private, durable authority survives resetExecutionState; no public event can forge it. */
export function readRunRevision(directory: string): RunRevision | null {
	const candidate = recordPath(directory);
	try { fs.lstatSync(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	ensurePrivateDirectory(path.join(directory, ".herder"));
	const file = readRegularBytes(candidate, "whole-run revision record");
	if (file.mode !== 0o600 || file.bytes.length > 1_000_000) throw new Error("Unsafe whole-run revision record");
	const envelope = JSON.parse(file.bytes.toString("utf8")) as { record: RunRevision; sha256: string };
	const record = envelope.record;
	if (!record || envelope.sha256 !== sha256(stableJson(record)) || record.version !== 1
		|| !/^[0-9a-f-]{36}$/i.test(record.editToken) || !/^[0-9a-f-]{36}$/i.test(record.successorRunId)
		|| record.run.planDirectory !== fs.realpathSync(directory) || record.request.runId !== record.run.runId
		|| !["draft", "prepared", "confirmed", "resetting", "restarting", "complete", "abandoned"].includes(record.state)
		|| !["revise_run", "abandon_run"].includes(record.decision)) throw new Error("Invalid whole-run revision identity");
	if (record.selective && (record.selective.version !== 1 || record.selective.sourceGeneration !== record.run.currentGeneration
		|| record.selective.nextGeneration !== record.run.currentGeneration + 1 || selectivePreviewSha256(record.selective) !== record.selective.previewSha256)) throw new Error("Invalid selective revision generation or preview identity");
	return record;
}

export function writeRunRevision(directory: string, record: RunRevision, expected: RunRevision | null): void {
	if (stableJson(readRunRevision(directory)) !== stableJson(expected)) throw new Error("Whole-run revision changed concurrently");
	const bytes = stableJson({ record, sha256: sha256(stableJson(record)) });
	if (Buffer.byteLength(bytes) > 1_000_000) throw new Error("Whole-run revision exceeds the durable record size limit");
	const runtime = path.join(directory, ".herder");
	ensurePrivateDirectory(runtime);
	const temporary = path.join(runtime, `.run-revision-${randomUUID()}.tmp`);
	const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	try {
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
	} finally { fs.closeSync(fd); }
	try { fs.renameSync(temporary, recordPath(directory)); fsyncDirectory(runtime); }
	finally { try { fs.unlinkSync(temporary); } catch {} }
}

export function revisionDriver(run: StoredRun): GitDriver {
	return new GitDriver({ repoRoot: run.repositoryRoot, planDirectory: run.planDirectory, planName: run.planName,
		helperRoot: path.resolve(import.meta.dirname, "../daemon/git"), worktreeRoot: path.dirname(run.integrationWorktree) });
}

export async function verifyRevisionCheckout(record: RunRevision): Promise<void> {
	if (resolvePiProfile(record.run.profileName).profile_sha256 !== record.run.profileSha256) throw new Error("Original run profile binding changed");
	const driver = revisionDriver(record.run);
	await driver.verifyCheckout(record.run.checkoutStateToken);
	if (driver.worktreeHead(record.run.repositoryRoot) !== record.run.baseCommit) throw new Error("Whole-run revision requires the original checkout HEAD/base; never reset the user's branch");
}

export async function beginRunRevision(run: StoredRun, request: AttentionResolutionInput): Promise<RunRevision> {
	assertHostAttentionGrant(run, request);
	const previous = readRunRevision(run.planDirectory);
	const priorSelective = previous?.run.runId === run.runId ? previous.selective : undefined;
	if (revisionPending(previous)) {
		if (previous.run.runId !== run.runId || previous.request.requestId !== request.requestId || previous.request.requestSha256 !== request.requestSha256) throw new Error("Another whole-run revision owns this execution");
		if (!["draft", "prepared"].includes(previous.state)) throw new Error(`Continue confirmed whole-run finish_edit with token ${previous.editToken}; do not replay attention begin`);
		return previous;
	}
	const record: RunRevision = { version: 1, editToken: randomUUID(), run, request, state: "draft", decision: request.action as RunRevision["decision"], successorRunId: randomUUID(), snapshotSha256: "", ...(priorSelective ? { priorSelectiveCommits: [...priorSelective.knownCommits, ...(priorSelective.publication && priorSelective.publication.head !== priorSelective.integrationHead ? [priorSelective.publication.head] : [])] } : {}) };
	await verifyRevisionCheckout(record);
	if (compileGraphIdentity(buildGraph(run.planDirectory)) !== run.graphSha256) throw new Error("Resolve graph drift before opening whole-run revision");
	const driver = revisionDriver(run);
	const captured = captureReworkSnapshot(run, "RUN", record.editToken, run.baseCommit, driver.worktreeTree(run.repositoryRoot), "README.md", []);
	record.snapshotSha256 = captured.sha256;
	writeRunRevision(run.planDirectory, record, previous);
	return record;
}

export function restoreRevisionGraph(record: RunRevision, abandoned = false): void {
	const edit = { editToken: abandoned ? record.successorRunId : record.editToken, planId: "RUN" } as StoredPlanEdit;
	const snapshot = readReworkSnapshotFile(record.run, edit);
	if (snapshot.sha256 !== (abandoned ? record.abandonSnapshotSha256 : record.snapshotSha256)) throw new Error("Whole-run graph snapshot changed");
	restoreGraphSnapshot(record.run.planDirectory, snapshot.snapshot);
}

export async function prepareRunRevision(directory: string, editToken: string, decision: RunRevision["decision"] = "revise_run"): Promise<RunRevision> {
	const record = readRunRevision(directory);
	if (!record || record.editToken !== editToken) throw new Error("Whole-run edit token does not match");
	if (!["draft", "prepared"].includes(record.state)) return record;
	await verifyRevisionCheckout(record);
	if (decision === "abandon_run") {
		const captured = captureReworkSnapshot(record.run, "RUN", record.successorRunId, record.run.baseCommit, revisionDriver(record.run).worktreeTree(record.run.repositoryRoot), "README.md", []);
		const { selective: _selective, ...abandonRecord } = record;
		const prepared: RunRevision = { ...abandonRecord, state: "prepared", decision, graphSha256: record.run.graphSha256, inputSha256: graphInputSha256(directory), abandonSnapshotSha256: captured.sha256 };
		writeRunRevision(directory, prepared, record);
		return prepared;
	}
	const graph = buildGraph(directory);
	if (!graph.shapeReady || graph.plans.length === 0) throw new Error("Whole-run replacement must be a nonempty, shape-ready valid graph");

	const graphSha256 = compileGraphIdentity(graph);
	if (decision === "revise_run" && graphSha256 === record.run.graphSha256) throw new Error("Propose a concrete graph revision; unchanged retry is not allowed");
	const compiled = compilePlanSpecs({ runId: record.run.runId, graphGeneration: record.run.currentGeneration + 1, graph });
	const selective = prepareSelectiveRevision(record.run, compiled.specs, revisionDriver(record.run), record.priorSelectiveCommits);
	// Reuse the manager's exact terminal approval validator, including human acceptance evidence.
	const { HerderRunManager } = await import("./run-manager.ts");
	const manager = new HerderRunManager(directory);
	try { manager.validateSelectiveApprovals(record.run); } finally { manager.close(); }
	validateSelectiveArtifacts(record.run, selective, revisionDriver(record.run));
	projectStatuses(directory, graph.plans.map(plan => ({ id: plan.id, status: selective.retainedPlanIds.includes(plan.id) ? "DONE" : "TODO" })));
	const prepared: RunRevision = { ...record, selective, decision, state: "prepared", graphSha256, inputSha256: graphInputSha256(directory) };
	writeRunRevision(directory, prepared, record);
	return prepared;
}

/** Status is absent from semantic identity; bind exact Markdown and proof-backed lifecycle too. */
export function assertApprovedRevisionGraph(record: RunRevision, graph = buildGraph(record.run.planDirectory)): void {
	if (graphInputSha256(record.run.planDirectory) !== record.inputSha256) throw new Error("Replacement Markdown changed after host confirmation");
	if (!graph.shapeReady || graph.plans.length === 0 || graph.plans.some(plan => plan.status !== (record.selective?.retainedPlanIds.includes(plan.id) ? "DONE" : "TODO"))) throw new Error("Whole-run replacement requires a valid nonempty graph with every plan TODO except proof-backed retained DONE plans");
	if (compileGraphIdentity(graph) !== record.graphSha256) throw new Error("Replacement graph changed after host confirmation");
}

export async function confirmRunRevision(prepared: RunRevision): Promise<RunRevision> {
	const directory = prepared.run.planDirectory;
	await verifyRevisionCheckout(prepared);
	if (prepared.state !== "prepared" || graphInputSha256(directory) !== prepared.inputSha256 || (prepared.decision === "revise_run" && compileGraphIdentity(buildGraph(directory)) !== prepared.graphSha256)) throw new Error("Whole-run replacement changed after confirmation was requested");
	if (prepared.selective) validateSelectiveArtifacts(prepared.run, prepared.selective, revisionDriver(prepared.run));
	const confirmed: RunRevision = { ...prepared, state: "confirmed" };
	writeRunRevision(directory, confirmed, prepared);
	return confirmed;
}

/** Host-only grant for one exact attention decision, not a public confirmed flag. */
export function grantHostAttention(run: StoredRun, resolution: AttentionResolutionInput): void {
	if (!["revise_run", "abandon_run", "retry", "answer_and_resume", "accept", "reject"].includes(resolution.action)) throw new Error("Unsupported host attention grant");
	const runtime = path.join(run.planDirectory, ".herder");
	ensurePrivateDirectory(runtime);
	const record = { runId: run.runId, generation: run.currentGeneration, graphSha256: run.graphSha256,
		inputSha256: graphInputSha256(run.planDirectory), resolutionSha256: sha256(stableJson(resolution)) };
	const temporary = path.join(runtime, `.attention-host-grant-${randomUUID()}.tmp`);
	const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	try { fs.writeFileSync(fd, stableJson(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	try { fs.renameSync(temporary, path.join(runtime, "attention-host-grant.json")); fsyncDirectory(runtime); }
	finally { try { fs.unlinkSync(temporary); } catch {} }
}

export function assertHostAttentionGrant(run: StoredRun, resolution: AttentionResolutionInput): void {
	if (compileGraphIdentity(buildGraph(run.planDirectory)) !== run.graphSha256) throw new Error("Host attention grant cannot authorize graph drift; use an exact scope amendment");
	let file;
	try { file = readRegularBytes(path.join(run.planDirectory, ".herder", "attention-host-grant.json"), "host attention grant"); }
	catch { throw new Error("This decision requires an exact private host grant; confirmed flags are not authorization"); }
	ensurePrivateDirectory(path.join(run.planDirectory, ".herder"));
	const expected = { runId: run.runId, generation: run.currentGeneration, graphSha256: run.graphSha256,
		inputSha256: graphInputSha256(run.planDirectory), resolutionSha256: sha256(stableJson(resolution)) };
	if (file.mode !== 0o600 || file.bytes.length > 4096 || file.bytes.toString("utf8") !== stableJson(expected)) throw new Error("Host attention grant is stale or does not match this exact decision");
}
