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
export async function verifyHarness(cwd: string, harness: Harness, messages = PINNED): Promise<void> {
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
export function median(samples: Record<string, number>[], names: string[]): Record<string, number> {
	const values: Record<string, number> = Object.create(null);
	for (const name of names) {
		const sorted = samples.map(sample => sample[name]!).sort((a, b) => a - b);
		const middle = Math.floor(sorted.length / 2);
		values[name] = sorted.length % 2 ? sorted[middle]! : sorted[middle - 1]! / 2 + sorted[middle]! / 2;
	}
	return values;
}
export async function measure(ctx: ExtensionToolContext, harness: Harness, names: string[], signal: AbortSignal | undefined, assertOwner: () => void, messages = PINNED): Promise<Measurement> {
	const samples: Record<string, number>[] = [];
	const run = async (command: string): Promise<string> => {
		assertOwner(); signal?.throwIfAborted();
		const result = await ctx.executeTool("bash", { command, timeout: harness.timeoutSeconds }, { signal });
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
	await verifyHarness(ctx.cwd, harness, messages);
	for (let index = 0; index < harness.repetitions; index++) samples.push(parseMetrics(await run(harness.command), names));
	if (harness.checkCommand) await run(harness.checkCommand);
	await verifyHarness(ctx.cwd, harness, messages);
	assertOwner();
	return { samples, values: median(samples, names), timestamp: Date.now() };
}
