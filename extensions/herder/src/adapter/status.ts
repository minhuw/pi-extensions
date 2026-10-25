import { readFileSync } from "node:fs";
import { parsePlanTasks, type PlanTask } from "../artifacts/plan.ts";
import type { RunState } from "../journal/fold.ts";
import type { LockInfo } from "../run/lock.ts";
import type { RunStore } from "../run/store.ts";
import type { StepActivity } from "./runtime.ts";

export const FINISHED_STATUSES: ReadonlySet<string> = new Set(["delivered", "abandoned", "failed"]);
export const isFinished = (state: RunState) => FINISHED_STATUSES.has(state.status);
const short = (sha: string | undefined) => (sha ? sha.slice(0, 12) : "—");
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

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

export interface StatusInput { state: RunState; tasks: readonly PlanTask[]; running: readonly StepActivity[]; launch?: number }

/** Footer text such as `herder: T2 integrate · 3/5 tasks`; undefined once the run is finished. */
export function statusText({ state, tasks, running, launch }: StatusInput): string | undefined {
	if (state.runId === undefined || isFinished(state)) return undefined;
	const step = running.at(-1);
	const verified = state.verification?.head === state.integrationHead ? state.verification : undefined;
	const now = step ? [step.task, step.phase || step.label || step.key].filter(Boolean).join(" ")
		: launch !== undefined ? `launch ${launch}`
		: state.status === "drafting" ? "drafting goal"
		: verified ? `verified ${verified.verdict}` : "ready";
	const { done, total } = taskCounts(state, tasks);
	return `herder: ${clip(now, 40)}${total ? ` · ${done}/${total} tasks` : ""}`;
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
