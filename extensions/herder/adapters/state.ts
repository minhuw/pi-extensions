import { RUN_STATUSES, type RunStatus } from "../src/shared/protocol.ts";

export const HERDER_STATE_ENTRY = "herder-pi-run-v1";

export interface HerderRunState {
	version: 1;
	mode: "fire" | "resume" | "revise" | "attach";
	status: RunStatus;
	runId: string;
	/** Session-local hint only; SQLite remains authoritative for attention state. */
	attentionRequestId?: string;
	repoRoot: string;
	planDir: string;
	profile: string;
	maxParallel: number;
	startedAt: number;
	updatedAt: number;
	dashboardUrl?: string;
}

export function sameHerderRunState(left: HerderRunState, right: HerderRunState): boolean {
	return left.version === right.version
		&& left.mode === right.mode
		&& left.status === right.status
		&& left.runId === right.runId
		&& left.attentionRequestId === right.attentionRequestId
		&& left.repoRoot === right.repoRoot
		&& left.planDir === right.planDir
		&& left.profile === right.profile
		&& left.maxParallel === right.maxParallel
		&& left.startedAt === right.startedAt
		&& left.dashboardUrl === right.dashboardUrl;
}

function isRunState(value: unknown): value is HerderRunState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Partial<HerderRunState>;
	return state.version === 1
		&& (state.attentionRequestId === undefined || (typeof state.attentionRequestId === "string" && state.attentionRequestId.length > 0 && state.attentionRequestId.length <= 200 && !/[\0\r\n]/.test(state.attentionRequestId)))
		&& typeof state.runId === "string"
		&& typeof state.repoRoot === "string"
		&& typeof state.planDir === "string"
		&& typeof state.profile === "string"
		&& typeof state.maxParallel === "number"
		&& typeof state.startedAt === "number"
		&& typeof state.updatedAt === "number"
		&& ["fire", "resume", "revise", "attach"].includes(state.mode || "")
		&& RUN_STATUSES.some((status) => status === state.status);
}

export function restoreLastRun(entries: readonly unknown[]): HerderRunState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry?.type === "custom" && entry.customType === HERDER_STATE_ENTRY && isRunState(entry.data)) return entry.data;
	}
	return undefined;
}
