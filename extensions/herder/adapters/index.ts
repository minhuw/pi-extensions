import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ManagerReply, TerminalEvent, VerificationRequest } from "../src/shared/protocol.ts";
import {
	invokeHerderTool,
	submitHerderVerification,
	waitHerderOperation,
} from "../src/application/tools.ts";
import { parseFireArguments, parseGrillPlanTarget, parsePlanDirArguments, type FireOptions } from "./arguments.ts";
import {
	activeModelMatches,
	loadPiProfile,
	unavailableProfileModels,
	type ResolvedPiProfile,
} from "./profile.ts";
import { HERDER_STATE_ENTRY, restoreLastRun, sameHerderRunState, type HerderRunState } from "./state.ts";
import { resolvePlanDirectory } from "./paths.ts";
import { registerPiPlanningWorkflows } from "./planning-workflows.ts";
import { validateHerderRoleAgents } from "./role-config.ts";
import { interruptedPiWorkers } from "./recovery.ts";
import { DefaultPiWorkerSessionFactory, PiWorkerEngine, type PiWorkerTerminal } from "./worker-engine.ts";
import { HerderWidget } from "./worker-fleet.ts";
import {
	createWorkerInputEntry,
	createWorkerOutputEntry,
	HERDER_WORKER_INPUT_ENTRY,
	HERDER_WORKER_OUTPUT_ENTRY,
	registerWorkerTranscriptRenderers,
	type HerderWorkerInputEntry,
} from "./worker-transcript.ts";

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_ROOT, "..");
const PROFILE_CATALOG = path.join(PACKAGE_ROOT, "assets/profiles/profiles.json");
const PI_AGENT_ROOT = path.join(PACKAGE_ROOT, "assets/roles/pi");
interface PlanSummary {
	counts?: { total?: number; done?: number; rejected?: number; actionable?: number };
	inProgress?: number;
	blocked?: number;
}

interface WorkerBinding {
	actionId: string;
	handle: string;
	managerRunId: string;
	planDir: string;
	transcript?: HerderWorkerInputEntry;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function activeModelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function summaryLine(summary: PlanSummary | undefined): string | undefined {
	if (!summary?.counts || typeof summary.counts.total !== "number") return undefined;
	return `${summary.counts.done ?? 0}/${summary.counts.total} done · ${summary.inProgress ?? 0} in progress · ${summary.counts.rejected ?? 0} rejected`;
}

function unwrapReply(value: Record<string, unknown>): ManagerReply {
	const reply = value.reply;
	if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Herder service returned no manager reply.");
	return reply as unknown as ManagerReply;
}

function toolResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}), details: {} };
}

export default function registerHerderPi(pi: ExtensionAPI): void {
	registerWorkerTranscriptRenderers(pi);
	const sessionFactory = new DefaultPiWorkerSessionFactory(PI_AGENT_ROOT);
	const engine = new PiWorkerEngine(sessionFactory);
	const widget = new HerderWidget();
	const workers = new Map<string, WorkerBinding>();
	let currentState: HerderRunState | undefined;
	let lastPersistedState: HerderRunState | undefined;
	let lastContext: ExtensionContext | undefined;
	let lastSummary: PlanSummary | undefined;
	let managerQueue = Promise.resolve();
	let sessionEpoch = 0;
	const verificationRequests = new Map<string, VerificationRequest>();
	const promptedVerifications = new Set<string>();
	const verificationMonitors = new Set<string>();

	const persist = (state: HerderRunState) => {
		currentState = state;
		if (lastPersistedState && sameHerderRunState(lastPersistedState, state)) return;
		try {
			pi.appendEntry(HERDER_STATE_ENTRY, state);
			lastPersistedState = state;
		} catch { /* The durable manager remains authoritative; retry on the next reply. */ }
	};

	const appendWorkerEntry = <T>(customType: string, data: T): void => {
		if (!lastContext) return;
		try { pi.appendEntry(customType, data); }
		catch { /* Transcript rendering is best-effort and must never block manager progress. */ }
	};

	const render = (ctx = lastContext) => {
		if (!ctx?.hasUI) return;
		if (!currentState) {
			ctx.ui.setStatus("herder", undefined);
			widget.update(ctx, undefined);
			return;
		}
		const statusColor = currentState.status === "complete"
			? "success"
			: currentState.status === "failed"
				? "error"
				: ["needs_input", "paused"].includes(currentState.status)
					? "warning"
					: "accent";
		ctx.ui.setStatus("herder", ctx.ui.theme.fg(statusColor, `Herder ${currentState.status}`));
		const summary = summaryLine(lastSummary);
		widget.update(ctx, {
			status: currentState.status,
			profile: currentState.profile,
			maxParallel: currentState.maxParallel,
			planName: path.basename(currentState.planDir),
			...(summary ? { summaryLine: summary } : {}),
			...(currentState.dashboardUrl ? { dashboardUrl: currentState.dashboardUrl } : {}),
			workers: engine.snapshots(),
		});
	};

	const renderLaunching = (ctx: ExtensionContext, planDir: string, profile: string, maxParallel: number) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("herder", ctx.ui.theme.fg("accent", "Herder initializing"));
		widget.update(ctx, {
			status: "initializing",
			profile,
			maxParallel,
			planName: path.basename(planDir),
			workers: [],
		});
	};

	const repositoryRoot = async (ctx: ExtensionContext): Promise<string> => {
		const result = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
		if (result.code !== 0 || !result.stdout.trim()) throw new Error("Herder requires a Git worktree.");
		return path.resolve(result.stdout.trim());
	};

	const resolveProfile = async (ctx: ExtensionContext, requested?: string): Promise<ResolvedPiProfile> => {
		const profile = await loadPiProfile(PROFILE_CATALOG, requested);
		const unavailable = unavailableProfileModels(profile, ctx.modelRegistry.getAvailable());
		if (unavailable.length) throw new Error(`Profile ${profile.profile} cannot start because Pi has no available model matching: ${unavailable.join(", ")}.`);
		if (!activeModelMatches(profile, ctx.model) || ctx.thinkingLevel !== profile.orchestrator.effort) {
			throw new Error(`Profile ${profile.profile} requires root ${profile.orchestrator.model}:${profile.orchestrator.effort}; current Pi model is ${activeModelLabel(ctx)}:${ctx.thinkingLevel || "unknown"}.`);
		}
		return profile;
	};

	const preflight = async (_ctx: ExtensionContext, profile: ResolvedPiProfile) => {
		sessionFactory.bindModelRegistry(_ctx.modelRegistry);
		await validateHerderRoleAgents(PI_AGENT_ROOT, profile, await engine.availableModels());
	};

	const delegateVerification = (reply: ManagerReply) => {
		const request = reply.verificationRequest;
		if (!request) return;
		verificationRequests.set(request.requestId, request);
		if ((reply.operations ?? []).some((operation) => operation.kind === "verification" && operation.operationId.startsWith(`verification:${request.requestId}:`))) return;
		if (promptedVerifications.has(request.requestId) || !lastContext) return;
		promptedVerifications.add(request.requestId);
		const prompt = [
			"HERDER_MAIN_SESSION_VERIFICATION_V1",
			"Herder has finished integrating the ordinary plans and needs this main Pi session to select final verification semantically.",
			"Inspect the exact frozen integration worktree and assignment below. You may use read-only inspection commands, but do not edit files, move Git refs, update Herder state, or execute the verification commands yourself.",
			"Choose the smallest non-redundant set of commands that adequately verifies the integrated change. Distinguish setup/examples from actual checks; prefer one comprehensive check over duplicated focused checks when it subsumes them.",
			"Represent every command as direct argv. Use [\"/bin/sh\", \"-lc\", \"...\"] only when shell syntax is genuinely required.",
			"As your final action, call herder_verification exactly once. Do not provide a prose-only answer.",
			`REQUEST_ID: ${request.requestId}`,
			`REQUEST_SHA256: ${request.requestSha256}`,
			`RUN_ID: ${request.runId}`,
			`PLAN_DIRECTORY: ${reply.planDirectory}`,
			`GENERATION: ${request.generation}`,
			`GRAPH_SHA256: ${request.graphSha256}`,
			`RUN_ASSIGNMENT: ${request.runAssignmentPath}`,
			`RUN_ASSIGNMENT_SHA256: ${request.runAssignmentSha256}`,
			`INTEGRATION_WORKTREE: ${request.integrationWorktree}`,
			`INTEGRATION_BRANCH: ${request.integrationBranch}`,
			`INTEGRATION_HEAD: ${request.integrationHead}`,
			`INTEGRATION_TREE: ${request.integrationTree}`,
		].join("\n");
		try {
			if (lastContext.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (error) {
			promptedVerifications.delete(request.requestId);
			lastContext.ui.notify(`Herder could not delegate final verification: ${message(error)}`, "warning");
		}
	};

	const updateFromReply = (reply: ManagerReply, profile?: string, mode?: "fire" | "resume" | "revise") => {
		if (reply.status === "idle") {
			currentState = undefined;
			lastSummary = undefined;
			verificationRequests.clear();
			promptedVerifications.clear();
			render();
			return;
		}
		const previous = currentState;
		const now = Date.now();
		persist({
			version: 1,
			mode: mode ?? previous?.mode ?? "resume",
			status: reply.status,
			runId: reply.runId,
			repoRoot: previous?.repoRoot ?? "",
			planDir: reply.planDirectory,
			profile: profile ?? previous?.profile ?? "unknown",
			maxParallel: reply.maxParallel,
			dashboardEnabled: true,
			startedAt: previous?.startedAt ?? now,
			updatedAt: now,
			...(reply.dashboardUrl ? { dashboardUrl: reply.dashboardUrl } : {}),
		});
		lastSummary = {
			counts: { total: reply.summary.total, done: reply.summary.done, rejected: reply.summary.rejected },
			inProgress: reply.summary.inProgress,
		};
		for (const operation of reply.operations ?? []) {
			if (operation.kind !== "verification" || !["accepted", "running"].includes(operation.state)) continue;
			monitorVerification(operation.operationId, { planDirectory: reply.planDirectory, operationId: operation.operationId });
		}
		for (const active of reply.active) {
			if (!active.hostHandle || !engine.has(active.hostHandle) || workers.has(active.hostHandle)) continue;
			workers.set(active.hostHandle, { actionId: active.actionId, handle: active.hostHandle, managerRunId: reply.runId, planDir: reply.planDirectory });
		}
		render();
		delegateVerification(reply);
	};

	const postEvent = async (planDir: string, input: unknown): Promise<ManagerReply> => {
		const event = input as Record<string, unknown>;
		return unwrapReply(await invokeHerderTool("herder_submit", { planDirectory: planDir, ...event }) as Record<string, unknown>);
	};

	const managerTransportRetriable = (error: unknown): boolean => {
		if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") return true;
		const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
		if (cause && typeof cause.code === "string" && ["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(cause.code)) return true;
		return message(error).includes("fetch failed");
	};

	// The manager dedupes events by eventId, so resending the identical payload after a
	// client-side abort or connection drop is safe and recovers replies that would
	// otherwise be lost (a lost reply can strand proposed dispatches forever).
	const postEventReliable = async (planDir: string, input: unknown): Promise<ManagerReply> => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 6; attempt += 1) {
			try { return await postEvent(planDir, input); }
			catch (error) {
				lastError = error;
				if (!managerTransportRetriable(error) || attempt === 5) throw error;
				await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 500)));
			}
		}
		throw lastError;
	};

	const enqueueManager = <T>(task: () => Promise<T>): Promise<T> => {
		const next = managerQueue.then(task, task);
		managerQueue = next.then(() => undefined, () => undefined);
		return next;
	};

	const dispatchReply = async (initial: ManagerReply): Promise<ManagerReply> => {
		let reply = initial;
		while (reply.actions.length > 0 && reply.status === "running") {
			const results = [];
			const prepared: string[] = [];
			for (const action of reply.actions) {
				try {
					const handle = await engine.prepare({ action, planDirectory: reply.planDirectory });
					prepared.push(handle);
					workers.set(handle, {
						actionId: action.actionId,
						handle,
						managerRunId: reply.runId,
						planDir: reply.planDirectory,
						transcript: createWorkerInputEntry(action, handle),
					});
					results.push({ actionId: action.actionId, accepted: true, hostHandle: handle });
				} catch (error) {
					results.push({ actionId: action.actionId, accepted: false, error: message(error) });
				}
			}
			try {
				reply = await postEventReliable(reply.planDirectory, { eventId: randomUUID(), kind: "dispatch_results", dispatchResults: results });
			} catch (error) {
				for (const handle of prepared) {
					workers.delete(handle);
					await engine.discard(handle);
				}
				throw error;
			}
			for (const handle of prepared) {
				const binding = workers.get(handle);
				if (binding?.transcript) appendWorkerEntry(HERDER_WORKER_INPUT_ENTRY, binding.transcript);
				engine.start(handle);
			}
			updateFromReply(reply);
		}
		return reply;
	};

	function monitorVerification(operationId: string, pending: Awaited<ReturnType<typeof submitHerderVerification>>): void {
		if (verificationMonitors.has(operationId)) return;
		verificationMonitors.add(operationId);
		const epoch = sessionEpoch;
		void waitHerderOperation(pending).then((value) => {
			if (epoch !== sessionEpoch) return;
			return enqueueManager(async () => {
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Verification operation returned no manager reply");
				const reply = value as ManagerReply;
				updateFromReply(reply);
				await dispatchReply(reply);
			});
		}).catch((error) => lastContext?.ui.notify(`Herder verification handling failed: ${message(error)}`, "error"))
			.finally(() => verificationMonitors.delete(operationId));
	}

	const launch = async (options: FireOptions, ctx: ExtensionContext): Promise<string> => {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before starting Herder.");
		const repoRoot = await repositoryRoot(ctx);
		const planDir = resolvePlanDirectory(repoRoot, options.planDir);
		if (!existsSync(path.join(planDir, "README.md"))) throw new Error(`Herder plan index is missing: ${path.join(planDir, "README.md")}`);
		const profile = await resolveProfile(ctx, options.profile || (options.mode === "resume" ? currentState?.profile : undefined));
		renderLaunching(ctx, planDir, profile.profile, options.maxParallel ?? currentState?.maxParallel ?? 5);
		try {
			await preflight(ctx, profile);
			const reply = unwrapReply(await invokeHerderTool("herder_run", {
				operation: options.mode,
				repositoryRoot: repoRoot,
				planDirectory: planDir,
				profile: profile.profile,
				...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
				dashboardPort: options.dashboardPort,
			}) as Record<string, unknown>);
			if (reply.status === "idle") throw new Error("Herder manager did not create a run.");
			const now = Date.now();
			persist({
				version: 1,
				mode: options.mode,
				status: reply.status,
				runId: reply.runId,
				repoRoot,
				planDir,
				profile: profile.profile,
				maxParallel: reply.maxParallel,
				dashboardEnabled: true,
				startedAt: now,
				updatedAt: now,
				...(reply.dashboardUrl ? { dashboardUrl: reply.dashboardUrl } : {}),
			});
			lastSummary = {
				counts: { total: reply.summary.total, done: reply.summary.done, rejected: reply.summary.rejected },
				inProgress: reply.summary.inProgress,
			};
			// Paint the authoritative run state before preparing the first worker batch;
			// creating several clean Pi sessions can take long enough to look unresponsive.
			render(ctx);
			await enqueueManager(() => dispatchReply(reply));
			return `Herder ${options.mode} started with deterministic manager ${reply.runId}, profile ${profile.profile}, and max parallel ${reply.maxParallel}. Dashboard: ${reply.dashboardUrl || "unavailable"}`;
		} catch (error) {
			render(ctx);
			throw error;
		}
	};

	const status = async (planDirInput: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = planDirInput
			? resolvePlanDirectory(repoRoot, planDirInput)
			: currentState?.planDir ?? resolvePlanDirectory(repoRoot, "herder-plans");
		const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory: planDir }) as Record<string, unknown>);
		updateFromReply(reply);
		render(ctx);
		return `${reply.status.toUpperCase()} · ${reply.message}${reply.dashboardUrl ? `\nDashboard: ${reply.dashboardUrl}` : ""}`;
	};

	const dashboard = async (planDirInput: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = planDirInput
			? resolvePlanDirectory(repoRoot, planDirInput)
			: currentState?.planDir ?? resolvePlanDirectory(repoRoot, "herder-plans");
		const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory: planDir }) as Record<string, unknown>);
		return `Herder dashboard: ${reply.dashboardUrl || "unavailable"}`;
	};

	const stop = async (): Promise<string> => {
		if (!currentState) return "No active Herder run.";
		return enqueueManager(async () => {
			let reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "stop", planDirectory: currentState!.planDir }) as Record<string, unknown>);
			const active = [...workers.values()];
			for (const worker of active) {
				if (worker.transcript) appendWorkerEntry(HERDER_WORKER_OUTPUT_ENTRY, createWorkerOutputEntry(worker.transcript, {
					actionId: worker.actionId,
					hostHandle: worker.handle,
					interrupted: true,
					error: "Pi user requested Herder stop",
				}));
			}
			workers.clear();
			await Promise.all(active.map((worker) => engine.stop(worker.handle).catch(() => {})));
			const interrupted: TerminalEvent[] = active.map((worker) => ({
				actionId: worker.actionId,
				hostHandle: worker.handle,
				interrupted: true,
				error: "Pi user requested Herder stop",
			}));
			if (interrupted.length > 0) {
				reply = await postEventReliable(currentState!.planDir, { eventId: randomUUID(), kind: "terminals", terminals: interrupted });
			}
			updateFromReply(reply);
			return `Stop requested for Herder run ${reply.runId}. Repository state was preserved.`;
		});
	};

	const command = (handler: (args: string, ctx: ExtensionContext) => Promise<string>) => async (args: string, ctx: ExtensionContext) => {
		lastContext = ctx;
		try { ctx.ui.notify(await handler(args, ctx), "info"); }
		catch (error) { ctx.ui.notify(message(error), "error"); }
	};

	pi.registerCommand("herder-fire", { description: "Start a deterministic background Herder run.", handler: command((args, ctx) => launch(parseFireArguments(args, "fire"), ctx)) });
	pi.registerCommand("herder-resume", { description: "Resume a deterministic Herder run.", handler: command((args, ctx) => launch(parseFireArguments(args, "resume"), ctx)) });
	pi.registerCommand("herder-revise", { description: "Adopt a validated new plan-graph generation.", handler: command((args, ctx) => launch(parseFireArguments(args, "revise"), ctx)) });
	pi.registerCommand("herder-status", { description: "Show Herder manager and plan status.", handler: command((args, ctx) => status(parsePlanDirArguments(args).planDir, ctx)) });
	pi.registerCommand("herder-dashboard", { description: "Open the manager-hosted Herder dashboard.", handler: command((args, ctx) => dashboard(parsePlanDirArguments(args).planDir, ctx)) });
	pi.registerCommand("herder-stop", {
		description: "Stop active Herder workers and preserve repository state.",
		handler: async (_args, ctx) => {
			lastContext = ctx;
			if (ctx.hasUI && !(await ctx.ui.confirm("Stop Herder?", "Active workers will stop; repository state remains preserved."))) return;
			try { ctx.ui.notify(await stop(), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	const activeFire = () => Boolean(currentState && !["complete", "failed", "stopped"].includes(currentState.status)) || workers.size > 0 || engine.snapshots().length > 0;
	registerPiPlanningWorkflows(pi, PACKAGE_ROOT, repositoryRoot, {
		assertMutationAllowed: () => {
			if (activeFire()) throw new Error("Finish or stop the active Herder Fire run before changing plan configuration.");
		},
		prepareWorkflow: async (skill, args, ctx) => {
			if (!activeFire()) return {};
			if (skill !== "grill") throw new Error("Only /herder-grill --plan <unstarted-plan> may run while Herder Fire is active.");
			const target = parseGrillPlanTarget(args);
			if (!target) throw new Error("Active Herder Fire requires /herder-grill --plan <unstarted-plan>.");
			const repoRoot = await repositoryRoot(ctx);
			const planDir = resolvePlanDirectory(repoRoot, target.planDir ?? currentState?.planDir ?? "herder-plans");
			if (currentState?.planDir && path.resolve(currentState.planDir) !== planDir) {
				throw new Error(`Active Herder Fire owns ${currentState.planDir}; Grill cannot edit ${planDir}.`);
			}
			const reserved = await invokeHerderTool("herder_plan", {
				operation: "begin_edit",
				planDirectory: planDir,
				planId: target.planId,
			}) as Record<string, unknown>;
			const edit = reserved.edit as Record<string, unknown> | undefined;
			const editToken = typeof edit?.editToken === "string" ? edit.editToken : "";
			const planId = typeof edit?.planId === "string" ? edit.planId : target.planId;
			if (!editToken) throw new Error("Herder manager did not return a plan edit token.");
			if (reserved.reply && typeof reserved.reply === "object") updateFromReply(reserved.reply as ManagerReply);
			return {
				runtimeContext: [
					"HERDER_ACTIVE_PLAN_EDIT_V1",
					`PLAN_ID: ${planId}`,
					`PLAN_DIRECTORY: ${planDir}`,
					`EDIT_TOKEN: ${editToken}`,
					"The manager has reserved this never-started plan while unrelated Fire workers continue.",
					"Edit only the reserved plan and necessary index fields. Do not add, remove, or change another plan.",
					"After confirmed edits pass shape and validation, call herder_plan with operation finish_edit, this planDirectory, and editToken.",
					"If no files were changed, call herder_plan with operation cancel_edit instead.",
				].join("\n"),
				rollback: async () => {
					const cancelled = await invokeHerderTool("herder_plan", {
						operation: "cancel_edit",
						planDirectory: planDir,
						editToken,
					}) as Record<string, unknown>;
					if (cancelled.reply && typeof cancelled.reply === "object") updateFromReply(cancelled.reply as ManagerReply);
				},
			};
		},
		handleManagerReply: async (value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			await enqueueManager(async () => {
				const reply = value as ManagerReply;
				updateFromReply(reply);
				await dispatchReply(reply);
			});
		},
	});

	pi.registerTool({
		name: "herder_verification",
		label: "Herder Verification",
		description: "Submit the main Pi session's structured, exact-tree final verification manifest. Herder executes the gates asynchronously; this tool only selects them.",
		parameters: Type.Object({
			planDirectory: Type.String(),
			requestId: Type.String(),
			rationale: Type.String(),
			gates: Type.Array(Type.Object({
				gateId: Type.String(),
				label: Type.String(),
				cwd: Type.String(),
				argv: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 7_200_000 })),
				rationale: Type.String(),
			}), { maxItems: 32 }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastContext = ctx;
			if (!ctx.isProjectTrusted()) throw new Error("Trust this project before submitting Herder verification.");
			const repoRoot = await repositoryRoot(ctx);
			const planDirectory = resolvePlanDirectory(repoRoot, params.planDirectory);
			let request = verificationRequests.get(params.requestId);
			if (!request) {
				const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory }) as Record<string, unknown>);
				updateFromReply(reply);
				request = verificationRequests.get(params.requestId);
			}
			if (!request || request.requestId !== params.requestId || currentState?.runId !== request.runId || currentState.profile === "unknown") {
				throw new Error(`Herder verification request ${params.requestId} is not bound to this main session`);
			}
			await resolveProfile(ctx, currentState.profile);
			const operationId = `verification:${request.requestId}:${randomUUID()}`;
			const pending = await submitHerderVerification({
				planDirectory,
				operationId,
				manifest: {
					schemaVersion: 1,
					requestId: request.requestId,
					requestSha256: request.requestSha256,
					runId: request.runId,
					generation: request.generation,
					graphSha256: request.graphSha256,
					runAssignmentSha256: request.runAssignmentSha256,
					integrationHead: request.integrationHead,
					integrationTree: request.integrationTree,
					rationale: params.rationale,
					gates: params.gates,
					selector: {
						...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
						...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
						sessionId: ctx.sessionManager.getSessionId(),
					},
				},
			});
			monitorVerification(operationId, pending);
			return {
				content: [{ type: "text" as const, text: `Verification manifest accepted as ${operationId}. Herder is executing ${params.gates.length} gate(s) in the background.` }],
				details: { operationId, requestId: request.requestId, gates: params.gates.length },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "herder",
		label: "Herder",
		description: "Start, resume, revise, inspect, or open the dashboard for a deterministic Herder plan run.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("fire"), Type.Literal("resume"), Type.Literal("revise"), Type.Literal("status"), Type.Literal("dashboard")]),
			planDir: Type.Optional(Type.String()),
			profile: Type.Optional(Type.String()),
			maxParallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastContext = ctx;
			sessionFactory.bindModelRegistry(ctx.modelRegistry);
			try {
				if (params.action === "status") return toolResult(await status(params.planDir, ctx));
				if (params.action === "dashboard") return toolResult(await dashboard(params.planDir, ctx));
				return toolResult(await launch({ mode: params.action, planDir: params.planDir || "herder-plans", ...(params.profile ? { profile: params.profile } : {}), ...(params.maxParallel === undefined && params.action !== "fire" ? {} : { maxParallel: params.maxParallel ?? 5 }), dashboardPort: 0 }, ctx));
			} catch (error) { return toolResult(message(error), true); }
		},
	});

	engine.onUpdate(() => render());
	engine.onTerminal(async (completed: PiWorkerTerminal) => {
		const binding = workers.get(completed.handle);
		if (!binding || binding.actionId !== completed.actionId) return;
		if (binding.transcript) appendWorkerEntry(
			HERDER_WORKER_OUTPUT_ENTRY,
			createWorkerOutputEntry(binding.transcript, completed),
		);
		workers.delete(completed.handle);
		await enqueueManager(async () => {
			const terminal: TerminalEvent = {
				actionId: binding.actionId,
				hostHandle: completed.handle,
				...(completed.response ? { response: completed.response } : {}),
				...(completed.interrupted ? { interrupted: true } : {}),
				...(completed.error ? { error: completed.error } : {}),
				usage: completed.usage,
			};
			const reply = await postEventReliable(binding.planDir, { eventId: randomUUID(), kind: "terminals", terminals: [terminal] });
			updateFromReply(reply);
			await dispatchReply(reply);
		}).catch((error) => lastContext?.ui.notify(`Herder completion handling failed: ${message(error)}`, "error"));
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionEpoch += 1;
		lastContext = ctx;
		sessionFactory.bindModelRegistry(ctx.modelRegistry);
		currentState = restoreLastRun(ctx.sessionManager.getEntries());
		lastPersistedState = currentState;
		if (currentState) {
			try {
				await enqueueManager(async () => {
					let reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory: currentState!.planDir }) as Record<string, unknown>);
					updateFromReply(reply);
					const interrupted = interruptedPiWorkers(reply.active, (handle) => engine.has(handle));
					if (interrupted.length > 0) {
						reply = await postEventReliable(reply.planDirectory, {
							eventId: randomUUID(),
							kind: "terminals",
							terminals: interrupted,
						});
						updateFromReply(reply);
					}
					await dispatchReply(reply);
				});
			} catch (error) {
				ctx.ui.notify(`Herder manager recovery failed: ${message(error)}`, "warning");
			}
		}
		render(ctx);
	});

	pi.on("session_shutdown", async () => {
		sessionEpoch += 1;
		widget.dispose();
		verificationRequests.clear();
		promptedVerifications.clear();
		lastContext = undefined;
	});
}
