import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Parameters, renderReport, restoreReport, updateReport, type Report } from "./report.ts";

export const ITERATION = "autoresearch:iteration";
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
export interface Measurement { samples: Record<string, number>[]; values: Record<string, number>; timestamp: number }
export interface Campaign {
	id: string;
	goal: string;
	state: "preparing" | "awaiting_approval" | "running" | "paused" | "complete" | "stopped";
	benchmark?: Benchmark;
	baseline?: Measurement;
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

/** Fingerprint declared harness files, rejecting escapes through paths and symlinks. */
export async function fingerprint(cwd: string, files: string[]): Promise<Record<string, string>> {
	const root = await realpath(cwd);
	const hashes: Record<string, string> = Object.create(null);
	for (const file of files) {
		if (path.isAbsolute(file)) throw new Error("Benchmark files must be relative to the project.");
		const absolute = await realpath(path.resolve(root, file));
		const relative = path.relative(root, absolute);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Benchmark file escapes the project.");
		if (Object.hasOwn(hashes, file)) throw new Error("Duplicate benchmark file.");
		const content = await readFile(absolute);
		if (content.length > 4 * 1024 * 1024) throw new Error("Benchmark harness files must be smaller than 4 MiB.");
		hashes[file] = hash(content);
	}
	return hashes;
}
export async function verifyHarness(cwd: string, benchmark: Benchmark): Promise<void> {
	if (await realpath(cwd) !== benchmark.root) throw new Error("Research working directory changed. Prepare and approve a new baseline.");
	const actual = await fingerprint(cwd, Object.keys(benchmark.files));
	if (JSON.stringify(actual) !== JSON.stringify(benchmark.files)) throw new Error("Benchmark harness changed. Prepare a new baseline and obtain approval again.");
}
export function parseMetrics(output: string, names: string[]): Record<string, number> {
	const values: Record<string, number> = Object.create(null);
	for (const line of output.split(/\r?\n/)) {
		const match = /^METRIC ([a-zA-Z][a-zA-Z0-9_]*)=(\S+)\s*$/.exec(line);
		if (!match || !names.includes(match[1]!)) continue;
		if (Object.hasOwn(values, match[1]!)) throw new Error(`Duplicate metric '${match[1]}'.`);
		const value = Number(match[2]);
		if (!Number.isFinite(value)) throw new Error(`Non-finite metric '${match[1]}'.`);
		values[match[1]!] = value;
	}
	if (names.some(name => !Object.hasOwn(values, name))) throw new Error(`Benchmark must print one METRIC name=value line for every metric: ${names.join(", ")}`);
	return values;
}
export async function measure(ctx: ExtensionToolContext, benchmark: Benchmark, names: string[], signal: AbortSignal | undefined, assertOwner: () => void): Promise<Measurement> {
	const samples: Record<string, number>[] = [];
	const run = async (command: string): Promise<string> => {
		assertOwner(); signal?.throwIfAborted();
		const result = await ctx.executeTool("bash", { command, timeout: benchmark.timeoutSeconds }, { signal });
		assertOwner(); signal?.throwIfAborted();
		const text = result.result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		if (result.isError) throw new Error(`Benchmark/check command failed: ${text.slice(-1500)}`);
		const details: unknown = result.result.details;
		if (record(details) && record(details.truncation) && details.truncation.truncated === true) {
			// Bash's display tail can omit metrics or hide duplicates; parse the saved full output.
			if (!bounded(details.fullOutputPath, 4096)) throw new Error("Benchmark/check output was truncated without a full output file.");
			const output = await readFile(details.fullOutputPath, { encoding: "utf8", signal });
			assertOwner(); signal?.throwIfAborted();
			return output;
		}
		return text;
	};
	await verifyHarness(ctx.cwd, benchmark);
	for (let index = 0; index < benchmark.repetitions; index++) samples.push(parseMetrics(await run(benchmark.command), names));
	if (benchmark.checkCommand) await run(benchmark.checkCommand);
	await verifyHarness(ctx.cwd, benchmark);
	assertOwner();
	const values: Record<string, number> = Object.create(null);
	for (const name of names) {
		const sorted = samples.map(sample => sample[name]!).sort((a, b) => a - b);
		const middle = Math.floor(sorted.length / 2);
		values[name] = sorted.length % 2 ? sorted[middle]! : sorted[middle - 1]! / 2 + sorted[middle]! / 2;
	}
	return { samples, values, timestamp: Date.now() };
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
export function proposal(state: State, requestApproval = state.campaign?.state === "awaiting_approval"): string {
	const c = state.campaign!; const b = c.benchmark!;
	return [
		`Research target: ${c.goal}`, "", "Methodology", b.methodology, "",
		`Working directory: ${b.root}`, `Benchmark command: ${b.command}`, `Correctness check: ${b.checkCommand ?? "none configured"}`,
		`Repetitions: ${b.repetitions}; aggregation: median; timeout per command: ${b.timeoutSeconds}s`,
		`Pinned harness files: ${Object.keys(b.files).join(", ")}`, "",
		`Baseline samples: ${JSON.stringify(c.baseline!.samples)}`, "", renderReport(state.report!), "",
		`Campaign limit: ${c.maxIterations} iterations, up to six hours after approval.`,
		requestApproval ? "Review whether the target, workload, methodology, and baseline are correct. To start optimization, run /autoresearch approve. To revise, run /autoresearch revise <feedback>." : "",
	].filter(Boolean).join("\n");
}
export function prompt(state: State, kind: "prepare" | "iterate"): string {
	const c = state.campaign!;
	if (kind === "prepare") return [
		`Autoresearch setup: ${c.goal}`,
		"Work in this main session. First understand the codebase and clarify the optimization target. Implement a repeatable baseline measurement harness; do not optimize the implementation yet.",
		"Describe the exact workload (for compilation: cold vs incremental build, cache state, inputs and build command), warmup/setup, measurement units, repetitions/noise, editable implementation scope, and correctness checks. Prefer three repetitions unless the workload makes that impractical.",
		"The harness must emit exactly one METRIC name=value line per declared metric per run. Call autoresearch_baseline with your methodology, command, harness files, metrics, repetition count, and optional checkCommand. That tool executes the baseline and records the measured samples.",
		"Then explain the methodology and initial results to the user, ask whether they match what the user intends, and stop. The user must run /autoresearch approve before optimization starts. Never approve on their behalf or start optimization iterations during setup.",
		"Use autoresearch_update for concise progress messages. Existing tool permissions apply. Do not discard unrelated user changes.",
		c.reason ? `User feedback: ${c.reason}` : "",
	].filter(Boolean).join("\n\n");
	return [
		`Autoresearch iteration ${c.iterations}/${c.maxIterations}: ${c.goal}`,
		"Perform one bounded optimization experiment in this main session: choose a hypothesis, make a focused change, call autoresearch_measure, inspect the objective and constraints, and retain or undo only changes you own as justified by the evidence. Preserve unrelated changes. Do not use repository-wide reset/clean or change the benchmark to improve the score.",
		"Use autoresearch_update to explain the hypothesis and outcome. Metrics come from autoresearch_measure; do not supply your own numeric replacements. Mark phase complete if no useful experiment remains, or paused if you need a user decision. The extension schedules the next pass after this run settles; do not sleep or create a separate loop.",
		proposal(state, false),
		"The baseline above was approved by the user. Benchmark commands, metric definitions, and declared harness files are fixed. A methodology change requires /autoresearch revise and a fresh approval.",
	].join("\n\n");
}
