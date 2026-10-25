import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { THINKING_LEVELS } from "../agents/roles.ts";
import { GoalError, hashGoal, parseGoal } from "../artifacts/goal.ts";
import type { RunState } from "../journal/fold.ts";
import { readLock } from "../run/lock.ts";
import { AGENT_OPTION_KEYS, type AgentOptions, type DeliveryMode } from "../types.ts";
import { validateScript } from "../workflow/validate.ts";
import { DELIVERY_MODES } from "./commands.ts";
import { describeChecks, describeDelivery, describeIntegration, describeStep, describeVerification } from "./format.ts";
import { requireApproved, requireIdle, type Herder, type Held, type Session } from "./session.ts";
import { describeRun, isFinished, planTasks, runDetails } from "./status.ts";

const literals = <T extends string>(values: readonly T[], description?: string) =>
	Type.Union(values.map((value) => Type.Literal(value)), description ? { description } : {});
const text = (description: string) => Type.String({ minLength: 1, description });
const RUN_ID = Type.String({ pattern: "^\\d{8}-\\d{6}-[0-9a-f]{4}$", description: "Run id; default: the active run" });
const CHECK_IDS = (description: string) => Type.Array(Type.String({ minLength: 1 }), { description });

export const RunParameters = Type.Object({
	action: literals(["status", "approve_goal", "record_decision"] as const),
	runId: Type.Optional(RUN_ID),
	question: Type.Optional(text("record_decision: the question put to the user")),
	answer: Type.Optional(text("record_decision: the user's answer")),
});
export const WorkflowParameters = Type.Object({
	mode: literals(["validate", "run", "stop"] as const),
	script: Type.Optional(Type.String({ minLength: 1, description: "Script source (or use scriptPath)" })),
	scriptPath: Type.Optional(Type.String({ minLength: 1, description: "Path of a script file, relative to the cwd or absolute" })),
	args: Type.Optional(Type.Unknown({ description: "JSON value the script reads as `args`" })),
	resume: Type.Optional(Type.Integer({ minimum: 1, description: "run: replay this launch from its recorded start head; reuses its finished steps" })),
});
const STEP_OPTIONS = {
	id: Type.Optional(Type.String({ minLength: 1, description: "Stable step id (default: hash of role and prompt)" })),
	label: Type.Optional(Type.String({ minLength: 1 })),
	phase: Type.Optional(Type.String({ minLength: 1 })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Plan task id, e.g. T1" })),
	role: Type.Optional(Type.String({ minLength: 1, description: "Role name (default worker)" })),
	write: Type.Optional(Type.Boolean({ description: "Default from the role" })),
	base: Type.Optional(Type.String({ minLength: 1, description: "Commit-ish to start from (default: integration head)" })),
	schema: Type.Optional(Type.Object({}, { additionalProperties: true, description: "JSON Schema for structured output (result.data)" })),
	gate: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }))], { description: "goal.md check ids run in the step's worktree" })),
	fresh: Type.Optional(Type.Boolean({ description: "Ignore a recorded result and run again" })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	stallMs: Type.Optional(Type.Integer({ minimum: 1 })),
	effort: Type.Optional(literals(THINKING_LEVELS, "Thinking level override for this step")),
} satisfies Record<(typeof AGENT_OPTION_KEYS)[number], TSchema>;
export const StepParameters = Type.Object({ prompt: text("The step's task"), ...STEP_OPTIONS });
export const IntegrateParameters = Type.Object({
	source: text("Step key or commit to integrate"),
	message: text("Commit message of the integrated task"),
	task: Type.Optional(Type.String({ minLength: 1, description: "Plan task id" })),
	checks: Type.Optional(CHECK_IDS("Check ids to run before advancing (default: checks marked integrate)")),
});
export const CheckParameters = Type.Object({
	checks: Type.Optional(CHECK_IDS("Check ids (default: all)")),
	commit: Type.Optional(Type.String({ minLength: 1, description: "Commit-ish (default: integration head)" })),
});
export const VerifyParameters = Type.Object({});
export const DeliverParameters = Type.Object({
	mode: Type.Optional(literals(DELIVERY_MODES, "Default series")),
	curate: Type.Optional(Type.Boolean({ description: "Let a curator regroup the series first (kept only with an identical tree)" })),
});

const reply = <D>(content: string, details: D) => ({ content: [{ type: "text" as const, text: content }], details });

function checkIds(state: RunState, ids: readonly string[] | undefined): void {
	const known = new Set(state.goal?.checks.map((check) => check.id));
	const unknown = (ids ?? []).filter((id) => !known.has(id));
	if (unknown.length) throw new Error(`Unknown check id(s): ${unknown.join(", ")}. goal.md declares: ${[...known].join(", ") || "none"}.`);
}

function scriptSource(ctx: ExtensionContext, params: { script?: string; scriptPath?: string }): string {
	if ((params.script === undefined) === (params.scriptPath === undefined)) throw new Error("Pass exactly one of script or scriptPath.");
	if (params.script !== undefined) return params.script;
	const path = resolve(ctx.cwd, params.scriptPath!);
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read script ${path}: ${(error as Error).message}`);
	}
}

async function approveGoal(herder: Herder, s: Session, held: Held, ctx: ExtensionContext, signal: AbortSignal) {
	const state = held.run.state();
	if (isFinished(state)) throw new Error(`Herder run ${held.runId} is ${state.status}.`);
	if (!ctx.hasUI) throw new Error("approve_goal needs an interactive session (TUI or RPC) so the user can confirm the goal; it cannot be approved here.");
	const source = readFileSync(held.run.paths.goal, "utf8");
	let goal;
	try {
		goal = parseGoal(source);
	} catch (error) {
		if (!(error instanceof GoalError)) throw error;
		return reply(`goal.md is not valid yet; fix these problems and call approve_goal again:\n${error.problems.map((problem) => `- ${problem}`).join("\n")}`, { approved: false, problems: error.problems });
	}
	const sha256 = hashGoal(source);
	if (state.goal) {
		if (state.goal.sha256 === sha256) return reply("The goal is already approved.", { approved: true, sha256 });
		throw new Error("The goal is already approved and frozen, but goal.md changed since. Restore the approved text; a different goal needs a new run.");
	}
	const yes = await ctx.ui.confirm(`Approve Herder goal: ${goal.title}`, `${source.trim()}\n\nThe goal is frozen once approved.`, { signal });
	// An abort may have begun while the dialog was open; it must not end with an approved goal.
	if (held.closing || isFinished(held.run.state())) throw new Error(`Herder run ${held.runId} is being stopped.`);
	if (!yes) return reply("The user did not approve the goal. Ask what to change, revise goal.md, and call approve_goal again.", { approved: false });
	if (hashGoal(readFileSync(held.run.paths.goal, "utf8")) !== sha256) throw new Error("goal.md changed while the user was reviewing it; call approve_goal again.");
	held.run.journal.append({ t: "goal.approved", sha256, checks: goal.checks, approvedBy: "user" });
	held.run.renderProgress(planTasks(held.run));
	herder.refresh(s);
	return reply(`Goal approved (${goal.criteria.length} criteria, ${goal.checks.length} checks). Next: write plan.md (${held.run.paths.plan}) with task lines, then orchestrate.`, { approved: true, sha256, checks: goal.checks });
}

export function registerTools(pi: ExtensionAPI, herder: Herder): void {
	pi.registerTool({
		name: "herder_run", label: "Herder Run", executionMode: "sequential",
		description: "Herder run control. status: show the active run. approve_goal: validate goal.md and ask the user to approve it (interactive only). record_decision: journal a user decision (question, answer) made between launches.",
		parameters: RunParameters,
		async execute(_id, params, signal, _update, ctx) {
			const s = herder.session(ctx);
			if (params.action === "status") {
				const run = herder.peek(s, params.runId);
				if (!run) return reply("No Herder runs in this repository.", { runId: undefined });
				const state = run.state();
				const tasks = planTasks(run);
				return reply(describeRun(run, state, tasks, { lock: readLock(run.paths.lock), sessionId: herder.lockId(s), launch: s.held?.runId === run.runId ? s.held.launch?.launch : undefined, now: herder.now() }), runDetails(run, state, tasks));
			}
			const held = params.runId ? herder.hold(s, params.runId) : herder.current(s);
			if (params.action === "approve_goal") return herder.op(held, signal, (combined) => approveGoal(herder, s, held, ctx, combined), true);
			const question = params.question?.trim();
			const answer = params.answer?.trim();
			if (!question || !answer) throw new Error("record_decision needs a question and an answer.");
			if (isFinished(held.run.state())) throw new Error(`Herder run ${held.runId} is finished.`);
			held.run.journal.append({ t: "decision.recorded", question, answer });
			held.run.renderProgress(planTasks(held.run));
			return reply("Decision recorded.", { runId: held.runId, question, answer });
		},
	});

	pi.registerTool({
		name: "herder_workflow", label: "Herder Workflow", executionMode: "sequential",
		description: "Herder workflow scripts. validate: compile and dry-run a script without agents. run: launch it in the background; returns the launch number at once and a follow-up message reports the result (do not poll). stop: stop the running launch. Requires an approved goal.",
		parameters: WorkflowParameters,
		async execute(_id, params, _signal, _update, ctx) {
			const s = herder.session(ctx);
			const held = herder.current(s);
			// Stopping needs no approved goal: it must work even after goal.md changed.
			if (params.mode === "stop") {
				const launch = held.launch;
				if (!launch) throw new Error("No launch is running.");
				const outcome = await launch.stop("stopped by the main model", herder.stopWaitMs, "if-settled");
				if (!outcome) return reply(`Launch ${launch.launch} is stopping; a follow-up message will report its outcome.`, { launch: launch.launch, status: "stopping" });
				herder.settle(s, held);
				return reply(`Launch ${outcome.launch} ${outcome.status}: ${outcome.reused} reused, ${outcome.changed} changed, ${outcome.new} new.${outcome.error ? ` ${outcome.error}` : ""}`, outcome);
			}
			const state = requireApproved(held);
			const source = scriptSource(ctx, params);
			if (params.mode === "validate") {
				const report = await validateScript(source, { roles: herder.runtime(s, held).roles(), checks: state.goal!.checks.map((check) => check.id), args: params.args });
				const problems = report.problems.map((problem) => `- ${problem.severity}${problem.line ? ` at line ${problem.line}${problem.column ? `:${problem.column}` : ""}` : ""}: ${problem.message}`);
				return reply([report.ok ? "Script is valid." : "Script has errors.", ...problems, `Dry run: ${report.agentCalls} agent() and ${report.integrateCalls} integrate() calls. ${report.note}`].join("\n"), report);
			}
			if (params.resume !== undefined && !state.launches.has(params.resume)) throw new Error(`Launch ${params.resume} does not exist in run ${held.runId}.`);
			const launch = await herder.launch(s, held, { source, args: params.args, resume: params.resume });
			return reply(`Launch ${launch} started in the background${params.resume ? ` (resuming launch ${params.resume})` : ""}. A follow-up message will report its result; do not poll.`, { runId: held.runId, launch });
		},
	});

	pi.registerTool({
		name: "herder_step", label: "Herder Step", executionMode: "sequential",
		description: "Run one Herder agent() step directly, in its own worktree (for runs that need no script). Writing steps return a commit to pass to herder_integrate. Requires an approved goal.",
		parameters: StepParameters,
		async execute(_id, params, signal, _update, ctx) {
			const s = herder.session(ctx);
			const held = herder.current(s);
			const state = requireApproved(held);
			requireIdle(held, "A direct step");
			const { prompt, ...rest } = params;
			checkIds(state, typeof rest.gate === "string" ? [rest.gate] : rest.gate);
			const opts = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as AgentOptions;
			const result = await herder.op(held, signal, (combined) => herder.runtime(s, held).step(prompt, opts, combined));
			herder.refresh(s);
			return reply(describeStep(result), result);
		},
	});

	pi.registerTool({
		name: "herder_integrate", label: "Herder Integrate", executionMode: "sequential",
		description: "Integrate a step's commit onto the run's integration line (one commit per task). Runs integration checks first; conflicts and failing checks are returned, the head does not move. Requires an approved goal.",
		parameters: IntegrateParameters,
		async execute(_id, params, signal, _update, ctx) {
			const s = herder.session(ctx);
			const held = herder.current(s);
			const state = requireApproved(held);
			requireIdle(held, "A direct integration");
			checkIds(state, params.checks);
			const step = state.steps.get(params.source);
			if (step && !step.completed?.commit) throw new Error(`Step ${params.source} has no commit to integrate (status ${step.status}).`);
			const source = step?.completed?.commit ?? params.source;
			const opts = { message: params.message, ...(params.task ? { task: params.task } : {}), ...(params.checks ? { checks: params.checks } : {}) };
			const result = await herder.op(held, signal, (combined) => herder.runtime(s, held).integrate(source, opts, combined));
			herder.refresh(s);
			return reply(describeIntegration(result), result);
		},
	});

	pi.registerTool({
		name: "herder_check", label: "Herder Check", executionMode: "sequential",
		description: "Run goal.md checks at the integration head or a given commit. Requires an approved goal.",
		parameters: CheckParameters,
		async execute(_id, params, signal, _update, ctx) {
			const s = herder.session(ctx);
			const held = herder.current(s);
			checkIds(requireApproved(held), params.checks);
			// Beside a launch or a step is fine; not beside work that may finish or clean up the run.
			if (held.exclusive.size) throw new Error("A check waits until the running Herder tool call finishes.");
			const request = { ...(params.checks ? { checks: params.checks } : {}), ...(params.commit ? { commit: params.commit } : {}) };
			const results = await herder.op(held, signal, (combined) => herder.runtime(s, held).check(request, combined));
			return reply(describeChecks(results), { checks: results });
		},
	});

	pi.registerTool({
		name: "herder_verify", label: "Herder Verify", executionMode: "sequential",
		description: "Verify the run at its integration head: every check, plus a fresh verifier for non-trivial runs. The runtime computes the verdict (met, not_met, blocked); gaps are appended to plan.md. Requires an approved goal.",
		parameters: VerifyParameters,
		async execute(_id, _params, signal, _update, ctx) {
			const s = herder.session(ctx);
			const held = herder.current(s);
			requireApproved(held);
			requireIdle(held, "Verification");
			const outcome = await herder.op(held, signal, (combined) => herder.runtime(s, held).verify(combined), true);
			herder.refresh(s);
			return reply(describeVerification(outcome), outcome);
		},
	});

	pi.registerTool({
		name: "herder_deliver", label: "Herder Deliver", executionMode: "sequential",
		description: "Deliver a verified run (verdict met at the current head) to the user after their confirmation. Modes: series (default), branch, squash, uncommitted; curate regroups commits first. Interactive only.",
		parameters: DeliverParameters,
		async execute(_id, params, signal, _update, ctx) {
			const s = herder.session(ctx);
			if (!ctx.hasUI) throw new Error("herder_deliver needs an interactive session (TUI or RPC) so the user can confirm delivery.");
			const held = herder.current(s);
			const outcome = await herder.deliver(s, held, { mode: (params.mode ?? "series") as DeliveryMode, ...(params.curate ? { curate: true } : {}) }, signal);
			return reply(describeDelivery(outcome), outcome);
		},
	});
}
