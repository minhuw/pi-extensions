import type { ActivityView, SessionView } from "../src/protocol.ts";

export function session(overrides: Partial<SessionView> = {}): SessionView {
	const now = Date.now();
	return {
		version: 1, instanceId: "11111111-1111-4111-8111-111111111111", sessionId: "session-alpha", paneKey: "pane-alpha",
		title: "Review the Orca integration", cwd: "/projects/pi-extensions", model: "magpie/gpt-6",
		parent: "idle", waiting: false, startedAt: now - 120_000, updatedAt: now, activityCount: 2, online: true,
		activities: [
			{ source: "subagents", id: "agent:reviewer", label: "reviewer · Check lifecycle cleanup", kind: "agent", startedAt: now - 90_000, model: "magpie/gpt-6" },
			{ source: "herder", id: "step:T2", label: "Herder T2 · Verify the plugin", kind: "step", startedAt: now - 30_000 },
		],
		...overrides,
	};
}
export const empty: ActivityView = { sessions: [], truncated: false, unavailable: false };
export function activity(sessions = [session()]): ActivityView { return { ...empty, sessions }; }
