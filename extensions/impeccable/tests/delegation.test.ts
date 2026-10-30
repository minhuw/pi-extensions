import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildDelegation, delegate } from "../src/delegation.ts";
import { getSkillDir } from "../src/resources.ts";

const request = { role: "documenter" as const, task: "Record only evidenced tokens for artifact src/page.tsx; boundary is this project, original request and actual answers: preserve the incumbent world.", artifactPaths: ["src/page.tsx"], contextPaths: ["PRODUCT.md", "DESIGN.md"] };
const text = (result: Awaited<ReturnType<typeof delegate>>) => result.content.map((part) => "text" in part ? part.text : "").join("\n");
function context(executeTool = vi.fn(), tools = [{ name: "Agent", parameters: {} }]) {
	return { cwd: "/project with spaces", executeTool, tools } as unknown as ExtensionToolContext;
}

describe("complete role delegation through Agent", () => {
	it.each([
		["asset-producer", "worker", 24], ["documenter", "worker", 30], ["finish-reviewer", "reviewer", 30], ["manual-edit-applier", "worker", 12],
	] as const)("loads the entire %s role with real resources and its ceiling", async (role, type, turns) => {
		const packet = await buildDelegation({ ...request, role }, "/project with spaces");
		const canonical = await readFile(packet.rolePath, "utf8");
		expect(packet.args.prompt).toContain(canonical.replaceAll("<skill-base-dir>", getSkillDir()));
		expect(packet.args.prompt).toContain(path.join(getSkillDir(), "scripts"));
		expect(packet.args.prompt).toContain("/project with spaces/src/page.tsx");
		expect(packet.args.prompt).toContain("/project with spaces/PRODUCT.md");
		expect(packet.args.prompt).toContain(request.task);
		expect(packet.args.prompt).not.toContain("<codex>");
		expect(packet.args).toMatchObject({ subagent_type: type, max_turns: turns, inherit_context: false, isolated: false, run_in_background: false });
		expect(packet.maxTurns).toBe(turns);
		expect(packet.args.prompt).toContain(`Hard task ceiling: ${turns} turns.`);
		for (const field of ["model", "thinking", "service_tier", "isolation", "schedule"]) expect(packet.args).not.toHaveProperty(field);
	});
	it("preserves browser and catalog URLs while resolving filesystem evidence paths", async () => {
		const packet = await buildDelegation({ ...request, role: "assessment-a", needsBrowser: true, artifactPaths: ["https://example.test/pricing?mode=dark"], contextPaths: ["https://example.test/quality-board.png", "captures/desktop.png"] }, "/project");
		expect(packet.args.prompt).toContain("https://example.test/pricing?mode=dark");
		expect(packet.args.prompt).toContain("https://example.test/quality-board.png");
		expect(packet.args.prompt).toContain("/project/captures/desktop.png");
		expect(packet.args.prompt).not.toContain("/project/https:");
	});
	it("issues separate fresh assessment requests without sibling output and uses worker for browser evidence", async () => {
		const execute = vi.fn().mockResolvedValue({ isError: false, result: { content: [{ type: "text", text: "sibling output MUST NOT ENTER OTHER PACKET" }], details: { status: "completed", agentId: "actual-child" } } });
		const ctx = context(execute);
		await Promise.all([delegate({ ...request, role: "assessment-a" }, ctx), delegate({ ...request, role: "assessment-b" }, ctx)]);
		expect(execute).toHaveBeenCalledTimes(2);
		const calls = execute.mock.calls.map((call) => call[1]);
		expect(calls.map((args) => args.subagent_type).sort()).toEqual(["reviewer", "worker"]);
		const completeCritique = await readFile(path.join(getSkillDir(), "reference/critique.md"), "utf8");
		for (const args of calls) {
			expect(args).toMatchObject({ inherit_context: false, isolated: false, run_in_background: false, max_turns: 30 });
			expect(args.prompt).toContain(completeCritique.replaceAll("<skill-base-dir>", getSkillDir()));
			expect(args.prompt).not.toContain("sibling output MUST NOT ENTER OTHER PACKET");
			expect(args).not.toHaveProperty("resume");
		}
		expect((await buildDelegation({ ...request, role: "assessment-a", needsBrowser: true }, ctx.cwd)).args.subagent_type).toBe("worker");
	});
	it("passes cancellation and updates to Agent and preserves the actual result details without double-counting usage", async () => {
		const controller = new AbortController();
		const update = vi.fn();
		const agent = { status: "completed", subagentType: "worker", agentId: "real-id", totalTokens: 123, maxTurns: 30 };
		const execute = vi.fn().mockResolvedValue({ isError: false, result: { content: [{ type: "text", text: "Actual files checked" }], details: agent, usage: { input: 123 } } });
		const result = await delegate(request, context(execute), controller.signal, update);
		expect(execute).toHaveBeenCalledWith("Agent", expect.anything(), { signal: expect.any(AbortSignal), onUpdate: expect.any(Function) });
		const options = execute.mock.calls[0]![2];
		options.onUpdate({ content: [], details: { status: "running", turnCount: 1 } });
		expect(update).toHaveBeenCalledWith({ content: [], details: { status: "running", turnCount: 1 } });
		controller.abort();
		expect(options.signal.aborted).toBe(true);
		expect(result.details).toMatchObject({ status: "completed", agent });
		expect(text(result)).toContain("Actual files checked");
		expect(result).not.toHaveProperty("usage");
	});
	it("returns an actionable main-session handoff when executeTool or callable Agent is unavailable", async () => {
		for (const ctx of [context(undefined, []), { ...context(), executeTool: undefined }]) {
			const result = await delegate(request, ctx as never);
			expect(result.details).toMatchObject({ status: "handoff", handoff: { tool: "Agent", arguments: { subagent_type: "worker", inherit_context: false } } });
			expect(text(result)).toContain("Complete adapted role");
			expect(text(result)).toContain("degraded/documenter.md");
		}
	});
	it("lets Agent validate the current fleet when its startup description omitted a now-enabled type", async () => {
		const execute = vi.fn().mockResolvedValue({ isError: false, result: { content: [], details: { status: "completed", subagentType: "worker", turnCount: 1 } } });
		const ctx = context(execute, [{ name: "Agent", parameters: { properties: { subagent_type: { description: "Available types: recon, reviewer. Custom types exist." } } } }]);
		expect((await delegate(request, ctx)).details.status).toBe("completed");
		expect(execute).toHaveBeenCalledOnce();
	});
	it("does not dispatch a type excluded by the actual schema enum", async () => {
		const execute = vi.fn();
		const ctx = context(execute, [{ name: "Agent", parameters: { properties: { subagent_type: { enum: ["recon", "reviewer"] } } } }]);
		const result = await delegate(request, ctx);
		expect(result.details.status).toBe("unavailable");
		expect(text(result)).toContain("schema excludes type worker");
		expect(execute).not.toHaveBeenCalled();
	});
	it.each([
		'Unknown or disabled agent type: "worker". Available: recon, reviewer.',
		'Unknown or disabled agent type: "worker". Default fallback "worker" is unknown or disabled. Available: reviewer.',
		'Unknown or disabled agent type: "worker". The configured fallbackSubagent "retired" is itself unknown or disabled. Available: (none).',
	])("returns the upstream fallback for a recognized pre-spawn refusal: %s", async (output) => {
		const result = await delegate(request, context(vi.fn().mockResolvedValue({ result: { content: [{ type: "text", text: output }], details: undefined } })));
		expect(result.details).toMatchObject({ status: "unavailable", inlineSubstitutionAllowed: true, fallbackPath: path.join(getSkillDir(), "reference/degraded/documenter.md") });
		expect(text(result)).toContain(output);
		expect(text(result)).toContain("Never label an inline review independent");
	});
	it.each(["progress", "details", "extra-content"])("does not infer a pre-spawn refusal when %s suggests a possible dispatch", async (kind) => {
		const refusal = { type: "text", text: 'Unknown or disabled agent type: "worker". Available: reviewer.' };
		const execute = vi.fn(async (_name, _args, options) => {
			if (kind === "progress") options.onUpdate({ content: [], details: { status: "running", turnCount: 1 } });
			return { result: { content: kind === "extra-content" ? [refusal, { type: "text", text: "Additional child output" }] : [refusal], details: kind === "details" ? {} : undefined } };
		});
		const result = await delegate(request, context(execute));
		expect(result.details).toMatchObject({ status: "unresolved", inlineSubstitutionAllowed: false });
		expect(result.details).not.toHaveProperty("fallbackPath");
	});
	it("keeps text-only outcomes unresolved after dispatch without authorizing inline work", async () => {
		for (const output of ['Unknown or disabled agent type: "reviewer". Available: worker.', 'Unknown or disabled agent type: "worker"', 'Unknown or disabled agent type: "worker". Available: reviewer.\nChild output', 'Successful nested role output', 'Nested agent started in background. Agent ID: nested-writer']) {
			const result = await delegate(request, context(vi.fn().mockResolvedValue({ result: { content: [{ type: "text", text: output }], details: undefined } })));
			expect(result.details).toMatchObject({ status: "unresolved", inlineSubstitutionAllowed: false });
			expect(text(result)).toContain(output);
			expect(text(result)).toContain("Do not substitute inline work");
			expect(result.details).not.toHaveProperty("fallbackPath");
		}
	});
	it.each([
		{ details: { status: "error" }, content: [{ type: "text", text: "Model unavailable after edit" }] },
		{ details: { status: "completed", subagentType: "worker" }, content: [{ type: "text", text: "Fallback worker edits" }] },
		{ details: { status: "steered", subagentType: "reviewer", tags: ["inherit context"] }, content: [] },
		{ details: { status: "completed", subagentType: "reviewer", tags: ["isolated"] }, content: [] },
		{ details: { status: "completed", subagentType: "reviewer", maxTurns: 100 }, content: [] },
	])("retains failed, substituted or policy-conflicting terminal review without replay: %j", async (agentResult) => {
		const execute = vi.fn().mockResolvedValue({ isError: false, result: agentResult });
		const result = await delegate({ ...request, role: "finish-reviewer" }, context(execute));
		expect(result.details).toMatchObject({ status: "partial", childTerminated: true, inlineSubstitutionAllowed: false, evidenceAssessmentRequired: true, agent: agentResult.details });
		expect(result).toMatchObject({ isError: true });
		expect(result.content.slice(1)).toEqual(agentResult.content);
		expect(text(result)).toContain("inspect the actual output and changed artifacts");
		expect(text(result)).toContain("only the remaining work after inspection");
		expect(text(result)).not.toContain("Follow ");
		expect(result.details).not.toHaveProperty("fallbackPath");
		expect(execute).toHaveBeenCalledOnce();
	});
	it.each(["completed", "steered", "error", "aborted", "stopped", "future-status"])("never authorizes replay after native status %s", async (status) => {
		const result = await delegate(request, context(vi.fn().mockResolvedValue({ result: { content: [{ type: "text", text: "Actual partial artifacts" }], details: { status, maxTurns: 1, turnCount: 2 } } })));
		expect(result.details).toMatchObject({ inlineSubstitutionAllowed: false, agent: { status } });
		expect(result.details.status).not.toBe("unavailable");
		expect(text(result)).toContain("Actual partial artifacts");
		expect(text(result)).not.toContain("Follow ");
		expect(result.details).not.toHaveProperty("fallbackPath");
		if (status === "future-status") expect(result.details.status).toBe("unresolved");
		if (status === "steered") expect(result.details).toMatchObject({ status: "wrapped-up", reason: "soft-limit-wrap-up", childTerminated: true });
		if (status === "aborted") expect(result.details).toMatchObject({ status: "cancelled", reason: "native-turn-limit-aborted" });
	});
	it.each(["outcome", "result"])("retains a native completed result with an %s error flag as partial", async (location) => {
		const result = await delegate(request, context(vi.fn().mockResolvedValue({ isError: location === "outcome", result: { isError: location === "result", content: [], details: { status: "completed" } } })));
		expect(result).toMatchObject({ isError: true, details: { status: "partial", nativeError: true, inlineSubstitutionAllowed: false } });
	});
	it("honors pre-dispatch and in-flight aborts", async () => {
		const execute = vi.fn();
		expect((await delegate(request, context(execute), AbortSignal.abort())).details.status).toBe("cancelled");
		expect(execute).not.toHaveBeenCalled();
		const controller = new AbortController();
		execute.mockImplementation(async (_name, _args, opts) => {
			expect(opts.signal.aborted).toBe(false);
			controller.abort();
			expect(opts.signal.aborted).toBe(true);
			throw new Error("aborted");
		});
		const result = await delegate(request, context(execute), controller.signal);
		expect(result.details.status).toBe("cancelled");
		expect(text(result)).not.toContain("completed.");
	});
	it.each(["asset-producer", "documenter", "manual-edit-applier"] as const)("preserves an independently user-stopped %s as cancellation before policy fallback", async (role) => {
		const caller = new AbortController();
		const agent = { status: "stopped", subagentType: "worker", turnCount: 2, tags: ["isolated"], maxTurns: 100 };
		const result = await delegate({ ...request, role }, context(vi.fn().mockResolvedValue({ result: { content: [{ type: "text", text: "Actual edits before user stop" }], details: agent } })), caller.signal);
		expect(caller.signal.aborted).toBe(false);
		expect(result.details).toMatchObject({ status: "cancelled", agent, inlineSubstitutionAllowed: false });
		expect(text(result)).toContain("Actual edits before user stop");
		expect(text(result)).toContain("stop this task and do not substitute inline work");
		expect(result.details).not.toHaveProperty("fallbackPath");
	});
	it.each([1, 12])("accepts a configured soft limit of %s within the role budget without premature cancellation", async (maxTurns) => {
		const status = maxTurns === 1 ? "steered" : "completed";
		const execute = vi.fn(async (_name, args, options) => {
			expect(args.max_turns).toBe(12);
			options.onUpdate({ content: [], details: { status: "running", maxTurns, turnCount: 1 } });
			expect(options.signal.aborted).toBe(false);
			return { result: { content: [{ type: "text", text: "Actual output" }], details: { status, maxTurns, turnCount: 2 } } };
		});
		const result = await delegate({ ...request, role: "manual-edit-applier" }, context(execute));
		expect(result.details).toMatchObject({ status: maxTurns === 1 ? "wrapped-up" : "completed", policyConflicts: [], inlineSubstitutionAllowed: false });
		expect(result).toMatchObject({ isError: false });
		expect(text(result)).toContain("Actual output");
		if (maxTurns === 1) expect(text(result)).toContain("needs evidence assessment and may be partial");
	});
	it("keeps an exception after dispatch unresolved rather than authorizing duplicate writes", async () => {
		const result = await delegate(request, context(vi.fn().mockRejectedValue(new Error("transport lost"))));
		expect(result.details).toMatchObject({ status: "unresolved", inlineSubstitutionAllowed: false });
		expect(text(result)).toContain("Child termination is unestablished");
		expect(result.details).not.toHaveProperty("fallbackPath");
	});
	it.each([false, true])("treats a manual-edit-applier final answer on turn 12 conservatively when progress=%s", async (progress) => {
		const output = '{"status":"done","files":["src/page.tsx"]}';
		const execute = vi.fn(async (_name, _args, options) => {
			if (progress) {
				for (const turnCount of [11, 12, 12]) {
					options.onUpdate({ content: [], details: { status: "running", turnCount } });
					expect(options.signal.aborted).toBe(turnCount >= 12);
				}
			}
			return { isError: false, result: { content: [{ type: "text", text: output }], details: { status: "completed", subagentType: "worker", turnCount: 12 } } };
		});
		const result = await delegate({ ...request, role: "manual-edit-applier" }, context(execute));
		expect(result.details).toMatchObject({ status: progress ? "cancelled" : "partial", agent: { status: "completed", turnCount: 12 } });
		expect(result).toMatchObject({ isError: false });
		expect(text(result)).toContain(output);
		if (progress) expect(result.details).toMatchObject({ reason: "turn-boundary-reached", inlineSubstitutionAllowed: false });
	});
	it.each([false, true])("cancels at the role boundary and retains partial output, Agent throws=%s", async (throws) => {
		const execute = vi.fn(async (_name, _args, options) => {
			options.onUpdate({ content: [{ type: "text", text: "Actual partial edits" }], details: { status: "running", turnCount: 12 } });
			expect(options.signal.aborted).toBe(true);
			if (throws) throw new Error("boundary cancellation transport lost");
			// Even a stale completed status cannot erase the boundary cancellation.
			return { result: { content: [{ type: "text", text: "Actual partial edits" }], details: { status: "completed", subagentType: "worker", turnCount: 12 } } };
		});
		const result = await delegate({ ...request, role: "manual-edit-applier" }, context(execute));
		expect(result.details).toMatchObject({ status: throws ? "unresolved" : "cancelled", reason: "turn-boundary-reached", inlineSubstitutionAllowed: false });
		expect(text(result)).toContain("boundary of 12 turns reached");
		expect(text(result)).not.toContain("Impeccable manual-edit-applier: completed");
		expect(text(result)).toContain("Actual partial edits");
		if (throws) expect(text(result)).toContain("Child termination is unestablished");
	});
	it("keeps caller cancellation distinct from an in-budget terminal result", async () => {
		const caller = new AbortController();
		const execute = vi.fn(async (_name, _args, options) => {
			options.onUpdate({ content: [], details: { status: "running", turnCount: 11 } });
			expect(options.signal.aborted).toBe(false);
			caller.abort();
			expect(options.signal.aborted).toBe(true);
			return { result: { content: [{ type: "text", text: "Actual output during cancellation" }], details: { status: "completed", subagentType: "worker", turnCount: 12 } } };
		});
		const result = await delegate({ ...request, role: "manual-edit-applier" }, context(execute), caller.signal);
		expect(result.details.status).toBe("cancelled");
		expect(text(result)).toContain("Retain actual partial output");
		expect(text(result)).not.toContain("Verify evidence and effective Agent policies");
		expect(text(result)).not.toContain("ceiling of");
	});
	it.each([
		[{ tags: ["inherit context"] }, "partial"],
		[{ tags: ["isolated"] }, "partial"],
		[{ tags: ["worktree"] }, "partial"],
		[{ maxTurns: 100 }, "partial"],
		[{ turnCount: 31 }, "cancelled"],
	] as const)("stops promptly on reported Agent policy conflicts or an exceeded role ceiling: %j", async (details, expected) => {
		const execute = vi.fn(async (_name, _args, options) => {
			options.onUpdate({ content: [], details: { status: "running", ...details } });
			expect(options.signal.aborted).toBe(true);
			return { isError: false, result: { content: [{ type: "text", text: "Actual partial output" }], details: { status: "aborted" } } };
		});
		const result = await delegate(request, context(execute));
		expect(result.details.status).toBe(expected);
		expect(text(result)).toContain("Actual partial output");
	});
	it.each([false, true])("retains a configured background child as active, including caller cancellation=%s", async (cancelCaller) => {
		const controller = new AbortController();
		const details = { status: "background", subagentType: "worker", agentId: "detached-writer", tags: ["background"] };
		const execute = vi.fn(async (_name, _args, _options) => {
			if (cancelCaller) controller.abort();
			return { isError: false, result: { content: [{ type: "text", text: "Actual detached child response" }], details } };
		});
		const ctx = context(execute, [{ name: "Agent", parameters: {} }, { name: "get_subagent_result", parameters: {} }]);
		const result = await delegate(request, ctx, controller.signal);
		expect(result.details).toMatchObject({ status: "active", agent: details, agentId: "detached-writer", callerCancelled: cancelCaller, callerCancellationStopsChild: false, inlineSubstitutionAllowed: false, handoff: { tool: "get_subagent_result", arguments: { agent_id: "detached-writer", wait: true } } });
		expect(text(result)).toContain("Do not perform inline substitution");
		expect(text(result)).toContain("Actual detached child response");
		expect(text(result)).not.toContain("Follow ");
		expect(result.details).not.toHaveProperty("fallbackPath");
		expect(execute).toHaveBeenCalledOnce();
	});
	it("provides a management UI handoff when result retrieval is not callable and preserves a missing ID limitation", async () => {
		const result = await delegate(request, context(vi.fn().mockResolvedValue({ result: { content: [], details: { status: "background" } } })));
		expect(result.details.status).toBe("active");
		expect(text(result)).toContain("ID missing; locate it in /agents");
		expect(result.details).not.toHaveProperty("handoff");
	});
	it("does not dispatch a continuation without an enforceable progress channel", async () => {
		const execute = vi.fn();
		const result = await delegate({ ...request, role: "finish-reviewer", resume: "actual-reviewer" }, context(execute));
		expect(result.details).toMatchObject({ status: "handoff", reason: "continuation-limit-unenforceable", handoff: { tool: "Agent", arguments: { resume: "actual-reviewer", max_turns: 30 } } });
		expect(text(result)).toContain("was not dispatched");
		expect(text(result)).toContain("inspect the stored reviewer's effective policies");
		expect(execute).not.toHaveBeenCalled();
	});
	it("rejects an actual over-budget final result even when no progress was emitted", async () => {
		const result = await delegate({ ...request, role: "finish-reviewer" }, context(vi.fn().mockResolvedValue({ result: { content: [{ type: "text", text: "Over-budget verdict" }], details: { status: "completed", subagentType: "reviewer", turnCount: 40 } } })));
		expect(result.details).toMatchObject({ status: "partial", inlineSubstitutionAllowed: false, reason: "turn-boundary-reached" });
		expect(result.details).not.toHaveProperty("fallbackPath");
		expect(text(result)).toContain("actual turn count 40 exceeds role ceiling 30");
		expect(text(result)).toContain("Over-budget verdict");
	});
	it("allows only finish verdict continuation to resume", async () => {
		expect((await buildDelegation({ ...request, role: "finish-reviewer", resume: "actual-reviewer" }, "/project")).args.resume).toBe("actual-reviewer");
		await expect(buildDelegation({ ...request, role: "assessment-a", resume: "a" }, "/project")).rejects.toThrow("separate fresh contexts");
	});
});
