import { createHash } from "node:crypto";
import { nextDue, type Schedule, type StartOptions } from "./command.ts";

export const SNAPSHOT = "loop:snapshot";
export const ITERATION = "loop:iteration";
export const MAX_LOOPS = 20;
export type LoopStatus = "scheduled" | "running" | "paused" | "done" | "stopped" | "failed";
export interface Loop {
	id: string;
	name: string;
	prompt: string;
	schedule: Schedule;
	status: LoopStatus;
	createdAt: number;
	deadline: number;
	dueAt: number | null;
	iteration: number;
	max: number;
	timeoutMs: number;
	until?: string;
	converged?: number;
	lastHash?: string;
	identical: number;
	failures: number;
	reason?: string;
}
export const terminal = (loop: Loop) => ["done", "stopped", "failed"].includes(loop.status);
export function makeLoop(options: StartOptions, id: string, now: number): Loop {
	return {
		id, name: options.name ?? id, prompt: options.prompt, schedule: options.schedule,
		status: "scheduled", createdAt: now, deadline: now + options.forMs,
		dueAt: options.wait && options.schedule.kind !== "dynamic" ? nextDue(options.schedule, now, now) : now,
		iteration: 0, max: options.max, timeoutMs: options.timeoutMs, until: options.until,
		converged: options.converged, identical: 0, failures: 0,
	};
}
export function completion(loop: Loop, text: string): string | undefined {
	if (!text.trim()) { loop.identical = 0; loop.lastHash = undefined; return undefined; }
	if (loop.until && text.includes(loop.until)) return "completion text matched";
	if (!loop.converged) return undefined;
	const hash = createHash("sha256").update(text.trim()).digest("hex");
	loop.identical = hash === loop.lastHash ? loop.identical + 1 : 1;
	loop.lastHash = hash;
	return loop.identical >= loop.converged ? `${loop.identical} identical replies` : undefined;
}
export const clampDelay = (seconds: number) => Math.min(3600, Math.max(60, Math.round(seconds)));
export function scheduleNext(loop: Loop, now: number, delaySeconds = 300): void {
	loop.dueAt = loop.schedule.kind === "dynamic"
		? now + clampDelay(delaySeconds) * 1000
		: nextDue(loop.schedule, now, loop.createdAt);
}
export function eta(ms: number): string {
	if (ms <= 0) return "due";
	if (ms < 60_000) return "<1m";
	if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
	return `${Math.ceil(ms / 3_600_000)}h`;
}
export function summary(loops: Loop[], activeId: string | undefined, now: number): string | undefined {
	const live = loops.filter((loop) => !terminal(loop));
	if (!live.length) return undefined;
	const active = live.find((loop) => loop.id === activeId && loop.status === "running");
	const scheduled = live.filter((loop) => loop.status === "scheduled").sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
	const chosen = active ?? scheduled[0] ?? live[0]!;
	const label = live.length === 1 ? chosen.name : `${live.length} loops`;
	const prefix = active && live.length > 1 ? `${chosen.name} · ` : "";
	const phase = active ? `${prefix}run ${chosen.iteration}/${chosen.max}`
		: !scheduled.length ? "paused" : (chosen.dueAt ?? Infinity) <= now ? "waiting" : `next ${eta(chosen.dueAt! - now)}`;
	return `↻ ${label} · ${phase}`;
}
export function describe(loop: Loop, now: number): string {
	const cadence = loop.schedule.kind === "dynamic" ? "model-paced" : loop.schedule.kind === "cron" ? `cron ${loop.schedule.expression}` : `every ${eta(loop.schedule.everyMs)}`;
	return `${loop.name} (${loop.id}) · ${loop.status} · ${loop.iteration}/${loop.max} · ${cadence}`
		+ (loop.dueAt !== null ? ` · next ${eta(loop.dueAt - now)}` : "")
		+ ` · deadline ${new Date(loop.deadline).toISOString()}`
		+ (loop.reason ? ` · ${loop.reason}` : "") + `\n  ${loop.prompt}`;
}

/** Reject malformed operational snapshots before they can arm a timer. */
export function restore(data: unknown): Loop[] {
	if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1
		|| !("loops" in data) || !Array.isArray(data.loops) || data.loops.length > 100) throw new Error("Invalid loop snapshot.");
	const used = new Set<string>();
	const loops = data.loops.map((raw): Loop => {
		if (!raw || typeof raw !== "object") throw new Error("Invalid saved loop.");
		const loop = raw as Loop;
		const validNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
		if (typeof loop.id !== "string" || !/^[a-f0-9]{8}$/.test(loop.id)
			|| typeof loop.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(loop.name)
			|| used.has(loop.id) || used.has(loop.name)
			|| typeof loop.prompt !== "string" || !loop.prompt.trim() || loop.prompt.length > 100_000
			|| !["scheduled", "running", "paused", "done", "stopped", "failed"].includes(loop.status)
			|| !validNumber(loop.createdAt) || !validNumber(loop.deadline) || !validNumber(loop.iteration)
			|| !validNumber(loop.max) || loop.max < 1 || loop.iteration > loop.max
			|| !validNumber(loop.timeoutMs) || !validNumber(loop.failures) || !validNumber(loop.identical)
			|| (loop.dueAt !== null && !validNumber(loop.dueAt))
			|| (loop.until !== undefined && typeof loop.until !== "string")) throw new Error("Invalid saved loop fields.");
		if (!loop.schedule || typeof loop.schedule !== "object") throw new Error("Invalid saved schedule.");
		if (loop.schedule.kind === "interval") {
			if (!validNumber(loop.schedule.everyMs) || loop.schedule.everyMs < 60_000) throw new Error("Invalid saved interval.");
		} else if (loop.schedule.kind === "cron") {
			if (typeof loop.schedule.expression !== "string") throw new Error("Invalid saved cron.");
			nextDue(loop.schedule, Date.now(), loop.createdAt);
		} else if (loop.schedule.kind !== "dynamic") throw new Error("Invalid saved schedule kind.");
		if (loop.status === "scheduled" && loop.dueAt === null) throw new Error("Missing scheduled time.");
		used.add(loop.id); used.add(loop.name);
		return structuredClone(loop);
	});
	if (loops.filter((loop) => !terminal(loop)).length > MAX_LOOPS) throw new Error("Too many saved loops.");
	return loops;
}
