/**
 * Background activities from the `pi-extensions:activity` bus (the Orca bridge's activity protocol, copied from
 * `extensions/orca-bridge/activity.ts`): each snapshot replaces its source's list; rejected snapshots leave it intact.
 */
import { data, LIMITS, type Activity } from "./protocol.ts";

const MAX_SOURCES = 64;
const MAX_ACTIVITIES = 128;
const MAX_TOTAL = 1024;
const SOURCE = /^[a-zA-Z0-9_.-]+$/;

type Row = Omit<Activity, "source">;
export interface Snapshot { source: string; activities: Row[] }

const isText = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const timestamp = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseActivity(value: unknown): Row | undefined {
	const id = data(value, "id"), label = data(value, "label");
	if (!isText(id, 160) || !isText(label, 240)) return;
	const row: Row = { id, label };
	const kind = data(value, "kind"), state = data(value, "state"), startedAt = data(value, "startedAt"), model = data(value, "model"), progress = data(value, "progress");
	if (kind !== undefined) {
		if (kind !== "agent" && kind !== "workflow" && kind !== "step") return;
		row.kind = kind;
	}
	if (state !== undefined) {
		if (state !== "running" && state !== "waiting") return;
		row.state = state;
	}
	if (startedAt !== undefined) {
		if (!timestamp(startedAt)) return;
		row.startedAt = startedAt;
	}
	if (model !== undefined) {
		if (!isText(model, 240)) return;
		row.model = model;
	}
	if (progress !== undefined) {
		const completed = data(progress, "completed"), total = data(progress, "total");
		if (!timestamp(completed) || !timestamp(total) || total < 1 || completed > total) return;
		row.progress = { completed, total };
	}
	return row;
}

export function parseSnapshot(value: unknown): Snapshot | undefined {
	try {
		const source = data(value, "source");
		const rows = data(value, "activities");
		if (!isText(source, 64) || !SOURCE.test(source) || !Array.isArray(rows) || rows.length > MAX_ACTIVITIES) return;
		const activities: Row[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < rows.length; i++) {
			const row = parseActivity(data(rows, String(i)));
			if (!row || seen.has(row.id)) return;
			seen.add(row.id);
			activities.push(row);
		}
		return { source, activities };
	} catch { return undefined; }
}

export class Activities {
	private sources = new Map<string, Map<string, Row>>();
	get size(): number {
		let size = 0;
		for (const source of this.sources.values()) size += source.size;
		return size;
	}
	/** Applies a snapshot; true when the aggregate changed. */
	update(value: unknown): boolean {
		const snapshot = parseSnapshot(value);
		if (!snapshot) return false;
		const previous = this.sources.get(snapshot.source);
		if (!previous && snapshot.activities.length && this.sources.size >= MAX_SOURCES) return false;
		if (this.size - (previous?.size ?? 0) + snapshot.activities.length > MAX_TOTAL) return false;
		if ((previous?.size ?? 0) === snapshot.activities.length && snapshot.activities.every(row => JSON.stringify(previous?.get(row.id)) === JSON.stringify(row))) return false;
		if (snapshot.activities.length) this.sources.set(snapshot.source, new Map(snapshot.activities.map(row => [row.id, row])));
		else this.sources.delete(snapshot.source);
		return true;
	}
	/** At most `LIMITS.maxActivities` rows (the daemon's per-pane cap); `activityCount` carries the full total. */
	entries(): Activity[] {
		return [...this.sources]
			.flatMap(([source, rows]) => [...rows.values()].map(row => ({ source, ...row })))
			.slice(0, LIMITS.maxActivities);
	}
	clear(): void { this.sources.clear(); }
}
