import { defineCheck } from "orca/testing";
import { activity, empty, session } from "../tests/fixtures.ts";

export default defineCheck({
	empty: { requests: { "activity.list": empty } },
	working: { requests: { "activity.list": activity() } },
	waiting: { requests: { "activity.list": activity([session({
		waiting: true,
		activities: [{ source: "subagents", id: "workflow:1", label: "Review all modules", kind: "workflow", state: "waiting", startedAt: Date.now() - 60_000, progress: { completed: 3, total: 5 } }],
		activityCount: 1,
	})]) } },
	disconnected: { requests: { "activity.list": activity([session({ online: false })]) } },
	unavailable: { requests: { "activity.list": { ...empty, unavailable: true } } },
	"long-labels": { requests: { "activity.list": activity([session({
		title: "Review background activity reconciliation across multiple workspace and session boundaries",
		cwd: "/projects/long-workspace-name/packages/background-activity-and-session-reconciliation",
		activities: [{ source: "subagents", id: "agent:1", label: "reviewer · Verify that background agents remain visible when the parent settles and reconnect correctly after the plugin restarts", startedAt: Date.now() - 120_000 }],
		activityCount: 1,
	})]) } },
});
