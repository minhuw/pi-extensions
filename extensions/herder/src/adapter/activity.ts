import type { StepActivity } from "./runtime.ts";

export interface Activity { id: string; label: string; kind?: "step"; startedAt?: number }
export interface ActivitySnapshot { source: "herder"; activities: Activity[] }

const MAX_ACTIVITIES = 128;

const clean = (text: string, max: number) => {
	const value = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

const stepTitle = (step: StepActivity) => [step.task, step.label || step.phase || step.key].filter(Boolean).join(" · ");

const cap = (rows: Activity[]): Activity[] =>
	rows.length <= MAX_ACTIVITIES ? rows : [...rows.slice(0, MAX_ACTIVITIES - 1), { id: "overflow", label: `${rows.length - MAX_ACTIVITIES + 1} more Herder steps` }];

const stepRow = (step: StepActivity, runId?: string): Activity => ({
	id: clean(runId ? `step:${runId}:${step.key}` : `step:${step.key}`, 160),
	label: clean(`Herder ${[runId, stepTitle(step)].filter(Boolean).join(" · ")}`, 240),
	kind: "step" as const,
	...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
});

/** Orca-compatible rows: short ids, labels without control characters, at most 128 entries. */
export function activities(running: readonly StepActivity[], runId?: string): Activity[] {
	return cap(running.map((step) => stepRow(step, runId)));
}

/** Running steps across active runs; publishes a snapshot whenever the set or a label changes. */
export class ActivityBoard {
	readonly #live = new Map<string, Map<string, StepActivity>>();
	readonly #emit: (snapshot: ActivitySnapshot) => void;
	#published = "[]";
	constructor(emit: (snapshot: ActivitySnapshot) => void) { this.#emit = emit; }

	running(runId?: string): StepActivity[] {
		if (runId !== undefined) return [...(this.#live.get(runId)?.values() ?? [])];
		const all: StepActivity[] = [];
		for (const steps of this.#live.values()) all.push(...steps.values());
		return all;
	}

	update(runId: string, activity: StepActivity): void {
		if (activity.state === "running") {
			let steps = this.#live.get(runId);
			if (!steps) this.#live.set(runId, steps = new Map());
			steps.set(activity.key, activity);
		} else {
			const steps = this.#live.get(runId);
			steps?.delete(activity.key);
			if (steps && !steps.size) this.#live.delete(runId);
		}
		this.publish();
	}

	clearRun(runId: string | undefined, force = false): void {
		if (runId) this.#live.delete(runId);
		this.publish(force);
	}

	clear(force = false): void {
		this.#live.clear();
		this.publish(force);
	}

	/** `force` re-sends the current snapshot (activity requests). */
	publish(force = false): void {
		let rows: Activity[];
		if (this.#live.size <= 1) {
			rows = activities(this.running());
		} else {
			const combined: Activity[] = [];
			for (const [runId, steps] of this.#live) {
				for (const step of steps.values()) combined.push(stepRow(step, runId));
			}
			rows = cap(combined);
		}
		const text = JSON.stringify(rows);
		if (!force && text === this.#published) return;
		this.#published = text;
		this.#emit({ source: "herder", activities: rows });
	}
}
