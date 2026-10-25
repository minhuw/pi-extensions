import type { StepActivity } from "./runtime.ts";

export interface Activity { id: string; label: string }
export interface ActivitySnapshot { source: "herder"; activities: Activity[] }

const MAX_ACTIVITIES = 128;

const clean = (text: string, max: number) => {
	const value = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

/** Orca-compatible rows: short ids, labels without control characters, at most 128 entries. */
export function activities(running: readonly StepActivity[]): Activity[] {
	const rows = running.map((step) => ({
		id: clean(`step:${step.key}`, 160),
		label: clean(`Herder ${[step.task, step.label || step.phase || step.key].filter(Boolean).join(" · ")}`, 240),
	}));
	return rows.length <= MAX_ACTIVITIES ? rows : [...rows.slice(0, MAX_ACTIVITIES - 1), { id: "overflow", label: `${rows.length - MAX_ACTIVITIES + 1} more Herder steps` }];
}

/** Running steps of this session; publishes a snapshot whenever the set or a label changes. */
export class ActivityBoard {
	readonly #live = new Map<string, StepActivity>();
	readonly #emit: (snapshot: ActivitySnapshot) => void;
	#published = "[]";
	constructor(emit: (snapshot: ActivitySnapshot) => void) { this.#emit = emit; }

	running(): StepActivity[] { return [...this.#live.values()]; }

	update(activity: StepActivity): void {
		if (activity.state === "running") this.#live.set(activity.key, activity);
		else this.#live.delete(activity.key);
		this.publish();
	}

	clear(force = false): void {
		this.#live.clear();
		this.publish(force);
	}

	/** `force` re-sends the current snapshot (activity requests). */
	publish(force = false): void {
		const rows = activities(this.running());
		const text = JSON.stringify(rows);
		if (!force && text === this.#published) return;
		this.#published = text;
		this.#emit({ source: "herder", activities: rows });
	}
}
