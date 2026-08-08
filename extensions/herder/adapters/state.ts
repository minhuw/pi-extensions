export const HERDER_STATE_ENTRY = "herder-pi-run-v1";

export interface HerderRunState {
	version: 1;
	mode: "fire" | "resume" | "revise";
	status: "initializing" | "running" | "paused" | "needs_input" | "complete" | "failed" | "stopped";
	runId: string;
	asyncDir?: string;
	repoRoot: string;
	planDir: string;
	profile: string;
	maxParallel: number;
	dashboardEnabled: boolean;
	startedAt: number;
	updatedAt: number;
	dashboardUrl?: string;
}

function isRunState(value: unknown): value is HerderRunState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Partial<HerderRunState>;
	return state.version === 1
		&& typeof state.runId === "string"
		&& typeof state.repoRoot === "string"
		&& typeof state.planDir === "string"
		&& typeof state.profile === "string"
		&& typeof state.maxParallel === "number"
		&& typeof state.dashboardEnabled === "boolean"
		&& typeof state.startedAt === "number"
		&& typeof state.updatedAt === "number"
		&& ["fire", "resume", "revise"].includes(state.mode || "")
		&& ["initializing", "running", "paused", "needs_input", "complete", "failed", "stopped"].includes(state.status || "");
}

export function restoreLastRun(entries: readonly unknown[]): HerderRunState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry?.type === "custom" && entry.customType === HERDER_STATE_ENTRY && isRunState(entry.data)) return entry.data;
	}
	return undefined;
}
