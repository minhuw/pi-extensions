import type {
	CheckCompletedEvent, CheckSpec, DecisionRecordedEvent, DeliveryCompletedEvent, DeliveryStartedEvent, GoalApprovedEvent, IntegrateCompletedEvent,
	IntegrateFailedEvent, JournalEvent, RunFinishedEvent, ScriptLaunchedEvent, ScriptSettledEvent, StepCompletedEvent,
	StepFailedEvent, StepStartedEvent, VerifyCompletedEvent,
} from "../types.ts";

export type RunOverallStatus = "drafting" | "approved" | "delivered" | "abandoned" | "failed";
export type StepState = "running" | "ok" | "no_changes" | "gate_failed" | "failed" | "stopped";
/** `ready`: the task's latest step settled successfully but nothing is integrated for it yet. */
export type TaskState = "pending" | "running" | "ready" | "failed" | "integrated";

export interface LaunchRecord { launch: number; launched: ScriptLaunchedEvent; settled?: ScriptSettledEvent }
/** The latest attempt of a step. `started` is absent when a completion was adopted from an existing ref. */
export interface StepRecord { key: string; status: StepState; started?: StepStartedEvent; completed?: StepCompletedEvent; failed?: StepFailedEvent; task?: string }
export interface TaskRecord { id: string; status: TaskState; lastStep?: string; integratedCommit?: string; steps: string[] }
export type HistoryEvent =
	| ScriptSettledEvent | StepCompletedEvent | StepFailedEvent | CheckCompletedEvent | IntegrateCompletedEvent
	| IntegrateFailedEvent | VerifyCompletedEvent | DecisionRecordedEvent | DeliveryCompletedEvent | RunFinishedEvent;

export interface RunState {
	runId?: string; title?: string; base?: string; repo?: string; runtime?: string;
	status: RunOverallStatus;
	goal?: { sha256: string; checks: CheckSpec[]; event: GoalApprovedEvent };
	planSha256?: string;
	launches: Map<number, LaunchRecord>;
	steps: Map<string, StepRecord>;
	/** Latest `step.completed` per (key, fingerprint); use `findCompletion`. */
	completions: Map<string, StepCompletedEvent>;
	/** Count of `step.started` with `attempt === 1` (the per-run agent cap). */
	liveAgentStarts: number;
	integrations: IntegrateCompletedEvent[];
	integrationFailures: IntegrateFailedEvent[];
	/** Last `integrate.completed.head`, else the run base. */
	integrationHead?: string;
	checks: CheckCompletedEvent[];
	verification?: VerifyCompletedEvent;
	decisions: DecisionRecordedEvent[];
	/** The latest `delivery.started`; a delivery that started but has no later `delivery.completed` was interrupted. */
	deliveryStarted?: DeliveryStartedEvent;
	delivery?: DeliveryCompletedEvent;
	finished?: RunFinishedEvent;
	tasks: Map<string, TaskRecord>;
	/** Settled outcomes in journal order (for progress.md). */
	history: HistoryEvent[];
}

const completionId = (key: string, fingerprint: string) => JSON.stringify([key, fingerprint]);

export function findCompletion(state: RunState, key: string, fingerprint: string): StepCompletedEvent | undefined {
	return state.completions.get(completionId(key, fingerprint));
}

export function findIntegration(state: RunState, key: string): IntegrateCompletedEvent | undefined {
	return state.integrations.findLast((event) => event.key === key);
}

/** Pure, in-order fold. Unknown event types are ignored. */
export function fold(events: readonly JournalEvent[]): RunState {
	const state: RunState = {
		status: "drafting", launches: new Map(), steps: new Map(), completions: new Map(), liveAgentStarts: 0,
		integrations: [], integrationFailures: [], checks: [], decisions: [], tasks: new Map(), history: [],
	};
	// Per task: the latest settled outcome of its steps or integrations (true = success).
	const outcomes = new Map<string, boolean>();
	const task = (id: string): TaskRecord => {
		let record = state.tasks.get(id);
		if (!record) state.tasks.set(id, record = { id, status: "pending", steps: [] });
		return record;
	};
	const settle = (key: string, ok: boolean) => {
		const id = state.steps.get(key)?.task;
		if (id !== undefined) outcomes.set(id, ok);
	};
	for (const event of events) {
		switch (event.t) {
			case "run.started":
				if (state.runId === undefined) Object.assign(state, { runId: event.runId, title: event.title, base: event.base, repo: event.repo, runtime: event.runtime });
				break;
			case "goal.approved": state.goal = { sha256: event.sha256, checks: event.checks, event }; break;
			case "plan.updated": state.planSha256 = event.sha256; break;
			case "script.launched": state.launches.set(event.launch, { launch: event.launch, launched: event }); break;
			case "script.settled": {
				const record = state.launches.get(event.launch);
				if (record) record.settled = event;
				state.history.push(event);
				break;
			}
			case "step.started": {
				if (event.attempt === 1) state.liveAgentStarts++;
				const previous = state.steps.get(event.key);
				state.steps.set(event.key, { key: event.key, status: "running", started: event, task: event.task ?? previous?.task });
				if (event.task !== undefined) {
					const record = task(event.task);
					record.lastStep = event.key;
					if (!record.steps.includes(event.key)) record.steps.push(event.key);
				}
				break;
			}
			case "step.completed": {
				const previous = state.steps.get(event.key);
				const started = previous?.started?.fingerprint === event.fingerprint ? previous.started : undefined;
				state.steps.set(event.key, { key: event.key, status: event.status, started, completed: event, task: previous?.task });
				state.completions.set(completionId(event.key, event.fingerprint), event);
				settle(event.key, event.status !== "gate_failed");
				state.history.push(event);
				break;
			}
			case "step.failed": {
				const previous = state.steps.get(event.key);
				const started = previous?.started?.fingerprint === event.fingerprint ? previous.started : undefined;
				state.steps.set(event.key, { key: event.key, status: event.errorClass === "stopped" ? "stopped" : "failed", started, failed: event, task: previous?.task });
				if (event.final || event.errorClass === "stopped") settle(event.key, false);
				state.history.push(event);
				break;
			}
			case "check.completed": state.checks.push(event); state.history.push(event); break;
			case "integrate.completed":
				state.integrations.push(event);
				state.integrationHead = event.head;
				if (event.task !== undefined) {
					const record = task(event.task);
					record.integratedCommit = event.head;
					outcomes.set(event.task, true);
				}
				state.history.push(event);
				break;
			case "integrate.failed":
				state.integrationFailures.push(event);
				if (event.task !== undefined) { task(event.task); outcomes.set(event.task, false); }
				state.history.push(event);
				break;
			case "verify.completed": state.verification = event; state.history.push(event); break;
			case "decision.recorded": state.decisions.push(event); state.history.push(event); break;
			case "delivery.started": state.deliveryStarted = event; break;
			case "delivery.completed": state.delivery = event; state.history.push(event); break;
			case "run.finished": state.finished = event; state.history.push(event); break;
		}
	}
	state.integrationHead ??= state.base;
	state.status = state.finished?.status ?? (state.delivery ? "delivered" : state.goal ? "approved" : "drafting");
	for (const record of state.tasks.values()) {
		const outcome = outcomes.get(record.id);
		record.status = record.integratedCommit !== undefined ? "integrated"
			: record.steps.some((key) => state.steps.get(key)?.status === "running") ? "running"
			: outcome === undefined ? "pending" : outcome ? "ready" : "failed";
	}
	return state;
}
