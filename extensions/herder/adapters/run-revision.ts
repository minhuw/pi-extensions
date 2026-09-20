import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invokeHerderTool } from "../src/application/tools.ts";
import { beginRequestedRunRevision, finishRunRevision } from "../src/application/run-revision.ts";
import { grantHostAttention, revisionDriver, confirmRunRevision, prepareRunRevision, readRunRevision, restoreRevisionGraph, verifyRevisionCheckout, writeRunRevision, type RunRevision } from "../src/core/run-revision.ts";
import { attentionRequestSha256, sha256, stableJson, type AttentionResolutionInput, type ManagerAttentionRequest, type ManagerReply } from "../src/shared/protocol.ts";

import { graphInputSha256 } from "../src/core/plan-edit.ts";
import { RunStore, type StoredPlanSpec, type StoredRun } from "../src/daemon/run-store.ts";

import { attentionResolutionFromRequest, isRoundDecision } from "./attention.ts";

export interface RunRevisionHost {
	assertRun?(run: StoredRun): void;
	assert(record: RunRevision): void;
	settle(record: RunRevision): Promise<void>;
	observe(reply: ManagerReply): void;
	finished(result: { reply?: ManagerReply; abandoned?: true }, record: RunRevision): Promise<void>;
}

/** Exact changed spans include acceptance, boundaries, permissions and shared context. */
export function scopeChangePreview(previous: StoredPlanSpec[], proposed: StoredPlanSpec[]): string {
	const before = new Map(previous.map(spec => [spec.planId, spec]));
	const after = new Map(proposed.map(spec => [spec.planId, spec]));
	const changes: string[] = [];
	for (const id of new Set([...before.keys(), ...after.keys()])) {
		const old = before.get(id), next = after.get(id);
		if (old?.planFingerprint === next?.planFingerprint) continue;
		const a = old?.assignment.planText.split("\n") ?? [];
		const b = next?.assignment.planText.split("\n") ?? [];
		let prefix = 0, suffix = 0;
		while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
		while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
		changes.push(`${!old ? "ADDED" : !next ? "REMOVED" : "CHANGED"} plan ${id}: acceptance / permissions / assignment`,
			`Permissions before: ${JSON.stringify(old?.assignment.plan.inScopePaths ?? [])}`,
			`Permissions after: ${JSON.stringify(next?.assignment.plan.inScopePaths ?? [])}`,
			`Dependencies before: ${JSON.stringify(old?.dependencies ?? [])}; after: ${JSON.stringify(next?.dependencies ?? [])}`,
			...a.slice(prefix, a.length - suffix).map(line => `- ${line}`),
			...b.slice(prefix, b.length - suffix).map(line => `+ ${line}`));
	}
	return changes.join("\n");
}

/** The only confirmation path; never accept model-supplied confirmed flags. */
export async function finishWholeRunEdit(directory: string, editToken: string, ctx: Pick<ExtensionContext, "hasUI" | "ui">, host: RunRevisionHost,
	decision: RunRevision["decision"] = "revise_run"): Promise<unknown> {
	let record = readRunRevision(directory);
	if (!record || record.editToken !== editToken) throw new Error("Whole-run finish is not bound to this exact edit token");
	host.assert(record);
	if (["draft", "prepared"].includes(record.state)) {
		if (!ctx.hasUI) throw new Error("Whole-run revision requires interactive host confirmation");
		record = await prepareRunRevision(directory, editToken, decision);
		host.assert(record);
		const store = new RunStore(directory, { readOnly: true });
		let scopePreview: string;
		try { scopePreview = scopeChangePreview(store.getPlanSpecs(record.run.runId, record.run.currentGeneration), record.selective?.specs ?? []); }
		finally { store.close(); }
		const approved = await ctx.ui.confirm(decision === "abandon_run" ? "Abandon this entire Herder execution?" : "Approve this whole-run revision?", [
			`Request: ${record.request.requestId}`, `Run: ${record.run.runId}`, `Original base: ${record.run.baseCommit}`,
			`Exact graph: ${record.graphSha256}`, `Exact Markdown: ${record.inputSha256}`,
			scopePreview,
			...(decision === "abandon_run" ? [
				"All workers will be settled before deleting every old execution worktree, branch, and proof. Preserve plan Markdown. Do not restart any workers.",
			] : record.selective ? [
				`Retain completed plans: ${record.selective.retainedPlanIds.join(", ") || "none"}`,
				`Rerun plans: ${record.selective.rerunPlanIds.join(", ") || "none"}`,
				`Remove plans: ${record.selective.removedPlanIds.join(", ") || "none"}`,
				`Integration before revision: ${record.selective.integrationHead}`,
				"Retain unrelated completed work and its original evidence. Reverse invalidated contributions and discard only affected execution surfaces; unfinished work restarts. Conflicts keep recovery blocked rather than discarding extra work. Final verification and approval run again.",
			] : ["Legacy revision: discard every old execution worktree, branch, and proof and rerun every revised plan from TODO on the original base."]),
			"Scope approval does not refill effort budgets. Original assignments and acceptance history remain recorded.",
			"Your source checkout and branch will not be reset.",
		].join("\n\n"));
		host.assert(record);
		if (!approved) throw new Error("Confirmation dismissed: revision remains recoverable, old execution is intact, and no unchanged workers will restart. Refine the graph and call finish_edit again, or leave the run stopped.");
		record = await confirmRunRevision(record);
	}
	host.assert(record);
	await host.settle(record);
	host.assert(record);
	const result = await finishRunRevision(directory, editToken);
	await host.finished(result, record);
	return result;
}

/** Called only by user commands (scope) or the explicitly confirmed safe retry path. */
export async function confirmHostAttention(directory: string, resolution: AttentionResolutionInput, ctx: Pick<ExtensionContext, "hasUI" | "ui">, newRequest?: ManagerAttentionRequest, assertCurrent?: (run: StoredRun) => void): Promise<StoredRun> {
	if (!ctx.hasUI) throw new Error("This operation requires interactive host confirmation");
	const store = new RunStore(directory, { readOnly: true });
	try {
		const run = store.getRun();
		const request = store.getAttention(resolution.requestId) ?? newRequest;
		if (!run || !request || request.state === "resolved" || request.requestSha256 !== resolution.requestSha256 || run.runId !== resolution.runId) throw new Error("Attention identity changed before confirmation");
		assertCurrent?.(run);
		const inputSha256 = graphInputSha256(directory);
		const driver = revisionDriver(run);
		const worktree = request.planId === "RUN" ? run.integrationWorktree : store.getPlan(run.runId, request.planId)?.worktree;
		const treeBinding = () => worktree ? { worktree, head: driver.worktreeHead(worktree), tree: driver.worktreeTree(worktree), status: driver.worktreeStatus(worktree) } : null;
		const currentTree = treeBinding();
		const title = resolution.action === "accept" ? "Accept unresolved findings as-is, not passed checks?"
			: resolution.action === "reject" ? "Drop plan, preserving work and blocking dependents?"
			: resolution.action === "retry" ? (isRoundDecision(request) ? "Next round: exact bounded repairs only?" : "Retry this exact stopped role?")
			: resolution.action === "answer_and_resume" ? "Confirm this exact within-scope clarification?" : "Open a scope amendment?";
		const approved = await ctx.ui.confirm(title, [
			`Run: ${run.runId}`, `Generation: ${run.currentGeneration}`, `Graph: ${run.graphSha256}`,
			`Request: ${request.requestId}`, `Action: ${resolution.action}`, `Role: ${request.continuation.role}; round ${request.round}`,
			`Request SHA256: ${request.requestSha256}`, `Resolution SHA256: ${sha256(stableJson(resolution))}`,
			`Current worktree: ${currentTree?.worktree ?? "none"}`, `HEAD: ${currentTree?.head ?? "none"}`, `Tree: ${currentTree?.tree ?? "none"}`,
			`Answer: ${resolution.answer ?? "none"}`, `Rationale: ${resolution.rationale ?? "none"}`,
			resolution.action === "accept" ? "Accept unresolved findings as-is, not passed checks. Failed checks remain failed; backend exact gates and integration requirements remain authoritative. This grants no scope expansion or budget."
				: resolution.action === "reject" ? "Preserve existing patches, branches, worktrees and evidence. Drop this plan and block dependents; this is not destructive cleanup or abandonment of the whole run."
				: ["retry", "answer_and_resume"].includes(resolution.action) ? "Confirm this makes only the recorded continuation runnable within the already approved scope and remaining budget. No acceptance waiver, permission expansion, dependency change, or budget refill is authorized." : "Authorize Markdown proposal drafting only. Preserve patches and history. Exact changes require a separate final confirmation; effort budgets are unchanged.",
		].join("\n\n"));
		if (!approved) throw new Error("Host confirmation dismissed; execution and evidence are unchanged");
		if (stableJson(treeBinding()) !== stableJson(currentTree) || graphInputSha256(directory) !== inputSha256 || stableJson(store.getRun()) !== stableJson(run) || (newRequest ? Boolean(store.getNextAttention(run.runId)) : stableJson(store.getAttention(request.requestId)) !== stableJson(request))) throw new Error("Attention changed during host confirmation");
		assertCurrent?.(run);
		grantHostAttention(run, resolution);
		return run;
	} finally { store.close(); }
}

export async function beginWholeRunAttention(directory: string, resolution: AttentionResolutionInput, ctx: Pick<ExtensionContext, "hasUI" | "ui">, host: RunRevisionHost, newRequest?: ManagerAttentionRequest): Promise<unknown> {
	const run = await confirmHostAttention(directory, resolution, ctx, newRequest, host.assertRun);
	const result = newRequest ? await beginRequestedRunRevision(run, newRequest, resolution) : await invokeHerderTool("herder_plan", { operation: "attention", planDirectory: directory, ...resolution }) as { reply: ManagerReply };
	host.observe(result.reply);
	const record = readRunRevision(directory);
	if (!record || record.request.requestId !== resolution.requestId || record.request.requestSha256 !== resolution.requestSha256) throw new Error("Manager did not reserve the whole-run revision");
	host.assert(record);
	await host.settle(record);
	if (resolution.action === "abandon_run") return finishWholeRunEdit(directory, record.editToken, ctx, host, "abandon_run");
	return { ...result, editToken: record.editToken, scope: "whole-run plan-graph Markdown only", instructions: "Inspect the failure and propose concrete graph edits directly for user refinement. All IDs, dependencies, shared context, additions/removals, and previously integrated plans may change. Change only what is needed; unrelated completed plans need not be rewritten. Herder derives retained/rerun/removed plans from immutable assignments, dependency changes, and completion evidence, not authored statuses. Final confirmation previews that impact; conflicts remain blocked rather than discarding extra work. Source code and runtime files are not writable. Call finish_edit with this editToken for final host confirmation; dismissal never abandons or retries." };
}

/** Only a slash-command handler calls this; model attention tools cannot initiate it. */
export async function beginUserScopeAmendment(directory: string, ctx: Pick<ExtensionContext, "hasUI" | "ui">, host: RunRevisionHost): Promise<unknown> {
	const store = new RunStore(directory, { readOnly: true });
	let request: ManagerAttentionRequest;
	let synthetic = false;
	try {
		const run = store.getRun();
		if (!run || ["complete", "stopped"].includes(run.status)) throw new Error("Scope amendment requires a nonterminal run; no successor is created");
		const pending = store.getNextAttention(run.runId);
		if (pending) request = pending;
		else {
			synthetic = true;
			const detail = "The user invoked /herder-revise to request a scope amendment; drafting is not execution approval.";
			request = { schemaVersion: 1, requestId: randomUUID(), runId: run.runId, planId: "RUN", generation: run.currentGeneration,
				round: 1, actionId: null, kind: "user_decision", state: "awaiting_input", cause: "initial_decision_blocked",
				detail, detailSha256: sha256(detail), question: "Which exact scope amendment does the user authorize?",
				continuation: { role: "plan-judge", phase: "READY_JUDGE" }, requestSha256: "",
				createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
			request.requestSha256 = attentionRequestSha256(request);
		}
	} finally { store.close(); }
	return beginWholeRunAttention(directory, { ...attentionResolutionFromRequest(request), action: "revise_run" }, ctx, host, synthetic ? request : undefined);
}

export async function cancelWholeRunEdit(directory: string, editToken: string, host: RunRevisionHost): Promise<unknown> {
	const record = readRunRevision(directory);
	if (!record || record.editToken !== editToken || !["draft", "prepared"].includes(record.state)) throw new Error("Only an unconfirmed whole-run draft can be restored");
	host.assert(record);
	await verifyRevisionCheckout(record);
	restoreRevisionGraph(record);
	const { graphSha256: _graph, inputSha256: _input, selective: _selective, ...draft } = record;
	writeRunRevision(directory, { ...draft, state: "draft", decision: "revise_run" }, record);
	return { editToken, state: "draft", message: "Original Markdown restored; the whole-run revision remains open. No unchanged workers resume. Propose another revision or leave the run stopped." };
}

/** During a reserved conversation the main session receives Markdown authority, not shell authority. */
export function wholeRunToolPolicy(record: RunRevision, toolName: string, input: Record<string, unknown>, cwd: string): { block: true; reason: string } | undefined {
	if (["complete", "abandoned"].includes(record.state)) return;
	if (["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content", "source_check", "herder_plan"].includes(toolName)) return;
	const denied = { block: true as const, reason: "Whole-run revision grants only plan-graph Markdown edits and read-only inspection tools. Shell, source-code, runtime, and worker-worktree edits are not authorized." };
	if (!["draft", "prepared"].includes(record.state)) return denied;
	const directory = record.run.planDirectory;
	const safePath = (value: string): boolean => {
		const target = path.resolve(fs.realpathSync(cwd), value);
		const relative = path.relative(directory, target);
		if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || relative.split(path.sep).includes(".herder")) return false;
		if (!(relative === "README.md" || relative === "CONTEXT.md" || /^\d{3,}-.*\.md$/i.test(path.basename(relative)))) return false;
		for (let candidate = target; candidate !== directory; candidate = path.dirname(candidate)) {
			try { if (fs.lstatSync(candidate).isSymbolicLink()) return false; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
		}
		return true;
	};
	if (["write", "edit"].includes(toolName) && typeof input.path === "string" && safePath(input.path)) return;
	// Literal, shell-expansion-free graph-only remove/rename enables ID/file-set edits.
	if (toolName === "bash" && typeof input.command === "string") {
		const atom = "(?:'[A-Za-z0-9_./ -]+'|[A-Za-z0-9_./-]+)";
		const remove = input.command.match(new RegExp(`^rm -- (${atom})$`));
		const move = input.command.match(new RegExp(`^mv -- (${atom}) (${atom})$`));
		const paths = (remove ?? move)?.slice(1).map(value => value.replace(/^'|'$/g, ""));
		if (paths?.every(safePath)) return;
	}
	return denied;
}
