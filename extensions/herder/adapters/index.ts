import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	attentionCapabilityToken,
	type ManagerAttentionRequest,
	type ManagerReply,
	type TerminalEvent,
	type VerificationManifest,
	type VerificationRequest,
} from "../src/shared/protocol.ts";
import {
	invokeHerderTool,
	prepareHerderVerificationManifest,
	submitHerderVerification,
	waitHerderOperation,
} from "../src/application/tools.ts";
import {
	parseAttachArguments,
	parseCleanupArguments,
	parseFireArguments,
	parseGrillPlanTarget,
	parsePlanDirArguments,
	parseResetArguments,
	type AttachOptions,
	type FireOptions,
} from "./arguments.ts";
import { runCleanupCommand } from "./cleanup-command.ts";
import { runResetCommand } from "./reset-command.ts";
import { HERDER_CLEANUP_ENTRY, registerCleanupTranscriptRenderer } from "./cleanup-transcript.ts";
import {
	activeModelMatches,
	loadPiProfile,
	unavailableProfileModels,
	type ResolvedPiProfile,
} from "./profile.ts";
import { HERDER_ATTENTION_MESSAGE, attentionMessageDetails, buildAttentionPrompt } from "./attention.ts";
import { HERDER_STATE_ENTRY, restoreLastRun, sameHerderRunState, type HerderRunState } from "./state.ts";
import { resolvePlanDirectory } from "./paths.ts";
import { registerPiPlanningWorkflows } from "./planning-workflows.ts";
import { validateHerderRoleAgents } from "./role-config.ts";
import { interruptedPiWorkers } from "./recovery.ts";
import {
	acquireAdapterOwnership,
	adapterOwnershipLockPath,
	bindAdapterOwnershipRun,
	registerAdapterOwnershipRetirement,
	releaseAdapterOwnership,
	waitForAdapterOwnershipRetirement,
	type AdapterOwnership,
} from "./ownership.ts";
import { DefaultPiWorkerSessionFactory, PiWorkerEngine, type PiWorkerSessionFactory, type PiWorkerTerminal } from "./worker-engine.ts";
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
	sessionEpoch: number;
	transcript?: HerderWorkerInputEntry;
}

type HerderPiWorkerFactory = PiWorkerSessionFactory & {
	bindModelRegistry?: (registry: ModelRegistry) => void;
};

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

export default function registerHerderPi(pi: ExtensionAPI): void {
	const sessionFactory = new DefaultPiWorkerSessionFactory(PI_AGENT_ROOT);
	registerHerderPiWithWorkerFactory(pi, sessionFactory);
}

export function registerHerderPiWithWorkerFactory(pi: ExtensionAPI, sessionFactory: HerderPiWorkerFactory): void {
	registerWorkerTranscriptRenderers(pi);
	registerCleanupTranscriptRenderer(pi);
	const engine = new PiWorkerEngine(sessionFactory);
	const widget = new HerderWidget();
	const workers = new Map<string, WorkerBinding>();
	let currentState: HerderRunState | undefined;
	let lastPersistedState: HerderRunState | undefined;
	let lastContext: ExtensionContext | undefined;
	let lastSummary: PlanSummary | undefined;
	let lastManagerMessage: string | undefined;
	let currentAttention: ManagerAttentionRequest | undefined;
	let attentionHint: string | undefined;
	let attentionDrain = Promise.resolve();
	const deferredAttention = new Set<string>();
	let managerQueue = Promise.resolve();
	let admittedManagerTasks = 0;
	let releaseOwnershipAfterManagerDrain = false;
	let sessionEpoch = 0;
	let shuttingDown = false;
	let ownership: AdapterOwnership | undefined;
	let ownershipEpoch = 0;
	const fallbackPiSessionId = `fallback-${randomUUID()}`;
	const verificationRequests = new Map<string, VerificationRequest>();
	const promptedVerifications = new Set<string>();
	const verificationMonitors = new Map<string, number>();
	const notifiedVerificationFailures = new Set<string>();
	const deliveredVerificationFailureFollowUps = new Set<string>();
	let pendingVerificationFailure: { key: string; runId: string; detail: string; sessionId?: string } | undefined;
	let sendingVerificationFailure = false;

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
			...(lastManagerMessage ? { idleDetail: lastManagerMessage } : {}),
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

	const piSessionId = (ctx: ExtensionContext): string => {
		try {
			const getter = (ctx.sessionManager as { getSessionId?: () => unknown }).getSessionId;
			const value = typeof getter === "function" ? getter.call(ctx.sessionManager) : undefined;
			if (typeof value === "string" && value.length > 0 && value.length <= 512) return value;
		} catch {}
		return fallbackPiSessionId;
	};

	const ownsRun = (planDir: string, runId: string): boolean => Boolean(
		ownership
		&& ownership.lockPath === adapterOwnershipLockPath(planDir)
		&& ownership.record.runId === runId,
	);

	const claimOwnership = async (planDir: string, runId: string, ctx: ExtensionContext, epoch: number): Promise<AdapterOwnership | undefined> => {
		assertSessionActive(epoch);
		if (ownership) {
			if (ownsRun(planDir, runId)) {
				const inherited = ownershipEpoch !== epoch;
				ownershipEpoch = epoch;
				releaseOwnershipAfterManagerDrain = false;
				return inherited ? ownership : undefined;
			}
			throw new Error(`This Pi session already owns Herder run ${ownership.record.runId}; stop it before controlling ${runId}.`);
		}
		await waitForAdapterOwnershipRetirement(planDir);
		assertSessionActive(epoch);
		ownership = acquireAdapterOwnership(planDir, runId, piSessionId(ctx));
		ownershipEpoch = epoch;
		releaseOwnershipAfterManagerDrain = false;
		return ownership;
	};

	const assertOwnership = (planDir: string, runId: string): void => {
		if (!ownsRun(planDir, runId)) {
			throw new Error(`This Pi session does not own Herder run ${runId}; attach or resume it before making changes.`);
		}
	};

	const releaseOwnership = (): void => {
		if (!ownership) return;
		const held = ownership;
		ownership = undefined;
		ownershipEpoch = 0;
		releaseAdapterOwnership(held);
	};

	const releaseNewOwnership = (acquired: AdapterOwnership | undefined, epoch: number): void => {
		if (acquired && ownership === acquired && epoch === sessionEpoch) releaseOwnership();
	};

	const sessionActive = (epoch: number): boolean => epoch === sessionEpoch && !shuttingDown;

	const assertSessionActive = (epoch: number): void => {
		if (!sessionActive(epoch)) throw new Error("Herder operation was cancelled because the Pi session changed or shut down.");
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
		sessionFactory.bindModelRegistry?.(_ctx.modelRegistry);
		await validateHerderRoleAgents(PI_AGENT_ROOT, profile, await engine.availableModels());
	};

	const delegateVerification = (reply: ManagerReply, retryDetail?: string) => {
		if (shuttingDown || !ownsRun(reply.planDirectory, reply.runId)) return;
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
			"Represent every command as direct argv. Every argv element must be one non-empty line: never put literal newlines inside a shell script argument. Use [\"/bin/sh\", \"-lc\", \"single-line script\"] only when shell syntax is genuinely required; join multiple shell statements with && or semicolons.",
			"PATH_POLICY: INTEGRATION_WORKTREE is an absolute LocationRoot for inspection only. Each gate cwd is TreeRelative: use '.' for the worktree root or a relative path such as 'pkg'. Absolute paths in cwd are invalid; never copy INTEGRATION_WORKTREE into cwd.",
			'EXAMPLE_GATE: {"gateId":"unit","label":"unit tests","cwd":".","argv":["npm","test"],"rationale":"Covers the integrated change."}',
			...(retryDetail ? [`PREVIOUS_MANIFEST_ERROR: ${retryDetail.replace(/\s+/g, " ").slice(0, 1_000)}`, "Correct the rejected manifest and submit it again."] : []),
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
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (error) {
			promptedVerifications.delete(request.requestId);
			lastContext.ui.notify(`Herder could not delegate final verification: ${message(error)}`, "warning");
		}
	};

	const drainAttention = async (): Promise<void> => {
		if (shuttingDown || !lastContext || !currentAttention || !currentState) return;
		const request = currentAttention;
		if (request.state === "resolved" || deferredAttention.has(request.requestId) || attentionHint === request.requestId) return;
		const requestId = request.requestId;
		const epoch = sessionEpoch;
		try {
			const prompt = await buildAttentionPrompt(PACKAGE_ROOT, currentState.planDir, request);
			if (!sessionActive(epoch) || !lastContext || !currentAttention || currentAttention.requestId !== requestId) return;
			pi.sendMessage({
				customType: HERDER_ATTENTION_MESSAGE,
				content: prompt,
				display: true,
				details: attentionMessageDetails(request),
			}, { deliverAs: "followUp", triggerTurn: true });
			// A successful injection is the only acknowledgement held by the adapter.
			// SQLite remains authoritative, so a replacement session can re-expose the
			// request when this hint was not persisted before shutdown.
			attentionHint = requestId;
			persist({ ...currentState, attentionRequestId: requestId, updatedAt: Date.now() });
		} catch (error) {
			lastContext?.ui.notify(`Herder could not delegate attention request ${requestId}: ${message(error)}`, "warning");
		}
	};

	const requestAttentionDrain = (): Promise<void> => {
		const next = attentionDrain.then(drainAttention, drainAttention);
		attentionDrain = next.then(() => undefined, () => undefined);
		return next;
	};

	const drainVerificationFailure = (): void => {
		if (shuttingDown || sendingVerificationFailure || !lastContext || !pendingVerificationFailure) return;
		const failure = pendingVerificationFailure;
		const deliveryKey = `${sessionEpoch}:${failure.key}`;
		if (deliveredVerificationFailureFollowUps.has(deliveryKey)) {
			pendingVerificationFailure = undefined;
			return;
		}
		const logPath = failure.detail.match(/\(log ([^)]+)\)/)?.[1] || "the verification failure detail";
		const prompt = [
			"HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1",
			"Herder final verification failed in the active main Pi session.",
			`RUN_ID: ${failure.runId}`,
			...(failure.sessionId ? [`MAIN_SESSION_ID: ${failure.sessionId}`] : []),
			`FAILURE_DETAIL: ${failure.detail}`,
			`LOG_PATH: ${logPath}`,
			"Inspect the log using read-only commands and explain the concrete failure to the user. Do not claim success, silently retry, or execute verification commands yourself.",
			"Classify the recovery: if the manifest or gate command was wrong or transient, tell the user to use /herder-resume for a fresh verification request; if the integrated code is defective or incomplete, tell the user that the frozen integration tree cannot be edited in place and propose a corrective plan followed by /herder-revise.",
			"Do not edit the frozen integration worktree, move Git refs, or mutate manager state. You may notify the user and, with their agreement, use the normal planning workflow in the user checkout for a corrective plan.",
		].join("\n");
		sendingVerificationFailure = true;
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			deliveredVerificationFailureFollowUps.add(deliveryKey);
			pendingVerificationFailure = undefined;
		} catch (error) {
			// Keep the pending failure so agent_settled or the next durable status
			// refresh retries delivery to this session.
			lastContext.ui.notify(`Herder could not deliver final verification failure to the main session: ${message(error)}`, "warning");
		} finally {
			sendingVerificationFailure = false;
		}
	};

	const activeVerificationOperation = (reply: ManagerReply) => (reply.operations ?? []).find(
		(operation) => operation.kind === "verification" && ["accepted", "running"].includes(operation.state),
	);

	const displayedReply = (reply: ManagerReply): { status: Exclude<ManagerReply["status"], "idle">; message: string } => {
		if (activeVerificationOperation(reply)) {
			return { status: "running", message: "Executing final verification gates in the background." };
		}
		return { status: reply.status as Exclude<ManagerReply["status"], "idle">, message: reply.message };
	};

	const updateFromReply = (
		reply: ManagerReply,
		profile?: string,
		mode?: "fire" | "resume" | "revise" | "attach",
		verificationRetryDetail?: string,
		repoRoot?: string,
	) => {
		if (reply.status === "idle") {
			currentState = undefined;
			pendingVerificationFailure = undefined;
			currentAttention = undefined;
			attentionHint = undefined;
			deferredAttention.clear();
			lastSummary = undefined;
			lastManagerMessage = undefined;
			verificationRequests.clear();
			promptedVerifications.clear();
			notifiedVerificationFailures.clear();
			render();
			return;
		}
		currentAttention = ownsRun(reply.planDirectory, reply.runId) ? reply.attention : undefined;
		if (!currentAttention || attentionHint !== currentAttention.requestId) attentionHint = undefined;
		const previous = currentState;
		const now = Date.now();
		const displayed = displayedReply(reply);
		persist({
			version: 1,
			mode: mode ?? previous?.mode ?? "resume",
			status: displayed.status,
			runId: reply.runId,
			repoRoot: repoRoot ?? previous?.repoRoot ?? "",
			planDir: reply.planDirectory,
			profile: profile ?? reply.profileName ?? previous?.profile ?? "unknown",
			maxParallel: reply.maxParallel,
			dashboardEnabled: true,
			startedAt: previous?.startedAt ?? now,
			updatedAt: now,
			...(attentionHint ? { attentionRequestId: attentionHint } : {}),
			...(reply.dashboardUrl ? { dashboardUrl: reply.dashboardUrl } : {}),
		});
		lastSummary = {
			counts: { total: reply.summary.total, done: reply.summary.done, rejected: reply.summary.rejected },
			inProgress: reply.summary.inProgress,
		};
		lastManagerMessage = displayed.message;
		if (displayed.status === "failed" && /verification/i.test(displayed.message)) {
			const failureKey = `${reply.runId}:${displayed.message}`;
			pendingVerificationFailure = {
				key: failureKey,
				runId: reply.runId,
				detail: displayed.message,
				sessionId: lastContext ? piSessionId(lastContext) : undefined,
			};
			if (!notifiedVerificationFailures.has(failureKey)) {
				notifiedVerificationFailures.add(failureKey);
				lastContext?.ui.notify(
					`Herder final verification failed: ${displayed.message}\nUse /herder-resume to create a fresh verification request after correcting the gate.`,
					"error",
				);
			}
		} else {
			pendingVerificationFailure = undefined;
		}
		if (ownsRun(reply.planDirectory, reply.runId)) {
			for (const operation of reply.operations ?? []) {
				if (operation.kind !== "verification" || !["accepted", "running"].includes(operation.state)) continue;
				const operationRequestId = operation.operationId.match(/^verification:([^:]+):/)?.[1];
				monitorVerification(operation.operationId, { planDirectory: reply.planDirectory, operationId: operation.operationId }, reply.verificationRequest?.requestId ?? operationRequestId);
			}
		}
		for (const active of reply.active) {
			if (!active.hostHandle || !engine.has(active.hostHandle) || workers.has(active.hostHandle)) continue;
			workers.set(active.hostHandle, {
				actionId: active.actionId,
				handle: active.hostHandle,
				managerRunId: reply.runId,
				planDir: reply.planDirectory,
				sessionEpoch,
			});
		}
		render();
		delegateVerification(reply, verificationRetryDetail);
		drainVerificationFailure();
		void requestAttentionDrain();
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

	const releaseOwnershipIfManagerIdle = (): void => {
		if (!releaseOwnershipAfterManagerDrain || admittedManagerTasks !== 0) return;
		releaseOwnershipAfterManagerDrain = false;
		releaseOwnership();
	};

	const enqueueManager = <T>(task: () => Promise<T>): Promise<T> => {
		admittedManagerTasks += 1;
		const next = managerQueue.then(task, task);
		const tracked = next.finally(() => {
			admittedManagerTasks -= 1;
			releaseOwnershipIfManagerIdle();
		});
		managerQueue = tracked.then(() => undefined, () => undefined);
		return tracked;
	};

	const discardPrepared = async (handles: readonly string[]): Promise<void> => {
		for (const handle of handles) {
			workers.delete(handle);
			await engine.discard(handle).catch(() => {});
		}
	};

	const dispatchReply = async (initial: ManagerReply, epoch: number): Promise<ManagerReply> => {
		let reply = initial;
		assertOwnership(reply.planDirectory, reply.runId);
		while (sessionActive(epoch) && reply.actions.length > 0 && reply.status === "running") {
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
						sessionEpoch: epoch,
						transcript: createWorkerInputEntry(action, handle),
					});
					results.push({ actionId: action.actionId, accepted: true, hostHandle: handle });
				} catch (error) {
					results.push({ actionId: action.actionId, accepted: false, error: message(error) });
				}
			}
			if (!sessionActive(epoch)) {
				await discardPrepared(prepared);
				throw new Error("Herder dispatch was cancelled before worker handles were accepted because the Pi session changed or shut down.");
			}
			assertOwnership(reply.planDirectory, reply.runId);
			try {
				reply = await postEventReliable(reply.planDirectory, { eventId: randomUUID(), kind: "dispatch_results", dispatchResults: results });
			} catch (error) {
				await discardPrepared(prepared);
				throw error;
			}
			if (!sessionActive(epoch)) {
				for (const handle of prepared) {
					const binding = workers.get(handle);
					if (binding?.transcript) {
						appendWorkerEntry(HERDER_WORKER_INPUT_ENTRY, binding.transcript);
						appendWorkerEntry(HERDER_WORKER_OUTPUT_ENTRY, createWorkerOutputEntry(binding.transcript, {
							actionId: binding.actionId,
							hostHandle: handle,
							interrupted: true,
							error: "Pi session changed or shut down before worker start",
						}));
					}
				}
				await discardPrepared(prepared);
				// Leave accepted handles for the replacement session's deterministic
				// recovery pass without holding shutdown open for manager reconciliation.
				return reply;
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

	const recoverInterruptedWorkers = async (initial: ManagerReply, epoch: number): Promise<ManagerReply> => {
		assertSessionActive(epoch);
		assertOwnership(initial.planDirectory, initial.runId);
		let reply = initial;
		const interrupted = interruptedPiWorkers(reply.active, (handle) => engine.has(handle));
		if (interrupted.length > 0) {
			reply = await postEventReliable(reply.planDirectory, {
				eventId: randomUUID(),
				kind: "terminals",
				terminals: interrupted,
			});
			assertSessionActive(epoch);
			assertOwnership(reply.planDirectory, reply.runId);
			updateFromReply(reply);
		}
		return dispatchReply(reply, epoch);
	};

	function monitorVerification(
		operationId: string,
		pending: Awaited<ReturnType<typeof submitHerderVerification>>,
		requestId?: string,
	): void {
		const epoch = sessionEpoch;
		if (verificationMonitors.get(operationId) === epoch) return;
		verificationMonitors.set(operationId, epoch);
		void waitHerderOperation(pending).then((value) => {
			if (!sessionActive(epoch)) return;
			return enqueueManager(async () => {
				assertSessionActive(epoch);
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Verification operation returned no manager reply");
				const reply = value as ManagerReply;
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
				await dispatchReply(reply, epoch);
			});
		}).catch(async (error) => {
			if (!sessionActive(epoch)) return;
			const detail = message(error);
			lastContext?.ui.notify(`Herder verification handling failed: ${detail}`, "error");
			if (!requestId) return;
			try {
				await enqueueManager(async () => {
					assertSessionActive(epoch);
					const reply = unwrapReply(await invokeHerderTool("herder_run", {
						operation: "status",
						planDirectory: pending.planDirectory,
					}) as Record<string, unknown>);
					assertSessionActive(epoch);
					assertOwnership(reply.planDirectory, reply.runId);
					if (reply.verificationRequest?.requestId === requestId) promptedVerifications.delete(requestId);
					updateFromReply(reply, undefined, undefined, detail);
				});
			} catch (refreshError) {
				if (sessionActive(epoch)) lastContext?.ui.notify(`Herder could not refresh verification state: ${message(refreshError)}`, "error");
			}
		}).finally(() => {
			if (verificationMonitors.get(operationId) === epoch) verificationMonitors.delete(operationId);
		});
	}

	const launch = async (options: FireOptions, ctx: ExtensionContext): Promise<string> => {
		const epoch = sessionEpoch;
		assertSessionActive(epoch);
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before starting Herder.");
		if (options.mode === "fire" && ownership) {
			throw new Error(`This Pi session already owns Herder run ${ownership.record.runId}; stop it before starting a different run.`);
		}
		const repoRoot = await repositoryRoot(ctx);
		assertSessionActive(epoch);
		const planDir = resolvePlanDirectory(repoRoot, options.planDir);
		if (!existsSync(path.join(planDir, "README.md"))) throw new Error(`Herder plan index is missing: ${path.join(planDir, "README.md")}`);
		if (options.mode === "resume") {
			// Resume is an explicit re-exposure point for durable attention. The hint
			// is not authority and must not suppress the manager's next request.
			attentionHint = undefined;
			currentAttention = undefined;
			deferredAttention.clear();
		}
		let acquired: AdapterOwnership | undefined;
		let before: ManagerReply | undefined;
		try {
			if (options.mode !== "fire") {
				before = await enqueueManager(async () => {
					assertSessionActive(epoch);
					const reply = unwrapReply(await invokeHerderTool("herder_run", {
						operation: "status",
						planDirectory: planDir,
					}) as Record<string, unknown>);
					assertSessionActive(epoch);
					if (reply.status === "idle" || !reply.runId) throw new Error(`No deterministic Herder run exists in ${planDir}.`);
					acquired = await claimOwnership(planDir, reply.runId, ctx, epoch);
					return reply;
				});
			}
			const profile = await resolveProfile(ctx, options.profile || before?.profileName || (options.mode === "resume" ? currentState?.profile : undefined));
			assertSessionActive(epoch);
			renderLaunching(ctx, planDir, profile.profile, options.maxParallel ?? before?.maxParallel ?? currentState?.maxParallel ?? 5);
			await preflight(ctx, profile);
			assertSessionActive(epoch);
			if (!before) acquired = await claimOwnership(planDir, `pending-fire:${randomUUID()}`, ctx, epoch);
			const reply = await enqueueManager(async () => {
				assertSessionActive(epoch);
				if (before) {
					assertOwnership(planDir, before.runId);
					const fresh = unwrapReply(await invokeHerderTool("herder_run", {
						operation: "status",
						planDirectory: planDir,
					}) as Record<string, unknown>);
					assertSessionActive(epoch);
					if (fresh.runId !== before.runId) throw new Error(`Herder run changed from ${before.runId} to ${fresh.runId || "idle"} before ${options.mode}; refusing to mutate it.`);
					if (!fresh.profileName || fresh.profileName !== before.profileName) throw new Error(`Herder run ${before.runId} changed its immutable profile before ${options.mode}; refusing to mutate it.`);
				}
				const started = unwrapReply(await invokeHerderTool("herder_run", {
					operation: options.mode,
					repositoryRoot: repoRoot,
					planDirectory: planDir,
					profile: profile.profile,
					...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
					dashboardPort: options.dashboardPort,
				}) as Record<string, unknown>);
				assertSessionActive(epoch);
				if (started.status === "idle") throw new Error("Herder manager did not create a run.");
				if (before && started.runId !== before.runId) throw new Error(`Herder ${options.mode} returned unexpected run ${started.runId}; expected ${before.runId}.`);
				if (!before) {
					if (!ownership || ownership !== acquired) throw new Error("Herder Fire lost its startup ownership before manager creation completed.");
					bindAdapterOwnershipRun(ownership, started.runId);
				}
				assertOwnership(planDir, started.runId);
				const now = Date.now();
				persist({
					version: 1,
					mode: options.mode,
					status: started.status,
					runId: started.runId,
					repoRoot,
					planDir,
					profile: profile.profile,
					maxParallel: started.maxParallel,
					dashboardEnabled: true,
					startedAt: now,
					updatedAt: now,
					...(started.dashboardUrl ? { dashboardUrl: started.dashboardUrl } : {}),
				});
				lastSummary = {
					counts: { total: started.summary.total, done: started.summary.done, rejected: started.summary.rejected },
					inProgress: started.summary.inProgress,
				};
				// Process every start/resume reply before dispatch. A paused verification
				// request has no worker actions, so dispatch alone cannot delegate it.
				updateFromReply(started, profile.profile, options.mode, undefined, repoRoot);
				await dispatchReply(started, epoch);
				assertSessionActive(epoch);
				return started;
			});
			return `Herder ${options.mode} started with deterministic manager ${reply.runId}, profile ${profile.profile}, and max parallel ${reply.maxParallel}. Dashboard: ${reply.dashboardUrl || "unavailable"}`;
		} catch (error) {
			releaseNewOwnership(acquired, epoch);
			render(ctx);
			throw error;
		}
	};

	const attach = async (options: AttachOptions, ctx: ExtensionContext): Promise<string> => {
		const epoch = sessionEpoch;
		assertSessionActive(epoch);
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before attaching to Herder.");
		const repoRoot = await repositoryRoot(ctx);
		assertSessionActive(epoch);
		const planDir = resolvePlanDirectory(repoRoot, options.planDir);
		if (!existsSync(path.join(planDir, "README.md"))) throw new Error(`Herder plan index is missing: ${path.join(planDir, "README.md")}`);
		const snapshot = unwrapReply(await invokeHerderTool("herder_run", {
			operation: "status",
			planDirectory: planDir,
			dashboardPort: options.dashboardPort,
		}) as Record<string, unknown>);
		assertSessionActive(epoch);
		if (snapshot.status === "idle") {
			throw new Error(`No Herder run is recorded in ${planDir}. Use /herder-fire ${options.planDir} to start one.`);
		}
		if (snapshot.status === "complete") {
			throw new Error(`Herder run ${snapshot.runId} is complete and cannot be attached. Finalize or clean up the completed run, then use /herder-fire for new work.`);
		}
		if (["failed", "stopped", "initializing"].includes(snapshot.status)) {
			throw new Error(`Herder run ${snapshot.runId} is ${snapshot.status}. Use /herder-resume ${options.planDir} to recover it before attaching.`);
		}
		if (!["running", "paused", "needs_input"].includes(snapshot.status)) {
			throw new Error(`Herder run ${snapshot.runId} has unsupported attach status ${snapshot.status}.`);
		}
		if (!snapshot.profileName) throw new Error(`Herder run ${snapshot.runId} did not report its immutable profile; restart the manager and retry.`);
		const profile = await resolveProfile(ctx, snapshot.profileName);
		await preflight(ctx, profile);
		assertSessionActive(epoch);
		let acquired: AdapterOwnership | undefined;
		try {
			const fresh = await enqueueManager(async () => {
				assertSessionActive(epoch);
				acquired = await claimOwnership(planDir, snapshot.runId, ctx, epoch);
				const reply = unwrapReply(await invokeHerderTool("herder_run", {
					operation: "status",
					planDirectory: planDir,
					dashboardPort: options.dashboardPort,
				}) as Record<string, unknown>);
				assertSessionActive(epoch);
				if (reply.runId !== snapshot.runId) throw new Error(`Herder run changed from ${snapshot.runId} to ${reply.runId || "idle"} while attaching.`);
				if (!reply.profileName || reply.profileName !== snapshot.profileName) throw new Error(`Herder run ${snapshot.runId} changed its immutable profile while attaching.`);
				if (!["running", "paused", "needs_input"].includes(reply.status)) throw new Error(`Herder run ${reply.runId} changed to ${reply.status} while attaching.`);
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply, profile.profile, "attach", undefined, repoRoot);
				await recoverInterruptedWorkers(reply, epoch);
				assertSessionActive(epoch);
				return reply;
			});
			return `Attached to Herder run ${fresh.runId} without changing its ${fresh.status} lifecycle state, profile ${profile.profile}, and max parallel ${fresh.maxParallel}. Dashboard: ${fresh.dashboardUrl || "unavailable"}`;
		} catch (error) {
			releaseNewOwnership(acquired, epoch);
			throw error;
		}
	};

	const status = async (planDirInput: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = planDirInput
			? resolvePlanDirectory(repoRoot, planDirInput)
			: currentState?.planDir ?? resolvePlanDirectory(repoRoot, "herder-plans");
		const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory: planDir }) as Record<string, unknown>);
		const statusAttentionId = reply.attention?.requestId;
		const reexposeAttention = Boolean(statusAttentionId
			&& ownsRun(reply.planDirectory, reply.runId)
			&& statusAttentionId === attentionHint);
		updateFromReply(reply);
		if (reexposeAttention && statusAttentionId) {
			attentionHint = undefined;
			deferredAttention.delete(statusAttentionId);
			if (currentState) persist({ ...currentState, attentionRequestId: undefined, updatedAt: Date.now() });
			await requestAttentionDrain();
		}
		render(ctx);
		const displayed = displayedReply(reply);
		return `${displayed.status.toUpperCase()} · ${displayed.message}${reply.dashboardUrl ? `\nDashboard: ${reply.dashboardUrl}` : ""}`;
	};

	const dashboard = async (planDirInput: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = planDirInput
			? resolvePlanDirectory(repoRoot, planDirInput)
			: currentState?.planDir ?? resolvePlanDirectory(repoRoot, "herder-plans");
		const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "dashboard", planDirectory: planDir }) as Record<string, unknown>);
		return `Herder dashboard: ${reply.dashboardUrl || "unavailable"}`;
	};

	const cleanup = async (args: string, ctx: ExtensionContext): Promise<string> => {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before using Herder cleanup.");
		const parsed = parseCleanupArguments(args);
		const repoRoot = await repositoryRoot(ctx);
		const planDir = resolvePlanDirectory(repoRoot, parsed.planDir);
		const result = await runCleanupCommand(parsed, {
			repositoryRoot: repoRoot,
			planDirectory: planDir,
			confirm: async (title, body) => ctx.hasUI && await ctx.ui.confirm(title, body),
			appendEntry: (entry) => pi.appendEntry(HERDER_CLEANUP_ENTRY, entry),
		});
		return result.message;
	};

	const reset = async (args: string, ctx: ExtensionContext): Promise<string> => {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before using Herder reset.");
		const parsed = parseResetArguments(args);
		const repoRoot = await repositoryRoot(ctx);
		const planDir = resolvePlanDirectory(repoRoot, parsed.planDir);
		return runResetCommand(parsed, {
			repositoryRoot: repoRoot,
			planDirectory: planDir,
			confirm: async (title, body) => ctx.hasUI && await ctx.ui.confirm(title, body),
		});
	};


	const stop = async (): Promise<string> => {
		if (!currentState) return "No active Herder run.";
		const epoch = sessionEpoch;
		const state = currentState;
		return enqueueManager(async () => {
			assertSessionActive(epoch);
			assertOwnership(state.planDir, state.runId);
			let reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "stop", planDirectory: state.planDir }) as Record<string, unknown>);
			assertSessionActive(epoch);
			const active = [...workers.values()].filter((worker) => worker.sessionEpoch === epoch);
			for (const worker of active) {
				if (worker.transcript) appendWorkerEntry(HERDER_WORKER_OUTPUT_ENTRY, createWorkerOutputEntry(worker.transcript, {
					actionId: worker.actionId,
					hostHandle: worker.handle,
					interrupted: true,
					error: "Pi user requested Herder stop",
				}));
			}
			for (const worker of active) workers.delete(worker.handle);
			await Promise.all(active.map((worker) => engine.stop(worker.handle).catch(() => {})));
			const interrupted: TerminalEvent[] = active.map((worker) => ({
				actionId: worker.actionId,
				hostHandle: worker.handle,
				interrupted: true,
				error: "Pi user requested Herder stop",
			}));
			if (interrupted.length > 0) {
				reply = await postEventReliable(state.planDir, { eventId: randomUUID(), kind: "terminals", terminals: interrupted });
			}
			assertSessionActive(epoch);
			updateFromReply(reply);
			releaseOwnership();
			return `Stop requested for Herder run ${reply.runId}. Repository state was preserved.`;
		});
	};

	const command = (handler: (args: string, ctx: ExtensionContext) => Promise<string>) => async (args: string, ctx: ExtensionContext) => {
		lastContext = ctx;
		try { ctx.ui.notify(await handler(args, ctx), "info"); }
		catch (error) { ctx.ui.notify(message(error), "error"); }
	};

	pi.registerCommand("herder-fire", { description: "Start a deterministic background Herder run.", handler: command((args, ctx) => launch(parseFireArguments(args, "fire"), ctx)) });
	pi.registerCommand("herder-attach", { description: "Attach this Pi session to an active Herder run after its former session died.", handler: command((args, ctx) => attach(parseAttachArguments(args), ctx)) });
	pi.registerCommand("herder-resume", { description: "Resume a deterministic Herder run.", handler: command((args, ctx) => launch(parseFireArguments(args, "resume"), ctx)) });
	pi.registerCommand("herder-revise", { description: "Adopt a validated new plan-graph generation.", handler: command((args, ctx) => launch(parseFireArguments(args, "revise"), ctx)) });
	pi.registerCommand("herder-status", { description: "Show Herder manager and plan status.", handler: command((args, ctx) => status(parsePlanDirArguments(args).planDir, ctx)) });
	pi.registerCommand("herder-dashboard", { description: "Open the manager-hosted Herder dashboard.", handler: command((args, ctx) => dashboard(parsePlanDirArguments(args).planDir, ctx)) });
	pi.registerCommand("herder-cleanup", { description: "Preview and confirm safe cleanup of completed Herder plan worktrees.", handler: command(cleanup) });
	pi.registerCommand("herder-reset", { description: "Reset a Herder plan set to its pre-initialized execution state.", handler: command(reset) });
	pi.registerCommand("herder-stop", {
		description: "Stop active Herder workers and preserve repository state.",
		handler: async (_args, ctx) => {
			lastContext = ctx;
			if (ctx.hasUI && !(await ctx.ui.confirm("Stop Herder?", "Active workers will stop; repository state remains preserved."))) return;
			try { ctx.ui.notify(await stop(), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	const activeFire = () => Boolean(currentState && !["complete", "failed", "stopped"].includes(currentState.status))
		|| Boolean(currentAttention && currentAttention.state !== "resolved")
		|| workers.size > 0
		|| engine.snapshots().length > 0;
	registerPiPlanningWorkflows(pi, PACKAGE_ROOT, repositoryRoot, {
		assertMutationAllowed: () => {
			if (activeFire()) throw new Error("Finish or stop the active Herder Fire run before changing plan configuration.");
		},
		assertAttentionAllowed: (input) => {
			const request = currentAttention;
			if (!request || request.state === "resolved") throw new Error("No unresolved Herder attention request is bound to this Pi session.");
			assertOwnership(input.planDirectory, request.runId);
			const capabilityToken = request.capabilityToken || attentionCapabilityToken(request.requestId);
			if (input.requestId !== request.requestId
				|| input.requestSha256 !== request.requestSha256
				|| input.capabilityToken !== capabilityToken
				|| input.runId !== request.runId
				|| input.planId !== request.planId
				|| input.generation !== request.generation
				|| input.round !== request.round) {
				throw new Error(`Herder attention request ${input.requestId || "missing"} is not bound to this Pi session.`);
			}
		},
		prepareWorkflow: async (skill, args, ctx) => {
			if (!activeFire()) return {};
			const epoch = sessionEpoch;
			assertSessionActive(epoch);
			if (skill !== "grill") throw new Error("Only /herder-grill --plan <unstarted-plan> may run while Herder Fire is active.");
			const target = parseGrillPlanTarget(args);
			if (!target) throw new Error("Active Herder Fire requires /herder-grill --plan <unstarted-plan>.");
			const repoRoot = await repositoryRoot(ctx);
			const planDir = resolvePlanDirectory(repoRoot, target.planDir ?? currentState?.planDir ?? "herder-plans");
			if (currentState?.planDir && path.resolve(currentState.planDir) !== planDir) {
				throw new Error(`Active Herder Fire owns ${currentState.planDir}; Grill cannot edit ${planDir}.`);
			}
			if (!currentState) throw new Error("Active Herder state is unavailable for Grill ownership validation.");
			assertOwnership(planDir, currentState.runId);
			const reserved = await enqueueManager(async () => {
				assertSessionActive(epoch);
				assertOwnership(planDir, currentState!.runId);
				return await invokeHerderTool("herder_plan", {
					operation: "begin_edit",
					planDirectory: planDir,
					planId: target.planId,
				}) as Record<string, unknown>;
			});
			assertSessionActive(epoch);
			const edit = reserved.edit as Record<string, unknown> | undefined;
			const editToken = typeof edit?.editToken === "string" ? edit.editToken : "";
			const planId = typeof edit?.planId === "string" ? edit.planId : target.planId;
			if (!editToken) throw new Error("Herder manager did not return a plan edit token.");
			if (reserved.reply && typeof reserved.reply === "object") {
				const reply = reserved.reply as ManagerReply;
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
			}
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
					if (!sessionActive(epoch) || !currentState || !ownsRun(planDir, currentState.runId)) return;
					const cancelled = await enqueueManager(async () => {
						assertSessionActive(epoch);
						assertOwnership(planDir, currentState!.runId);
						return await invokeHerderTool("herder_plan", {
							operation: "cancel_edit",
							planDirectory: planDir,
							editToken,
						}) as Record<string, unknown>;
					});
					if (cancelled.reply && typeof cancelled.reply === "object") {
						const reply = cancelled.reply as ManagerReply;
						assertOwnership(reply.planDirectory, reply.runId);
						updateFromReply(reply);
					}
				},
			};
		},
		handleManagerReply: async (value, context) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			const epoch = sessionEpoch;
			const action = context?.attentionAction?.trim().toLowerCase().replace(/[- ]+/g, "_");
			if (action === "defer") {
				const reply = value as ManagerReply;
				if (reply.attention) deferredAttention.add(reply.attention.requestId);
			} else if (action && currentAttention) {
				deferredAttention.delete(currentAttention.requestId);
			}
			await enqueueManager(async () => {
				assertSessionActive(epoch);
				const reply = value as ManagerReply;
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
				await dispatchReply(reply, epoch);
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
				cwd: Type.String({ description: "Tree-relative path inside the integration worktree. Use '.' for the worktree root. Absolute paths are invalid." }),
				argv: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 7_200_000 })),
				rationale: Type.String(),
			}), { maxItems: 32 }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const epoch = sessionEpoch;
			assertSessionActive(epoch);
			lastContext = ctx;
			if (!ctx.isProjectTrusted()) throw new Error("Trust this project before submitting Herder verification.");
			const repoRoot = await repositoryRoot(ctx);
			assertSessionActive(epoch);
			const planDirectory = resolvePlanDirectory(repoRoot, params.planDirectory);
			let request = verificationRequests.get(params.requestId);
			if (!request) {
				const reply = await enqueueManager(async () => {
					assertSessionActive(epoch);
					return unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory }) as Record<string, unknown>);
				});
				assertSessionActive(epoch);
				assertOwnership(reply.planDirectory, reply.runId);
				updateFromReply(reply);
				request = verificationRequests.get(params.requestId);
			}
			if (!request || request.requestId !== params.requestId || currentState?.runId !== request.runId || currentState.profile === "unknown") {
				throw new Error(`Herder verification request ${params.requestId} is not bound to this main session`);
			}
			assertOwnership(planDirectory, request.runId);
			await resolveProfile(ctx, currentState.profile);
			assertSessionActive(epoch);
			const manifest = prepareHerderVerificationManifest(request, {
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
					sessionId: piSessionId(ctx),
				},
			} satisfies VerificationManifest);
			const operationId = `verification:${request.requestId}:${randomUUID()}`;
			const pending = await enqueueManager(async () => {
				assertSessionActive(epoch);
				assertOwnership(planDirectory, request!.runId);
				const submitted = await submitHerderVerification({ planDirectory, operationId, manifest });
				assertSessionActive(epoch);
				return submitted;
			});
			// Submission is durable, so immediately reflect the background execution
			// instead of leaving the last awaiting-manifest snapshot on screen.
			if (currentState?.runId === request.runId) {
				persist({ ...currentState, status: "running", updatedAt: Date.now() });
				lastManagerMessage = `Executing ${params.gates.length} final verification gate(s) in the background.`;
				verificationRequests.delete(request.requestId);
				render(ctx);
			}
			monitorVerification(operationId, pending, request.requestId);
			return {
				content: [{ type: "text" as const, text: `Verification manifest accepted as ${operationId}. Herder is executing ${params.gates.length} gate(s) in the background.` }],
				details: { operationId, requestId: request.requestId, gates: params.gates.length },
				terminate: true,
			};
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
		const epoch = binding.sessionEpoch;
		if (!sessionActive(epoch)) return;
		await enqueueManager(async () => {
			assertSessionActive(epoch);
			assertOwnership(binding.planDir, binding.managerRunId);
			const terminal: TerminalEvent = {
				actionId: binding.actionId,
				hostHandle: completed.handle,
				...(completed.response ? { response: completed.response } : {}),
				...(completed.interrupted ? { interrupted: true } : {}),
				...(completed.error ? { error: completed.error } : {}),
				usage: completed.usage,
			};
			const reply = await postEventReliable(binding.planDir, { eventId: randomUUID(), kind: "terminals", terminals: [terminal] });
			assertSessionActive(epoch);
			assertOwnership(reply.planDirectory, reply.runId);
			updateFromReply(reply);
			await dispatchReply(reply, epoch);
		}).catch((error) => {
			if (sessionActive(epoch)) lastContext?.ui.notify(`Herder completion handling failed: ${message(error)}`, "error");
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (shuttingDown) return;
		lastContext = ctx;
		drainVerificationFailure();
		await requestAttentionDrain();
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionEpoch += 1;
		const epoch = sessionEpoch;
		shuttingDown = false;
		releaseOwnershipAfterManagerDrain = false;
		lastContext = ctx;
		currentAttention = undefined;
		pendingVerificationFailure = undefined;
		sendingVerificationFailure = false;
		deliveredVerificationFailureFollowUps.clear();
		deferredAttention.clear();
		sessionFactory.bindModelRegistry?.(ctx.modelRegistry);
		currentState = restoreLastRun(ctx.sessionManager.getEntries());
		// A persisted hint only records that an earlier session injected a request;
		// it is never an acknowledgement authority across replacement. Re-expose
		// the manager's next durable request after the replacement status read.
		attentionHint = undefined;
		lastPersistedState = currentState;
		if (currentState) {
			const restored = currentState;
			let acquired: AdapterOwnership | undefined;
			try {
				await enqueueManager(async () => {
					assertSessionActive(epoch);
					const reply = unwrapReply(await invokeHerderTool("herder_run", { operation: "status", planDirectory: restored.planDir }) as Record<string, unknown>);
					assertSessionActive(epoch);
					if (reply.runId !== restored.runId) {
						throw new Error(`Persisted Herder run ${restored.runId} does not match manager run ${reply.runId || "idle"}; refusing recovery.`);
					}
					const shouldOwn = ["initializing", "running", "paused", "needs_input"].includes(reply.status)
						|| (reply.status === "failed" && (Boolean(reply.attention && reply.attention.state !== "resolved") || /verification/i.test(reply.message)));
					if (shouldOwn) {
						if (!reply.profileName || (restored.profile !== "unknown" && reply.profileName !== restored.profile)) {
							throw new Error(`Persisted Herder profile ${restored.profile} does not match manager profile ${reply.profileName || "missing"}; refusing recovery.`);
						}
						acquired = await claimOwnership(reply.planDirectory, reply.runId, ctx, epoch);
						assertSessionActive(epoch);
						assertOwnership(reply.planDirectory, reply.runId);
						updateFromReply(reply);
						if (["running", "paused", "needs_input"].includes(reply.status)) await recoverInterruptedWorkers(reply, epoch);
						return;
					}
					updateFromReply(reply);
					if (ownership) releaseOwnershipAfterManagerDrain = true;
				});
			} catch (error) {
				releaseNewOwnership(acquired, epoch);
				if (ownership && ownershipEpoch !== epoch) {
					if (admittedManagerTasks === 0) releaseOwnership();
					else releaseOwnershipAfterManagerDrain = true;
				}
				if (sessionActive(epoch)) ctx.ui.notify(`Herder manager recovery failed: ${message(error)}`, "warning");
			}
		} else if (ownership) {
			if (admittedManagerTasks === 0) releaseOwnership();
			else releaseOwnershipAfterManagerDrain = true;
		}
		render(ctx);
	});

	pi.on("session_shutdown", async () => {
		sessionEpoch += 1;
		shuttingDown = true;
		const handles = engine.snapshots().map((worker) => worker.handle);
		await Promise.all(handles.map((handle) => engine.stop(handle).catch(() => {})));
		workers.clear();
		if (admittedManagerTasks === 0) releaseOwnership();
		else {
			releaseOwnershipAfterManagerDrain = true;
			if (ownership) registerAdapterOwnershipRetirement(ownership, managerQueue);
		}
		widget.dispose();
		verificationRequests.clear();
		pendingVerificationFailure = undefined;
		sendingVerificationFailure = false;
		promptedVerifications.clear();
		currentAttention = undefined;
		deferredAttention.clear();
		lastContext = undefined;
	});
}
