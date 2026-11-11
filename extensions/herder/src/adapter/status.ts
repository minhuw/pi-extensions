import { readFileSync } from "node:fs";
import { parsePlanTasks, type PlanTask } from "../artifacts/plan.ts";
import type { RunState } from "../journal/fold.ts";
import type { LockInfo } from "../run/lock.ts";
import type { RunStore } from "../run/store.ts";
import type { StepActivity } from "./runtime.ts";

export const FINISHED_STATUSES: ReadonlySet<string> = new Set(["delivered", "abandoned", "failed"]);
export const isFinished = (state: RunState) => FINISHED_STATUSES.has(state.status);
/** Verified `met` at its current integration head, with no delivery started: waiting for the user to deliver it. */
export const isParked = (state: RunState) => state.goal !== undefined && !isFinished(state) && !state.deliveryStarted && !state.delivery
	&& state.verification?.verdict === "met" && state.verification.head === state.integrationHead;
/** Verified `blocked` at its current integration head, with no delivery started. */
export const isBlocked = (state: RunState) => state.goal !== undefined && !isFinished(state) && !state.deliveryStarted && !state.delivery
	&& state.verification?.verdict === "blocked" && state.verification.head === state.integrationHead;
const short = (sha: string | undefined) => (sha ? sha.slice(0, 12) : "—");
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
/** Terminal-safe, single-line, bounded text, including values supplied by workflow scripts. */
export const statusPart = (text: string, max = 48) => clip(text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(), max);

export interface RunEntry { runId: string; state: RunState }
const titled = ({ runId, state }: RunEntry) => `${runId}${state.title ? ` ${clip(state.title, 80)}` : ""}`;

/** One line per parked run: id, title, the verified head, and how to deliver it; empty without parked runs. */
export function parkedLines(runs: readonly RunEntry[]): string[] {
	const parked = runs.filter((run) => isParked(run.state));
	if (!parked.length) return [];
	return [
		`Parked runs (verified, waiting for delivery): ${parked.length}`,
		...parked.map((run) => `  ${titled(run)} — verified met at ${short(run.state.verification!.head)}; deliver with /herder deliver ${run.runId}`),
	];
}

/** One line per other non-parked unfinished run: id, title, status, and lock holder; empty without any. */
export function otherUnfinishedLines(runs: readonly RunEntry[], currentRunId: string, lockOf: (runId: string) => LockInfo | null, sessionId: string): string[] {
	const others = runs.filter((run) => run.runId !== currentRunId && !isParked(run.state));
	if (!others.length) return [];
	return [
		`Other unfinished runs: ${others.length}`,
		...others.map((run) => {
			const lock = lockOf(run.runId);
			const holder = !lock ? `unlocked; continue with /herder resume ${run.runId}`
				: lock.sessionId === sessionId ? "locked by this session"
				: `locked by session ${lock.sessionId}`;
			return `  ${titled(run)} — ${run.state.status} (${holder})`;
		}),
	];
}

/** The refusal when several runs are unfinished and none is named or held. */
export function severalRunsText(runs: readonly RunEntry[]): string {
	return [
		`${runs.length} Herder runs are unfinished in this repository and this session holds none of them; name one:`,
		...runs.map((run) => `  ${titled(run)} — ${isParked(run.state) ? "parked (verified met, waiting for delivery)" : `not parked (${run.state.status})`}`),
		"Continue one with /herder resume <runId>, or deliver a parked one with /herder deliver <runId> (herder_deliver { runId }).",
	].join("\n");
}

/** Task lines of plan.md; an unreadable plan has none. */
export function planTasks(run: RunStore): PlanTask[] {
	try {
		return parsePlanTasks(readFileSync(run.paths.plan, "utf8"));
	} catch {
		return [];
	}
}

function taskCounts(state: RunState, tasks: readonly PlanTask[]): { done: number; total: number } {
	const ids = new Set([...tasks.map((task) => task.id), ...state.tasks.keys()]);
	return { done: [...ids].filter((id) => state.tasks.get(id)?.status === "integrated").length, total: ids.size };
}

export interface StatusInput {
	state: RunState; tasks: readonly PlanTask[]; running: readonly StepActivity[]; operations?: readonly string[];
	launch?: number; launching?: boolean; stopping?: boolean; phase?: string; log?: string;
}

function stepText(step: StepActivity, showStage = true): string {
	const task = statusPart(step.task ?? "", 16);
	let phase = statusPart(step.phase ?? "", 28);
	// A script phase is global. Attribute it to a step only when it explicitly names that task.
	if (step.phaseIsGlobal) {
		const prefix = task && phase.startsWith(`${task}:`) ? `${task}:` : "";
		phase = prefix ? phase.slice(prefix.length).trim() : "";
	} else if (task && phase.startsWith(`${task}:`)) phase = phase.slice(task.length + 1).trim();
	const label = step.label === step.key && phase ? "" : statusPart(step.label || step.key, 24);
	return statusPart([task, showStage ? statusPart(step.stage ?? "") : "", phase, label && label !== phase ? label : ""].filter(Boolean).join(" ") || step.key, 48);
}

/** Footer text; live work takes precedence over the last journaled verification. */
export function statusText({ state, tasks, running, operations = [], launch, launching, stopping, phase, log }: StatusInput): string | undefined {
	if (state.runId === undefined || isFinished(state)) return undefined;
	const parts: string[] = [];
	parts.push(...operations.slice(0, 2).map((op) => statusPart(op)));
	if (operations.length > 2) parts.push(`+${operations.length - 2} operations`);
	if (running.length > 1 || (running.length && operations.length)) parts.push(`${running.length} ${running.length === 1 ? "step" : "steps"}`);
	const showLog = !stopping && (launch !== undefined || launching) && log;
	if (showLog) {
		for (const step of running) {
			if (step.stage) parts.push([statusPart(step.task ?? "", 16), statusPart(step.stage)].filter(Boolean).join(" "));
		}
		if (!running.length && !operations.length) parts.push(launch === undefined ? "starting launch" : `launch ${launch}`);
		parts.push(`log: ${statusPart(showLog)}`);
	}
	if (running.length) parts.push(...running.slice(0, 2).map((step) => stepText(step, !showLog)));
	if (stopping) parts.push(`stopping launch${launch === undefined ? "" : ` ${launch}`}`);
	else if (launch !== undefined || launching) {
		if (!showLog && !running.length && !operations.length) parts.push(launch === undefined ? "starting launch" : `launch ${launch}`);
		if (phase) parts.push(`phase: ${statusPart(phase)}`);
	}
	const verified = state.verification?.head === state.integrationHead ? state.verification : undefined;
	if (!parts.length) parts.push(state.status === "drafting" ? "drafting goal" : verified ? `verified ${verified.verdict}` : "ready");
	const { done, total } = taskCounts(state, tasks);
	return `herder: ${parts.join(" · ")}${total ? ` · ${done}/${total} tasks` : ""}`;
}

export interface DescribeOptions { lock: LockInfo | null; sessionId: string; launch?: number; now: Date }

/** Human- and model-readable run summary for `/herder status` and `herder_run status`. */
export function describeRun(run: RunStore, state: RunState, tasks: readonly PlanTask[], options: DescribeOptions): string {
	const { lock } = options;
	const holder = !lock ? "none"
		: lock.sessionId === options.sessionId ? "this session"
		: `session ${lock.sessionId} (pid ${lock.pid} on ${lock.host}, heartbeat ${Math.max(0, Math.round((options.now.getTime() - Date.parse(lock.heartbeatAt)) / 1000))}s ago)`;
	const { done, total } = taskCounts(state, tasks);
	const latest = [...state.launches.values()].at(-1);
	const lines = [
		`Herder run ${run.runId}: ${state.title ?? ""}`.trimEnd(),
		`Status: ${state.status}${state.goal ? "" : " (goal not approved)"}; base ${short(state.base)}, integration head ${short(state.integrationHead)}`,
		`Tasks: ${total ? `${done}/${total} integrated` : "none planned"}`,
		...[...new Set([...tasks.map((task) => task.id), ...state.tasks.keys()])].map((id) => `  ${id} ${state.tasks.get(id)?.status ?? "pending"}${tasks.find((task) => task.id === id) ? ` — ${clip(tasks.find((task) => task.id === id)!.text, 80)}` : ""}`),
		`Launches: ${state.launches.size}${latest ? `; latest ${latest.launch} ${options.launch === latest.launch ? "running" : latest.settled ? `${latest.settled.status} (reused ${latest.settled.reused}, changed ${latest.settled.changed}, new ${latest.settled.new})` : "did not settle"}` : ""}`,
		`Verification: ${state.verification ? `${state.verification.verdict} at ${short(state.verification.head)}${state.verification.head === state.integrationHead ? "" : " (head moved since)"}` : "not run"}`,
	];
	if (state.delivery) lines.push(`Delivery: ${state.delivery.mode} to ${state.delivery.target} at ${short(state.delivery.tip)}`);
	if (state.finished) lines.push(`Finished: ${state.finished.status} — ${state.finished.reason}`);
	if (state.decisions.length) lines.push(`Decisions: ${state.decisions.length}`);
	lines.push(`Lock: ${holder}`, `Directory: ${run.paths.dir}`);
	return lines.join("\n");
}

export function runDetails(run: RunStore, state: RunState, tasks: readonly PlanTask[]) {
	return {
		runId: run.runId, title: state.title, status: state.status, goalApproved: state.goal !== undefined,
		base: state.base, integrationHead: state.integrationHead, ...taskCounts(state, tasks),
		launches: [...state.launches.values()].map((record) => ({ launch: record.launch, status: record.settled?.status ?? "unsettled" })),
		verdict: state.verification?.verdict, dir: run.paths.dir,
	};
}
