import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export interface Harness {
	root: string;
	command: string;
	checkCommand?: string;
	files: Record<string, string>;
	repetitions: number;
	timeoutSeconds: number;
}
export interface Measurement { samples: Record<string, number>[]; values: Record<string, number>; timestamp: number }
/** Errors for a harness whose working directory moved or whose pinned files changed. */
export interface HarnessMessages { moved: string; changed: string }
const PINNED: HarnessMessages = { moved: "Benchmark working directory changed.", changed: "Benchmark harness changed." };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

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
export async function verifyHarness(cwd: string, harness: Pick<Harness, "root" | "files">, messages = PINNED): Promise<void> {
	if (await realpath(cwd) !== harness.root) throw new Error(messages.moved);
	const actual = await fingerprint(cwd, Object.keys(harness.files));
	if (JSON.stringify(actual) !== JSON.stringify(harness.files)) throw new Error(messages.changed);
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
const ascending = (values: number[]) => [...values].sort((a, b) => a - b);
function middle(sorted: number[]): number {
	const index = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[index]! : sorted[index - 1]! / 2 + sorted[index]! / 2;
}
export function median(samples: Record<string, number>[], names: string[]): Record<string, number> {
	const values: Record<string, number> = Object.create(null);
	for (const name of names) values[name] = middle(ascending(samples.map(sample => sample[name]!)));
	return values;
}
export interface Summary { median: number; min: number; max: number; count: number }
export type Noise = "within noise" | "outside noise" | "noise unknown";
export function summarize(samples: number[]): Summary {
	if (!samples.length) throw new Error("A benchmark summary needs at least one sample.");
	if (!samples.every(Number.isFinite)) throw new Error("Benchmark samples must be finite numbers.");
	const sorted = ascending(samples);
	return { median: middle(sorted), min: sorted[0]!, max: sorted.at(-1)!, count: sorted.length };
}
/** A coarse check: inclusive min–max ranges that overlap or touch are within noise. */
export function noise(a: number[], b: number[]): Noise {
	const x = summarize(a), y = summarize(b);
	if (x.count < 2 || y.count < 2) return "noise unknown";
	return x.min <= y.max && y.min <= x.max ? "within noise" : "outside noise";
}
/** Run a command through Pi's bash tool and return its complete output. `what` names it in errors. */
async function bash(ctx: ExtensionToolContext, command: string, timeoutSeconds: number, signal: AbortSignal | undefined, assertOwner: () => void, what: string): Promise<string> {
	assertOwner(); signal?.throwIfAborted();
	const result = await ctx.executeTool("bash", { command, timeout: timeoutSeconds }, { signal });
	assertOwner(); signal?.throwIfAborted();
	const text = result.result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	if (result.isError) throw new Error(`${what} command failed: ${text.slice(-1500)}`);
	const details: unknown = result.result.details;
	if (record(details) && record(details.truncation) && details.truncation.truncated === true) {
		// Bash's display tail can omit metrics or hide duplicates; parse the saved full output.
		if (!bounded(details.fullOutputPath, 4096)) throw new Error(`${what} output was truncated without a full output file.`);
		const output = await readFile(details.fullOutputPath, { encoding: "utf8", signal });
		assertOwner(); signal?.throwIfAborted();
		return output;
	}
	return text;
}
export async function measure(ctx: ExtensionToolContext, harness: Harness, names: string[], signal: AbortSignal | undefined, assertOwner: () => void, messages = PINNED): Promise<Measurement> {
	const samples: Record<string, number>[] = [];
	const run = (command: string) => bash(ctx, command, harness.timeoutSeconds, signal, assertOwner, "Benchmark/check");
	await verifyHarness(ctx.cwd, harness, messages);
	for (let index = 0; index < harness.repetitions; index++) samples.push(parseMetrics(await run(harness.command), names));
	if (harness.checkCommand) await run(harness.checkCommand);
	await verifyHarness(ctx.cwd, harness, messages);
	assertOwner();
	return { samples, values: median(samples, names), timestamp: Date.now() };
}

/** One or two labeled commands run against the same pinned files. */
export interface Rounds {
	root: string;
	commands: { label: string; command: string }[];
	files: Record<string, string>;
	repetitions: number;
	timeoutSeconds: number;
}
export interface Side { label: string; samples: Record<string, number>[] }
/** Run every command once per round, in order (A, B, A, B, …), and return each command's samples. */
export async function runRounds(ctx: ExtensionToolContext, rounds: Rounds, names: string[], signal: AbortSignal | undefined, messages = PINNED): Promise<Side[]> {
	const sides: Side[] = rounds.commands.map(({ label }) => ({ label, samples: [] }));
	await verifyHarness(ctx.cwd, rounds, messages);
	for (let round = 0; round < rounds.repetitions; round++) {
		for (const [index, { label, command }] of rounds.commands.entries()) {
			const output = await bash(ctx, command, rounds.timeoutSeconds, signal, () => {}, `Benchmark ${label}`);
			try { sides[index]!.samples.push(parseMetrics(output, names)); }
			catch (error) { throw new Error(`Benchmark ${label}: ${(error as Error).message}`, { cause: error }); }
		}
	}
	await verifyHarness(ctx.cwd, rounds, messages);
	return sides;
}

export interface MetricDefinition { name: string; label: string; unit: string; direction: "lower" | "higher" }
/** B's median relative to A's in percent, or the absolute change when A's median is zero. */
export type Change = { percent: number } | { absolute: number };
export interface MetricResult { name: string; summaries: Summary[]; change?: Change }
export interface Verdict { verdict: string; reason?: string }
export interface Comparison { metrics: MetricResult[]; verdict: Verdict }
export interface Roles { objective: string; errors?: string; work?: string }

function change(a: number, b: number): Change {
	if (a === b) return { percent: 0 };
	return a === 0 ? { absolute: b - a } : { percent: (b - a) / Math.abs(a) * 100 };
}
/**
 * Summarize every metric for one or two sides and judge the objective. Two sides compare B against A;
 * one side is only checked for errors and unequal work, and is otherwise "measured".
 */
export function compare(metrics: MetricDefinition[], roles: Roles, sides: Side[]): Comparison {
	const column = (side: Side, name: string) => side.samples.map(sample => sample[name]!);
	const results = metrics.map(({ name }): MetricResult => {
		const summaries = sides.map(side => summarize(column(side, name)));
		return sides.length === 2 ? { name, summaries, change: change(summaries[0]!.median, summaries[1]!.median) } : { name, summaries };
	});
	const reasons: string[] = [];
	if (roles.errors) {
		const failed = sides.map(side => ({ side, count: column(side, roles.errors!).filter(value => value > 0).length })).filter(({ count }) => count);
		if (failed.length) reasons.push(`errors reported in ${failed.map(({ side, count }) => `${count} of ${side.samples.length} runs of ${side.label}`).join(" and ")}`);
	}
	if (roles.work && new Set(sides.flatMap(side => column(side, roles.work!))).size > 1) reasons.push("work differs between runs");
	if (sides.length === 2 && sides.some(side => side.samples.length < 2)) reasons.push("fewer than 2 samples");
	const verdict = (): Verdict => {
		if (reasons.length) return { verdict: "inconclusive", reason: reasons.join("; ") };
		if (sides.length !== 2) return { verdict: "measured" };
		const [a, b] = sides as [Side, Side];
		const objective = metrics.find(metric => metric.name === roles.objective)!;
		if (noise(column(a, objective.name), column(b, objective.name)) === "within noise") return { verdict: "no measurable difference" };
		const { summaries: [x, y] } = results.find(result => result.name === objective.name)!;
		const lower = y!.median < x!.median;
		return { verdict: `${b.label} is ${lower === (objective.direction === "lower") ? "better" : "worse"} than ${a.label}` };
	};
	return { metrics: results, verdict: verdict() };
}
