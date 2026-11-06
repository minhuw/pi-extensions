import { data, isText as text, parseActivity, type Activity } from "./plugin/src/protocol.ts";
export type { Activity } from "./plugin/src/protocol.ts";

/** Bounded source snapshots; rejected updates leave the previous snapshot intact. */
export interface Snapshot { source: string; activities: Activity[] }
const MAX_SOURCES = 64;
const MAX_ACTIVITIES = 128;
const MAX_TOTAL = 1024;
export function parseSnapshot(value: unknown): Snapshot | undefined {
	try {
		const source = data(value, "source");
		const rows = data(value, "activities");
		// A colon-free source makes the managed protocol's source:id namespace unambiguous.
		if (!text(source, 64) || !/^[a-zA-Z0-9_.-]+$/.test(source) || !Array.isArray(rows) || rows.length > MAX_ACTIVITIES) return;
		const activities: Activity[] = [];
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
	private sources = new Map<string, Map<string, Activity>>();
	get size(): number {
		let size = 0;
		for (const source of this.sources.values()) size += source.size;
		return size;
	}
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
	entries(): Array<Activity & { source: string; key: string }> {
		return [...this.sources].flatMap(([source, rows]) => [...rows.values()].map(row => ({ ...row, source, key: `pi-extensions:${source}:${row.id}` })));
	}
	clear(): void { this.sources.clear(); }
}
