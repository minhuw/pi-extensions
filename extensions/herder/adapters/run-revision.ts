import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invokeHerderTool } from "../src/application/tools.ts";
import { finishRunRevision } from "../src/application/run-revision.ts";
import { confirmRunRevision, prepareRunRevision, readRunRevision, restoreRevisionGraph, verifyRevisionCheckout, writeRunRevision, type RunRevision } from "../src/core/run-revision.ts";
import type { AttentionResolutionInput, ManagerReply } from "../src/shared/protocol.ts";

export interface RunRevisionHost {
	assert(record: RunRevision): void;
	settle(record: RunRevision): Promise<void>;
	observe(reply: ManagerReply): void;
	finished(result: { reply?: ManagerReply; abandoned?: true }, record: RunRevision): Promise<void>;
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
		const approved = await ctx.ui.confirm(decision === "abandon_run" ? "Abandon this entire Herder execution?" : "Approve this whole-run revision?", [
			`Request: ${record.request.requestId}`, `Run: ${record.run.runId}`, `Original base: ${record.run.baseCommit}`,
			`Exact graph: ${record.graphSha256}`, `Exact Markdown: ${record.inputSha256}`,
			"All workers will be settled before deleting every old execution worktree, branch, and proof. Your source checkout and branch will not be reset.",
			decision === "abandon_run" ? "Preserve plan Markdown. Do not restart any workers." : "Rerun every revised plan from TODO on the original base, with no selective reuse.",
		].join("\n\n"));
		host.assert(record);
		if (!approved) throw new Error("Confirmation dismissed: revision remains recoverable, old execution is intact, and no unchanged workers will restart. Refine the graph and call finish_edit again, or explicitly choose abandon_run.");
		record = await confirmRunRevision(record);
	}
	host.assert(record);
	await host.settle(record);
	host.assert(record);
	const result = await finishRunRevision(directory, editToken);
	await host.finished(result, record);
	return result;
}

export async function beginWholeRunAttention(directory: string, resolution: AttentionResolutionInput, ctx: Pick<ExtensionContext, "hasUI" | "ui">, host: RunRevisionHost): Promise<unknown> {
	const result = await invokeHerderTool("herder_plan", { operation: "attention", planDirectory: directory, ...resolution }) as { reply: ManagerReply };
	host.observe(result.reply);
	const record = readRunRevision(directory);
	if (!record || record.request.requestId !== resolution.requestId || record.request.requestSha256 !== resolution.requestSha256) throw new Error("Manager did not reserve the whole-run revision");
	host.assert(record);
	await host.settle(record);
	if (resolution.action === "abandon_run") return finishWholeRunEdit(directory, record.editToken, ctx, host, "abandon_run");
	return { ...result, editToken: record.editToken, scope: "whole-run plan-graph Markdown only", instructions: "Inspect the failure and propose concrete graph edits directly for user refinement. All IDs, dependencies, shared context, additions/removals, and previously integrated plans may change. Set every replacement plan TODO. Source code and runtime files are not writable. Call finish_edit with this editToken for final host confirmation; dismissal never abandons or retries." };
}

export async function cancelWholeRunEdit(directory: string, editToken: string, host: RunRevisionHost): Promise<unknown> {
	const record = readRunRevision(directory);
	if (!record || record.editToken !== editToken || !["draft", "prepared"].includes(record.state)) throw new Error("Only an unconfirmed whole-run draft can be restored");
	host.assert(record);
	await verifyRevisionCheckout(record);
	restoreRevisionGraph(record);
	const { graphSha256: _graph, inputSha256: _input, ...draft } = record;
	writeRunRevision(directory, { ...draft, state: "draft", decision: "revise_run" }, record);
	return { editToken, state: "draft", message: "Original Markdown restored; the whole-run revision remains open. No unchanged workers resume. Propose another revision or explicitly abandon_run." };
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
