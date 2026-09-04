import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { invokeHerderTool } from "../src/application/tools.ts";
import { parsePlanCommandArguments, type PlanCommandOptions } from "./arguments.ts";
import { resolvePlanDirectory, resolvePlanDirectoryTarget } from "./paths.ts";
import type { AttentionResolutionBinding } from "./attention.ts";

const PI_PLANNING_WORKFLOWS = [
	{ command: "herder-improve", skill: "improve", skillName: "herder-improve", mode: "session", description: "Audit this repository and shape verified findings into Herder plans." },
	{ command: "herder-simplify", skill: "simplify", skillName: "herder-simplify", mode: "session", description: "Find evidence-backed codebase reductions and shape them into Herder plans." },
	{ command: "herder-grill", skill: "grill", skillName: "herder-grill", mode: "session", description: "Clarify one objective and write a confirmed Herder plan graph." },
	{ command: "herder-validate", skill: "validate", skillName: "herder-validate", mode: "session", description: "Cold-review a Herder plan graph for Fire readiness." },
	{ command: "herder-plans", skill: "plans", skillName: "herder-plans", mode: "direct", description: "Run deterministic Herder plan graph operations." },
] as const;

type PiPlanningSkill = (typeof PI_PLANNING_WORKFLOWS)[number]["skill"];
type JsonObject = Record<string, any>;

interface PiPlanCommandExecution {
	request: PlanCommandOptions;
	result: unknown;
	message: string;
}

interface PreparedPlanningWorkflow {
	runtimeContext?: string;
	rollback?: () => Promise<void>;
}

interface PiPlanningManagerReplyContext {
	attentionAction?: string;
	planOperation?: "finish_edit" | "cancel_edit";
}

interface PiPlanningRuntime {
	assertMutationAllowed: () => void;
	bindAttention?: (input: { planDirectory: string; requestId?: string }) => AttentionResolutionBinding;
	prepareWorkflow?: (
		skill: PiPlanningSkill,
		argumentsText: string,
		ctx: ExtensionCommandContext,
	) => Promise<PreparedPlanningWorkflow>;
	beforePlanOperation?: (
		operation: string,
		params: { planDirectory: string; editToken?: string },
		ctx: ExtensionContext,
	) => Promise<{ handled: true; result: unknown } | undefined>;
	handleManagerReply?: (reply: unknown, context?: PiPlanningManagerReplyContext) => Promise<void>;
}

const planningWorkflowSchema = Type.Object({
	operation: StringEnum([
		"init", "validate", "shape", "status", "ready", "snapshot",
		"report", "track", "untrack", "begin_edit", "finish_edit", "cancel_edit", "attention",
	] as const),
	planDirectory: Type.String(),
	planId: Type.Optional(Type.String()),
	editToken: Type.Optional(Type.String()),
	track: Type.Optional(Type.Boolean()),
	requestId: Type.Optional(Type.String()),
	action: Type.Optional(Type.String()),
	answer: Type.Optional(Type.String()),
	rationale: Type.Optional(Type.String()),
}, { additionalProperties: false });

const retiredAttentionArguments = [
	"schemaVersion",
	"requestSha256",
	"capabilityToken",
	"runId",
	"generation",
	"round",
	"continuation",
	"git",
] as const;

function preparePlanningWorkflowArguments(input: unknown): Static<typeof planningWorkflowSchema> {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as Static<typeof planningWorkflowSchema>;
	const args = input as Record<string, unknown>;
	if (args.operation !== "attention") return args as Static<typeof planningWorkflowSchema>;
	const prepared = { ...args };
	for (const key of retiredAttentionArguments) delete prepared[key];
	return prepared as Static<typeof planningWorkflowSchema>;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function xmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function planningWorkflow(skill: PiPlanningSkill) {
	const workflow = PI_PLANNING_WORKFLOWS.find((candidate) => candidate.skill === skill);
	if (!workflow) throw new Error(`Unknown Herder planning skill: ${skill}`);
	return workflow;
}

export async function buildPlanningSkillPrompt(
	packageRoot: string,
	skill: PiPlanningSkill,
	argumentsText = "",
	runtimeContext = "",
): Promise<string> {
	const workflow = planningWorkflow(skill);
	const skillDirectory = path.join(packageRoot, "skills", skill);
	const skillFile = path.join(skillDirectory, "SKILL.md");
	const body = stripFrontmatter(await readFile(skillFile, "utf8")).trim();
	if (!body) throw new Error(`Herder Pi workflow ${skill} has no instructions.`);
	const block = `<skill name="${xmlAttribute(workflow.skillName)}" location="${xmlAttribute(skillFile)}">\nReferences are relative to ${skillDirectory}.\n\n${body}\n</skill>`;
	const sections = [block];
	if (runtimeContext.trim()) sections.push(`<herder-runtime>\n${runtimeContext.trim()}\n</herder-runtime>`);
	if (argumentsText.trim()) sections.push(argumentsText.trim());
	return sections.join("\n\n");
}

export async function launchPlanningWorkflow(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	ctx: ExtensionCommandContext,
	packageRoot: string,
	skill: PiPlanningSkill,
	argumentsText: string,
	prepareWorkflow?: PiPlanningRuntime["prepareWorkflow"],
): Promise<{ submitted: true }> {
	if (!ctx.isProjectTrusted()) throw new Error("Trust this project before starting a Herder planning workflow.");
	await ctx.waitForIdle();
	const prepared = await prepareWorkflow?.(skill, argumentsText, ctx) ?? {};
	try {
		const prompt = await buildPlanningSkillPrompt(packageRoot, skill, argumentsText, prepared.runtimeContext);
		pi.sendUserMessage(prompt);
		return { submitted: true };
	} catch (error) {
		await prepared.rollback?.().catch(() => {});
		throw error;
	}
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function list(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : [];
}

export function formatPlanCommandResult(request: PlanCommandOptions, value: unknown): string {
	const result = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
	if (request.operation === "init") {
		return `Herder plans initialized at ${result.planDir}. Tracking: ${result.tracking}.`;
	}
	if (request.operation === "track" || request.operation === "untrack") {
		const warning = result.warning ? `\n${result.warning}` : "";
		return `Herder plan tracking is ${result.tracking} for ${result.planDir}.${warning}`;
	}
	if (request.operation === "ready") {
		const ready = list(result.ready);
		const waiting = Array.isArray(result.waiting) ? result.waiting.length : 0;
		return `Herder readiness: ${ready.length ? ready.join(", ") : "no ready plans"} · ${list(result.inProgress).length} in progress · ${list(result.blocked).length} blocked · ${waiting} waiting${result.complete ? " · complete" : ""}.`;
	}
	if (request.operation === "shape") {
		const plans = Array.isArray(result.plans) ? result.plans : [];
		const issues = plans.reduce((total: number, plan: JsonObject) => total + (Array.isArray(plan.issues) ? plan.issues.length : 0), 0)
			+ (Array.isArray(result.contextIssues) ? result.contextIssues.length : 0);
		const unordered = Array.isArray(result.overlaps) ? result.overlaps.filter((overlap: JsonObject) => overlap.ordered === false).length : 0;
		return `Herder shape ${result.shapeReady ? "ready" : "not ready"}: ${plans.length} plans · ${issues} shape issues · ${unordered} unordered overlaps.`;
	}
	if (request.operation === "validate" || request.operation === "status") {
		const counts = result.counts as JsonObject | undefined;
		return `Herder graph valid: ${count(counts?.done)}/${count(counts?.total)} done · ${list(result.ready).length} ready · ${list(result.inProgress).length} in progress · ${list(result.blocked).length} blocked · ${Array.isArray(result.waiting) ? result.waiting.length : 0} waiting${result.shapeReady ? " · shape ready" : " · shape needs attention"}.`;
	}
	if (request.operation === "snapshot") {
		const plan = result.plan as JsonObject | undefined;
		return `Herder snapshot ${plan?.id ?? request.planId}: ${plan?.title ?? "untitled"} · sha256 ${result.snapshotSha256 ?? "unknown"}.`;
	}
	if (request.operation === "report") {
		const tokens = result.tokens as JsonObject | undefined;
		const timing = result.timing as JsonObject | undefined;
		const superseded = count(result.supersededAttempts);
		return `Herder report ${result.plan ?? request.planId}: ${count(result.attempts)} attempts · ${superseded} superseded · ${count(result.interruptions)} interruptions · ${count(tokens?.reportedInputOutput)} reported tokens · ${timing?.attemptDurationMs ?? "unknown"} ms attempt time.`;
	}
	return JSON.stringify(value, null, 2);
}

export async function executePiPlanCommand(
	argumentsText: string,
	repositoryRoot: string,
	assertMutationAllowed: () => void,
): Promise<PiPlanCommandExecution> {
	const request = parsePlanCommandArguments(argumentsText);
	if (["init", "track", "untrack"].includes(request.operation)) assertMutationAllowed();
	const planDirectory = request.operation === "init"
		? resolvePlanDirectoryTarget(repositoryRoot, request.planDir)
		: resolvePlanDirectory(repositoryRoot, request.planDir);
	const normalized = { ...request, planDir: planDirectory };
	const result = await invokeHerderTool("herder_plan", {
		operation: normalized.operation,
		planDirectory,
		...(normalized.planId ? { planId: normalized.planId } : {}),
		...(normalized.operation === "init" ? { track: normalized.track === true } : {}),
	});
	return { request: normalized, result, message: formatPlanCommandResult(normalized, result) };
}

export function registerPiPlanningWorkflows(
	pi: ExtensionAPI,
	packageRoot: string,
	repositoryRoot: (ctx: ExtensionContext) => Promise<string>,
	runtime: PiPlanningRuntime,
): void {
	for (const workflow of PI_PLANNING_WORKFLOWS.filter((candidate) => candidate.mode === "session")) {
		pi.registerCommand(workflow.command, {
			description: workflow.description,
			handler: async (args, ctx) => {
				try {
					await launchPlanningWorkflow(pi, ctx, packageRoot, workflow.skill, args, runtime.prepareWorkflow);
				} catch (error) {
					ctx.ui.notify(message(error), "error");
				}
			},
		});
	}

	const plans = PI_PLANNING_WORKFLOWS.find((workflow) => workflow.command === "herder-plans")!;
	pi.registerCommand(plans.command, {
		description: plans.description,
		handler: async (args, ctx) => {
			try {
				if (!ctx.isProjectTrusted()) throw new Error("Trust this project before using Herder plan operations.");
				const execution = await executePiPlanCommand(args, await repositoryRoot(ctx), runtime.assertMutationAllowed);
				ctx.ui.notify(execution.message, "info");
			} catch (error) {
				ctx.ui.notify(message(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "herder_plan",
		label: "Herder Plan",
		executionMode: "sequential",
		description: "Initialize, validate, shape, inspect, snapshot, report, coordinate a reserved Herder plan edit, or resolve one request-bound attention item.",
		parameters: planningWorkflowSchema,
		prepareArguments: preparePlanningWorkflowArguments,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) {
				return { content: [{ type: "text" as const, text: "Trust this project before using Herder plan operations." }], isError: true, details: {} };
			}
			try {
				if (["init", "track", "untrack"].includes(params.operation)) runtime.assertMutationAllowed();
				const repoRoot = await repositoryRoot(ctx);
				const planDirectory = params.operation === "init"
					? resolvePlanDirectoryTarget(repoRoot, params.planDirectory)
					: resolvePlanDirectory(repoRoot, params.planDirectory);
				const handled = params.operation === "finish_edit" || params.operation === "cancel_edit"
					? await runtime.beforePlanOperation?.(params.operation, { planDirectory, editToken: params.editToken }, ctx)
					: undefined;
				if (params.operation === "attention" && !runtime.bindAttention) {
					throw new Error("Herder attention submissions require an adapter-owned request binding.");
				}
				const attentionBinding = params.operation === "attention"
					? runtime.bindAttention!({ planDirectory, requestId: params.requestId })
					: undefined;
				const applicationParams = {
					operation: params.operation,
					planDirectory,
					...(params.operation === "attention" ? attentionBinding : {}),
					...(params.operation !== "attention" && params.planId !== undefined ? { planId: params.planId } : {}),
					...(params.operation !== "attention" && params.editToken !== undefined ? { editToken: params.editToken } : {}),
					...(params.operation !== "attention" && params.track !== undefined ? { track: params.track } : {}),
					...(params.operation !== "attention" && params.requestId !== undefined ? { requestId: params.requestId } : {}),
					...(params.action !== undefined ? { action: params.action } : {}),
					...(params.answer !== undefined ? { answer: params.answer } : {}),
					...(params.rationale !== undefined ? { rationale: params.rationale } : {}),
				};
				const result = handled?.result ?? await invokeHerderTool("herder_plan", applicationParams);
				if (!handled && result && typeof result === "object" && !Array.isArray(result)) {
					const reply = (result as JsonObject).reply;
					if (params.operation === "finish_edit" || params.operation === "cancel_edit") {
						await runtime.handleManagerReply?.(reply, { planOperation: params.operation });
					}
					if (params.operation === "attention") {
						await runtime.handleManagerReply?.(reply, {
							attentionAction: typeof params.action === "string" ? params.action : undefined,
						});
					}
				}
				return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { result } };
			} catch (error) {
				return { content: [{ type: "text" as const, text: message(error) }], isError: true, details: {} };
			}
		},
	});
}
