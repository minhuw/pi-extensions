import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultDirectory, hasCompanion, remove, snapshotName, writeJson } from "./plugin/src/files.ts";
import { HEARTBEAT_MS, MAX_ACTIVITIES, MAX_SNAPSHOT_BYTES, parseSession, type Activity, type SessionSnapshot } from "./plugin/src/protocol.ts";

export class SnapshotPublisher {
	readonly instanceId = randomUUID();
	status = "waiting for plugin";
	private timer?: ReturnType<typeof setInterval>;
	private scheduled?: ReturnType<typeof setTimeout>;
	private pending = false;
	private stopped = false;
	private flight?: Promise<void>;
	constructor(readonly directory: string, private readonly snapshot: (id: string, now: number) => SessionSnapshot | undefined) {}

	start(): void {
		if (this.timer || this.stopped) return;
		this.timer = setInterval(() => this.update(), HEARTBEAT_MS);
		this.timer.unref();
		this.update();
	}
	update(): void {
		if (this.stopped) return;
		this.pending = true;
		if (this.flight || this.scheduled) return;
		this.scheduled = setTimeout(() => {
			this.scheduled = undefined;
			this.flight = this.publish().finally(() => {
				this.flight = undefined;
				if (this.pending && !this.stopped) this.update();
			});
		}, 100);
		this.scheduled.unref();
	}
	private async publish(): Promise<void> {
		this.pending = false;
		try {
			const now = Date.now();
			if (!(await hasCompanion(this.directory, now))) {
				this.status = "waiting for plugin";
				await remove(this.directory, snapshotName(this.instanceId));
				return;
			}
			if (this.stopped) return;
			const snapshot = this.snapshot(this.instanceId, now);
			if (!snapshot) { this.status = "session metadata unavailable"; return; }
			await writeJson(this.directory, snapshotName(this.instanceId), snapshot);
			this.status = "connected";
		} catch { this.status = "local snapshot unavailable"; }
	}
	async close(): Promise<void> {
		this.stopped = true;
		clearInterval(this.timer);
		clearTimeout(this.scheduled);
		await this.flight;
		await remove(this.directory, snapshotName(this.instanceId));
		this.status = "closed";
	}
}

interface State {
	ctx?: ExtensionContext;
	parent: boolean;
	promptDepth: number;
	activities: Array<Activity & { source: string; key: string }>;
}
const clean = (value: unknown, max: number): string | undefined => {
	if (typeof value !== "string") return;
	return value.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, max) || undefined;
};

/** Optional local metadata projection. It never changes Pi idle state or the terminal hook owner. */
export class Companion {
	private publisher?: SnapshotPublisher;
	private starts = new Map<string, number>();
	private parentStartedAt = Date.now();
	private previousParent = false;
	private inactive = "inactive";
	constructor(private readonly state: () => State) {}
	get status(): string { return this.publisher?.status ?? this.inactive; }
	start(): void {
		if (this.publisher || process.env.PI_ORCA_COMPANION === "off") { this.inactive = "disabled"; return; }
		const directory = process.env.PI_ORCA_COMPANION_DIR ?? defaultDirectory();
		if (!isAbsolute(directory)) { this.inactive = "invalid directory"; return; }
		this.publisher = new SnapshotPublisher(directory, (id, now) => this.snapshot(id, now));
		this.publisher.start();
	}
	update(): void { this.publisher?.update(); }
	async close(): Promise<void> { await this.publisher?.close(); this.starts.clear(); }

	private snapshot(instanceId: string, now: number): SessionSnapshot | undefined {
		try {
			const { ctx, parent, promptDepth, activities } = this.state();
			if (!ctx || ctx.mode !== "tui") return;
			const sessionId = clean(ctx.sessionManager.getSessionId(), 160), paneKey = clean(process.env.ORCA_PANE_KEY, 2048), cwd = clean(ctx.cwd, 4096);
			if (!sessionId || !paneKey || !cwd) return;
			const running = parent || (typeof ctx.isIdle === "function" && !ctx.isIdle());
			if (running && !this.previousParent) this.parentStartedAt = now;
			this.previousParent = running;
			const live = new Set(activities.map(row => row.key));
			for (const key of this.starts.keys()) if (!live.has(key)) this.starts.delete(key);
			for (const row of activities) if (!this.starts.has(row.key)) this.starts.set(row.key, row.startedAt ?? now);
			const rows = [...activities].sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting"));
			const model = clean(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, 240);
			const terminalId = clean(process.env.PI_ORCA_TERMINAL_ID, 2048), workspaceId = clean(process.env.PI_ORCA_WORKSPACE_ID ?? process.env.ORCA_WORKTREE_ID, 2048);
			const snapshot: SessionSnapshot = {
				version: 1, instanceId, sessionId, paneKey, cwd,
				title: clean(ctx.sessionManager.getSessionName?.(), 240) ?? clean(basename(cwd), 240) ?? "Pi session",
				...(model ? { model } : {}), ...(terminalId ? { terminalId } : {}), ...(workspaceId ? { workspaceId } : {}),
				parent: running ? "running" : "idle", waiting: promptDepth > 0,
				startedAt: this.parentStartedAt, updatedAt: now, activityCount: activities.length,
				activities: rows.slice(0, MAX_ACTIVITIES).map(({ key, ...row }) => ({ ...row, startedAt: Math.min(row.startedAt ?? this.starts.get(key) ?? now, now) })),
			};
			while (snapshot.activities.length && Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) snapshot.activities.pop();
			return parseSession(snapshot);
		} catch { return; }
	}
}
