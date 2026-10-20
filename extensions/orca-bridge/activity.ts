/** Bounded source snapshots; rejected updates leave the previous snapshot intact. */
export interface Activity { id: string; label: string }
export interface Snapshot { source: string; activities: Activity[] }
const MAX_SOURCES = 64;
const MAX_ACTIVITIES = 128;
const MAX_TOTAL = 1024;
const text = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);

// Read data properties only: malformed extension messages must not execute getters.
function data(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
export function parseSnapshot(value: unknown): Snapshot | undefined {
	try {
		const source = data(value, "source");
		const rows = data(value, "activities");
		// A colon-free source makes the managed protocol's source:id namespace unambiguous.
		if (!text(source, 64) || !/^[a-zA-Z0-9_.-]+$/.test(source) || !Array.isArray(rows) || rows.length > MAX_ACTIVITIES) return;
		const activities: Activity[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < rows.length; i++) {
			const row = data(rows, String(i));
			const id = data(row, "id");
			const label = data(row, "label");
			if (!text(id, 160) || !text(label, 240) || seen.has(id)) return;
			seen.add(id);
			activities.push({ id, label });
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
		if ((previous?.size ?? 0) === snapshot.activities.length && snapshot.activities.every(row => previous?.get(row.id)?.label === row.label)) return false;
		if (snapshot.activities.length) this.sources.set(snapshot.source, new Map(snapshot.activities.map(row => [row.id, row])));
		else this.sources.delete(snapshot.source);
		return true;
	}
	entries(): Array<Activity & { source: string; key: string }> {
		return [...this.sources].flatMap(([source, rows]) => [...rows.values()].map(row => ({ ...row, source, key: `pi-extensions:${source}:${row.id}` })));
	}
	clear(): void { this.sources.clear(); }
}
