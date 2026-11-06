/** Versioned, metadata-only contract shared by Pi and the optional Orca plugin. */
export const PROTOCOL_VERSION = 1;
export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 20_000;
export const RETAIN_MS = 5 * 60_000;
export const MAX_ACTIVITIES = 32;
export const MAX_SESSIONS = 32;
export const MAX_SNAPSHOT_BYTES = 24 * 1024;
export const MAX_DIRECTORY_ENTRIES = 512;

export interface Activity {
	id: string;
	label: string;
	kind?: "agent" | "workflow" | "step";
	state?: "running" | "waiting";
	startedAt?: number;
	model?: string;
	progress?: { completed: number; total: number };
}
export interface SessionActivity extends Activity { source: string; startedAt: number }
export interface SessionSnapshot {
	version: 1;
	instanceId: string;
	sessionId: string;
	paneKey: string;
	title: string;
	cwd: string;
	model?: string;
	terminalId?: string;
	workspaceId?: string;
	parent: "running" | "idle";
	waiting: boolean;
	startedAt: number;
	updatedAt: number;
	activityCount: number;
	activities: SessionActivity[];
}
export interface SessionView extends SessionSnapshot { online: boolean }
export interface ActivityView {
	sessions: SessionView[];
	truncated: boolean;
	unavailable: boolean;
}

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const SOURCE = /^[a-zA-Z0-9_.-]+$/;
export const isText = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);
export const timestamp = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Never invoke accessors in extension events. JSON decoded from disk uses the same parser. */
export function data(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function parseActivity(value: unknown): Activity | undefined {
	const id = data(value, "id"), label = data(value, "label");
	if (!isText(id, 160) || !isText(label, 240)) return;
	const row: Activity = { id, label };
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

export function parseSession(value: unknown): SessionSnapshot | undefined {
	try {
		const instanceId = data(value, "instanceId"), sessionId = data(value, "sessionId"), paneKey = data(value, "paneKey"), title = data(value, "title"), cwd = data(value, "cwd");
		const parent = data(value, "parent"), waiting = data(value, "waiting"), startedAt = data(value, "startedAt"), updatedAt = data(value, "updatedAt"), count = data(value, "activityCount"), rows = data(value, "activities");
		if (data(value, "version") !== PROTOCOL_VERSION || typeof instanceId !== "string" || !UUID.test(instanceId) || !isText(sessionId, 160) || !isText(paneKey, 2048) || !isText(title, 240) || !isText(cwd, 4096)) return;
		if ((parent !== "running" && parent !== "idle") || typeof waiting !== "boolean" || !timestamp(startedAt) || !timestamp(updatedAt) || startedAt > updatedAt || !timestamp(count) || count > 1024 || !Array.isArray(rows) || rows.length > MAX_ACTIVITIES || count < rows.length) return;
		const snapshot: SessionSnapshot = { version: 1, instanceId, sessionId, paneKey, title, cwd, parent, waiting, startedAt, updatedAt, activityCount: count, activities: [] };
		for (const key of ["model", "terminalId", "workspaceId"] as const) {
			const field = data(value, key);
			if (field !== undefined) {
				if (!isText(field, key === "model" ? 240 : 2048)) return;
				snapshot[key] = field;
			}
		}
		const seen = new Set<string>();
		for (let i = 0; i < rows.length; i++) {
			const item = data(rows, String(i)), source = data(item, "source"), activity = parseActivity(item);
			if (!activity || !isText(source, 64) || !SOURCE.test(source) || !timestamp(activity.startedAt) || activity.startedAt > updatedAt) return;
			const key = `${source}:${activity.id}`;
			if (seen.has(key)) return;
			seen.add(key);
			snapshot.activities.push({ ...activity, source, startedAt: activity.startedAt });
		}
		return snapshot;
	} catch { return; }
}

export function sessionState(session: SessionView): "working" | "waiting" | "idle" | "disconnected" {
	if (!session.online) return "disconnected";
	if (session.waiting || session.activities.some(row => row.state === "waiting")) return "waiting";
	return session.parent === "running" || session.activityCount > 0 ? "working" : "idle";
}

export function summarize(view: ActivityView) {
	const online = view.sessions.filter(session => session.online);
	return {
		sessions: online.length,
		working: online.filter(session => sessionState(session) === "working").length,
		waiting: online.filter(session => sessionState(session) === "waiting").length,
		activities: online.reduce((total, session) => total + session.activityCount, 0),
		disconnected: view.sessions.length - online.length,
	};
}
