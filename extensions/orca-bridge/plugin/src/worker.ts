import { randomUUID } from "node:crypto";
import type { OrcaWorkerApi } from "orca/worker";
import type {} from "./api.ts";
import { defaultDirectory, entries, presenceName, privateDirectory, readJson, remove, writeJson } from "./files.ts";
import { HEARTBEAT_MS, MAX_SESSIONS, RETAIN_MS, STALE_MS, parseSession, sessionState, summarize, timestamp, type ActivityView, type SessionView } from "./protocol.ts";

const priority = { waiting: 0, working: 1, idle: 2, disconnected: 3 };

export class CompanionRuntime {
	private readonly id = randomUUID();
	private readonly subscriptions: Array<{ dispose(): void }> = [];
	private timer?: ReturnType<typeof setInterval>;
	private flight?: Promise<void>;
	private stopped = false;
	private heartbeat = 0;
	private revision = 0;
	private previous = "";
	private previousStatus = "";
	private statusFailed = false;
	private view: ActivityView = { sessions: [], truncated: false, unavailable: false };
	constructor(private readonly orca: OrcaWorkerApi, readonly directory = defaultDirectory()) {}

	async start(): Promise<void> {
		this.subscriptions.push(
			this.orca.panels.handle("activity.list", async () => { await this.poll(); return this.view; }),
			this.orca.commands.register("activity.summary", async () => {
				await this.poll();
				if (this.view.unavailable) return "Pi activity is unavailable. Open the Pi Activity panel and retry.";
				return this.view.sessions.length ? this.view.sessions.map(session =>
					`${session.title}: ${sessionState(session)} · ${session.activityCount} background activities\n${session.cwd}`
				).join("\n\n") : "No local Pi terminal sessions are connected. Open Pi with orca-bridge enabled, then open the Pi Activity sidebar panel.";
			}),
			// Declared launch hooks keep the worker alive while the plugin is enabled. Only
			// correlation metadata is added; commands, prompts and ORCA_* variables are untouched.
			this.orca.hooks.on("agent.launch.before", (event, next) => event.agent !== "pi" ? next(event) : next({
				...event,
				env: { ...event.env, PI_ORCA_TERMINAL_ID: event.terminalId ?? "", PI_ORCA_WORKSPACE_ID: event.workspaceId ?? "" },
			})),
		);
		await this.poll();
		if (!this.stopped) {
			this.timer = setInterval(() => { void this.poll(); }, 2_000);
			this.timer.unref();
		}
	}

	poll(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		return this.flight ??= this.scan().finally(() => { this.flight = undefined; });
	}

	private async scan(): Promise<void> {
		try {
			if (!(await privateDirectory(this.directory, true))) throw new Error("Unavailable directory");
			const now = Date.now();
			if (now - this.heartbeat >= HEARTBEAT_MS) {
				await writeJson(this.directory, presenceName(this.id), { version: 1, updatedAt: now });
				this.heartbeat = now;
			}
			const listed = await entries(this.directory);
			const panes = new Map<string, SessionView>();
			for (const name of listed.names) {
				const value = await readJson(this.directory, name);
				if (name.startsWith("plugin-")) {
					const marker = value as { updatedAt?: unknown } | undefined;
					if (timestamp(marker?.updatedAt) && now - marker.updatedAt > RETAIN_MS) await remove(this.directory, name);
					continue;
				}
				const session = parseSession(value);
				// A publisher may atomically replace a file after this scan began.
				const age = session ? Date.now() - session.updatedAt : -1;
				if (!session || name !== `session-${session.instanceId}.json` || age < 0) continue;
				if (age > RETAIN_MS) { await remove(this.directory, name); continue; }
				const old = panes.get(session.paneKey);
				if (!old || old.updatedAt < session.updatedAt) panes.set(session.paneKey, { ...session, online: age <= STALE_MS });
			}
			const sessions = [...panes.values()].sort((a, b) => priority[sessionState(a)] - priority[sessionState(b)] || a.title.localeCompare(b.title) || a.paneKey.localeCompare(b.paneKey));
			this.view = { sessions: sessions.slice(0, MAX_SESSIONS), truncated: listed.truncated || sessions.length > MAX_SESSIONS, unavailable: false };
		} catch {
			this.view = { sessions: this.view.sessions.map(session => ({ ...session, online: false })), truncated: this.view.truncated, unavailable: true };
		}
		if (this.stopped) return;
		const serialized = JSON.stringify(this.view);
		if (serialized !== this.previous) {
			this.previous = serialized;
			try { this.orca.panels.post("activity.changed", { revision: ++this.revision }); }
			catch { /* An open panel also revalidates when push delivery is unavailable. */ }
		}
		await this.updateStatus();
	}

	private async updateStatus(): Promise<void> {
		if (!this.orca.host.has("statusBar.update")) return;
		const counts = summarize(this.view);
		const text = this.view.unavailable ? "π · Unavailable" : counts.waiting ? `π · ${counts.waiting} waiting` : counts.working ? `π · ${counts.working} working` : counts.sessions ? `π · ${counts.sessions} idle` : counts.disconnected ? "π · Disconnected" : "π · No sessions";
		const params = {
			id: "activity", text: counts.activities ? `${text} · ${counts.activities} tasks` : text,
			tone: this.view.unavailable || counts.waiting || (!counts.sessions && counts.disconnected) ? "warning" as const : counts.working ? "accent" as const : "neutral" as const,
			tooltip: `Local Pi terminal sessions: ${counts.sessions} connected, ${counts.waiting} waiting, ${counts.activities} background activities. Click for a summary; open Pi Activity in the sidebar for details.${this.view.truncated ? " Showing a limited set of sessions." : ""}`,
			visible: true,
		};
		const signature = JSON.stringify(params);
		if (signature === this.previousStatus) return;
		try {
			await this.orca.host.call("statusBar.update", params);
			this.previousStatus = signature;
			this.statusFailed = false;
		} catch {
			if (!this.statusFailed) this.orca.log("Pi activity status bar could not update; the panel remains available.");
			this.statusFailed = true;
		}
	}

	async close(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		clearInterval(this.timer);
		for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
		await this.flight;
		await remove(this.directory, presenceName(this.id));
		if (this.orca.host.has("statusBar.update")) await this.orca.host.call("statusBar.update", { id: "activity", visible: false }).catch(() => {});
	}
}

let runtime: CompanionRuntime | undefined;
export default async function activate(orca: OrcaWorkerApi): Promise<void> {
	runtime = new CompanionRuntime(orca);
	await runtime.start();
}
export async function deactivate(): Promise<void> { await runtime?.close(); runtime = undefined; }
