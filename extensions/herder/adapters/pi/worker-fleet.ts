import type { PiWorkerSnapshot } from "./worker-engine.ts";

function roleLabel(role: PiWorkerSnapshot["role"]): string {
	return role.replace(/^plan-/, "");
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}t`;
	if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

function formatElapsed(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds < 3_600 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function workerFleetLines(workers: readonly PiWorkerSnapshot[], now = Date.now(), limit = 5): string[] {
	if (workers.length === 0) return [];
	const visible = workers.slice(0, limit);
	const lines = visible.map((worker) => {
		const icon = worker.status === "stopping" ? "■" : worker.status === "prepared" ? "○" : "●";
		const activity = worker.activity ? ` · ${worker.activity}` : "";
		return `${icon} ${worker.planId} ${roleLabel(worker.role)}${activity} · ${worker.toolUses} tools · ${formatTokens(worker.tokens)} · ${formatElapsed(worker.startedAt, now)}`;
	});
	if (workers.length > visible.length) lines.push(`  +${workers.length - visible.length} workers`);
	return lines;
}
