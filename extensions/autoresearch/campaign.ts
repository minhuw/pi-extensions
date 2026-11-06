import { createHash } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { noise, summarize, type HarnessMessages, type Measurement } from "../benchmark/core.ts";
import { number, Parameters, quantity, renderReport, restoreReport, updateReport, type Metric, type Report } from "./report.ts";

export const ITERATION = "autoresearch:iteration";
/** A dispatched pass must start within DISPATCH_LIMIT_MS; a started pass then has its setup or iteration limit. */
export const DISPATCH_LIMIT_MS = 30_000;
export const SETUP_LIMIT_MS = 30 * 60_000;
export const ITERATION_LIMIT_MS = 15 * 60_000;
export const LIFETIME_MS = 6 * 60 * 60_000;
/** A whole-unit limit such as "15 minutes" or "6 hours". */
export const duration = (ms: number) => ms % 3_600_000 ? `${ms / 60_000} minutes` : `${ms / 3_600_000} hours`;
function elapsed(ms: number): string { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }
export const BaselineParameters = Type.Object({
	methodology: Type.String({ minLength: 1, maxLength: 12000 }),
	command: Type.String({ minLength: 1, maxLength: 2000 }),
	checkCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	files: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 16 }),
	metrics: Type.Array(Type.Omit(Parameters.properties.metrics.items, ["value", "baseline"]), { minItems: 1, maxItems: 8 }),
	repetitions: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
});
export interface Benchmark {
	root: string;
	methodology: string;
	command: string;
	checkCommand?: string;
	files: Record<string, string>;
	repetitions: number;
	timeoutSeconds: number;
}
export const HARNESS_MESSAGES: HarnessMessages = {
	moved: "Research working directory changed. Prepare and approve a new baseline.",
	changed: "Benchmark harness changed. Prepare a new baseline and obtain approval again.",
};
export interface Campaign {
	id: string;
	goal: string;
	state: "preparing" | "awaiting_approval" | "running" | "paused" | "complete" | "stopped";
	benchmark?: Benchmark;
	baseline?: Measurement;
	/** Wall time of the baseline measurement: every repetition plus the correctness check. */
	baselineMs?: number;
	latest?: Measurement;
	approved?: string;
	iterations: number;
	maxIterations: number;
	deadline?: number;
	reason?: string;
}
export interface State { version: 2; report: Report | null; campaign: Campaign | null }
export function emptyState(): State { return { version: 2, report: null, campaign: null }; }
export function terminal(campaign: Campaign): boolean { return campaign.state === "complete" || campaign.state === "stopped"; }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function approvalKey(state: State): string {
	const c = state.campaign;
	return hash(JSON.stringify({ id: c?.id, goal: c?.goal, maxIterations: c?.maxIterations, benchmark: c?.benchmark, baseline: c?.baseline,
		metrics: state.report?.metrics.map(({ value: _value, ...definition }) => definition) }));
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
function measurement(value: unknown, names: string[]): value is Measurement {
	if (!record(value) || !Array.isArray(value.samples) || !value.samples.length || value.samples.length > 10 || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
	return [value.values, ...value.samples].every(row => record(row) && Object.keys(row).length === names.length && names.every(name => typeof row[name] === "number" && Number.isFinite(row[name])));
}
export function restoreState(data: unknown): State {
	if (record(data) && data.version === 1) return { ...emptyState(), report: restoreReport(data) };
	if (!record(data) || data.version !== 2 || !("campaign" in data)) throw new Error("Invalid autoresearch state.");
	const report = restoreReport({ version: 1, report: data.report });
	if (data.campaign === null) return { ...emptyState(), report };
	const c = data.campaign;
	if (!record(c) || !bounded(c.id, 80) || !bounded(c.goal, 4000) || !["preparing", "awaiting_approval", "running", "paused", "complete", "stopped"].includes(String(c.state))
		|| !Number.isSafeInteger(c.iterations) || Number(c.iterations) < 0 || !Number.isSafeInteger(c.maxIterations) || Number(c.maxIterations) < 1 || Number(c.maxIterations) > 1000
		|| Number(c.iterations) > Number(c.maxIterations) || (c.deadline !== undefined && (typeof c.deadline !== "number" || !Number.isFinite(c.deadline)))
		|| (c.baselineMs !== undefined && (typeof c.baselineMs !== "number" || !Number.isFinite(c.baselineMs) || c.baselineMs < 0))
		|| (c.reason !== undefined && !bounded(c.reason, 1000))) throw new Error("Invalid research campaign.");
	if (c.benchmark !== undefined) {
		const b = c.benchmark;
		if (!record(b) || !bounded(b.root, 4096) || !path.isAbsolute(b.root) || !bounded(b.methodology, 12000) || !bounded(b.command, 2000) || (b.checkCommand !== undefined && !bounded(b.checkCommand, 2000))
			|| !Number.isSafeInteger(b.repetitions) || Number(b.repetitions) < 1 || Number(b.repetitions) > 10
			|| !Number.isSafeInteger(b.timeoutSeconds) || Number(b.timeoutSeconds) < 1 || Number(b.timeoutSeconds) > 1800
			|| !record(b.files) || !Object.keys(b.files).length || Object.keys(b.files).length > 16
			|| !Object.entries(b.files).every(([key, value]) => bounded(key, 240) && typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) throw new Error("Invalid benchmark.");
	}
	const names = report?.metrics.map(metric => metric.name) ?? [];
	if (c.baseline !== undefined && (!names.length || !measurement(c.baseline, names))) throw new Error("Invalid baseline.");
	if (c.latest !== undefined && (!names.length || !measurement(c.latest, names))) throw new Error("Invalid measurement.");
	if ((c.benchmark !== undefined || ["awaiting_approval", "running"].includes(String(c.state))) && (!c.benchmark || !c.baseline || !report)) throw new Error("Missing baseline proposal.");
	const state = structuredClone({ version: 2, report, campaign: c }) as unknown as State;
	if (c.approved !== undefined && (typeof c.approved !== "string" || c.approved !== approvalKey(state))) throw new Error("Approval does not match the baseline.");
	if (c.state === "running" && (!c.approved || c.deadline === undefined)) throw new Error("Missing research approval.");
	return state;
}

export function measuredReport(report: Report, measurement: Measurement, baseline: boolean): Report {
	const next = baseline ? updateReport(null, {
		phase: "checking", message: "Baseline measured; waiting for your approval.",
		metrics: report.metrics.map(metric => ({ ...metric, baseline: measurement.values[metric.name], value: measurement.values[metric.name] })),
	}, report.id, measurement.timestamp) : updateReport(report, {
		phase: "checking", message: "Candidate measured with the approved methodology.",
		metrics: report.metrics.map(metric => ({ name: metric.name, value: measurement.values[metric.name] })),
	}, report.id, measurement.timestamp);
	next.provenance = "tool-measured";
	return next;
}
const column = (metric: Metric, measurement: Measurement) => measurement.samples.map(sample => sample[metric.name]!);
function spread(metric: Metric, measurement: Measurement): string {
	const s = summarize(column(metric, measurement));
	return `${quantity(s.median, metric.unit)} (range ${number(s.min)}–${quantity(s.max, metric.unit)}, n=${s.count})`;
}
/** Per-metric baseline lines, with the latest measurement and the objective's noise verdict when `latest` is set. */
export function ranges(state: State, latest = false): string {
	const c = state.campaign!; const metrics = state.report!.metrics;
	const lines = metrics.map(metric => `${metric.label}: baseline ${spread(metric, c.baseline!)}${latest ? `; latest ${spread(metric, c.latest!)}` : ""}`);
	const objective = metrics.find(metric => metric.role === "objective")!;
	if (latest) lines.push(`Noise check for ${objective.label} (objective): ${noise(column(objective, c.baseline!), column(objective, c.latest!))}.`);
	return lines.join("\n");
}
export function proposal(state: State, requestApproval = state.campaign?.state === "awaiting_approval"): string {
	const c = state.campaign!; const b = c.benchmark!;
	return [
		`Research target: ${c.goal}`, "", "Methodology", b.methodology, "",
		`Working directory: ${b.root}`, `Benchmark command: ${b.command}`, `Correctness check: ${b.checkCommand ?? "none configured"}`,
		`Repetitions: ${b.repetitions}; aggregation: median; timeout per command: ${b.timeoutSeconds}s`,
		`Pinned harness files: ${Object.keys(b.files).join(", ")}`, "",
		`Baseline samples: ${JSON.stringify(c.baseline!.samples)}`, ranges(state), "", renderReport(state.report!), "",
		`Campaign limit: ${c.maxIterations} iterations, up to ${duration(LIFETIME_MS)} after approval.`,
		c.baselineMs === undefined ? "" : `Baseline measurement time: ${elapsed(c.baselineMs)} (every repetition${b.checkCommand ? " plus the correctness check" : ""}); pass limits: ${duration(SETUP_LIMIT_MS)} for setup, ${duration(ITERATION_LIMIT_MS)} per optimization iteration.`,
		(c.baselineMs ?? 0) > ITERATION_LIMIT_MS / 2 ? `Warning: the baseline measurement took more than half of an iteration's ${duration(ITERATION_LIMIT_MS)}, leaving little time for an edit, so iterations will likely time out and pause the campaign. Use fewer repetitions or a smaller workload via /autoresearch revise <feedback>.` : "",
		requestApproval ? "Review whether the target, workload, methodology, and baseline are correct. To start optimization, run /autoresearch approve. To revise, run /autoresearch revise <feedback>." : "",
	].filter(Boolean).join("\n");
}
export function prompt(state: State, kind: "prepare" | "iterate"): string {
	const c = state.campaign!;
	if (kind === "prepare") return [
		`Autoresearch setup: ${c.goal}`,
		"Work in this main session. First understand the codebase and clarify the optimization target. Implement a repeatable baseline measurement harness; do not optimize the implementation yet.",
		"Describe the exact workload (for compilation: cold vs incremental build, cache state, inputs and build command), warmup/setup, measurement units, repetitions/noise, editable implementation scope, and correctness checks. Prefer three repetitions unless the workload makes that impractical.",
		`Time limits: this setup pass has ${duration(SETUP_LIMIT_MS)}; after approval, each optimization iteration has ${duration(ITERATION_LIMIT_MS)}. Exceeding a limit pauses the campaign. One iteration must fit a focused edit plus one full autoresearch_measure (all repetitions plus the correctness check), so size the workload and repetitions so that one measurement takes well under half the iteration limit (${duration(ITERATION_LIMIT_MS / 2)}).`,
		"The harness must emit exactly one METRIC name=value line per declared metric per run. Call autoresearch_baseline with your methodology, command, harness files, metrics, repetition count, and optional checkCommand. That tool executes the baseline and records the measured samples.",
		"Then explain the methodology and initial results to the user, ask whether they match what the user intends, and stop. The user must run /autoresearch approve before optimization starts. Never approve on their behalf or start optimization iterations during setup.",
		"Use autoresearch_update for concise progress messages. After autoresearch_baseline you may still report with it, but do not mark the phase paused or complete: the measured baseline awaits /autoresearch approve. Existing tool permissions apply. Do not discard unrelated user changes.",
		c.reason ? `User feedback: ${c.reason}` : "",
	].filter(Boolean).join("\n\n");
	return [
		`Autoresearch iteration ${c.iterations}/${c.maxIterations}: ${c.goal}`,
		`Perform one bounded optimization experiment in this main session: choose a hypothesis, make a focused change, call autoresearch_measure, inspect the objective and constraints, and retain or undo only changes you own as justified by the evidence. Preserve unrelated changes. Do not use repository-wide reset/clean or change the benchmark to improve the score. This pass is limited to ${duration(ITERATION_LIMIT_MS)}, including the measurement; exceeding the limit pauses the campaign.`,
		"Each autoresearch_measure result gives a noise verdict for the objective. \"within noise\" (the baseline and latest ranges overlap) is no measurable difference, not an improvement. With fewer than 2 repetitions noise cannot be estimated (\"noise unknown\"); say so when reporting a change.",
		"Use autoresearch_update to explain the hypothesis and outcome. Metrics come from autoresearch_measure; do not supply your own numeric replacements. Mark phase complete if no useful experiment remains, or paused if you need a user decision. The extension schedules the next pass after this run settles; do not sleep or create a separate loop.",
		proposal(state, false),
		"The baseline above was approved by the user. Benchmark commands, metric definitions, and declared harness files are fixed. A methodology change requires /autoresearch revise and a fresh approval.",
	].join("\n\n");
}
