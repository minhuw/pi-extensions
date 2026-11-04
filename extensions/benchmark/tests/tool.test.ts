import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createBashTool, type BashToolInput, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import extension from "../index.ts";

/** The registered tool behind Pi's own argument validation, with a ctx whose bash replies from `outputs` unless `run` supplies one. */
async function fixture(outputs: Record<string, string[]> = {}, run?: (directory: string) => ExtensionToolContext["executeTool"]) {
	const directory = await mkdtemp(join(tmpdir(), "pi-benchmark-tool-"));
	const tools = new Map<string, any>();
	// Only registerTool exists: registering anything else, or storing state, would throw.
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
	const ctx = {
		cwd: directory,
		executeTool: vi.fn(run?.(directory) ?? (async (_name: string, input: { command: string }) => ({
			isError: false, result: { content: [{ type: "text", text: outputs[input.command]!.shift()! }], details: undefined },
		}))),
	} as unknown as ExtensionToolContext;
	const tool = tools.get("benchmark_compare");
	const call = async (args: Record<string, unknown>) => {
		const params = validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args as any });
		return tool.execute("call", params, undefined, undefined, ctx) as Promise<{ content: { type: string; text: string }[]; details: any }>;
	};
	return { directory, tools, tool, ctx, call, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const metric = (ms: number, errors = 0, items = 10) => `METRIC ms=${ms}\nMETRIC errors=${errors}\nMETRIC items=${items}\n`;
const metrics = [
	{ name: "ms", label: "Time", unit: "ms", direction: "lower" },
	{ name: "errors", direction: "lower" },
	{ name: "items", direction: "higher" },
];

it("registers only benchmark_compare, sequential and reaching bash", async () => {
	const f = await fixture();
	try {
		expect([...f.tools.keys()]).toEqual(["benchmark_compare"]);
		expect(f.tool).toMatchObject({ executionMode: "sequential", promptSnippet: expect.any(String) });
		expect(f.tool.reachesTools({})).toEqual(["bash"]);
	} finally { await f.cleanup(); }
});

it("compares two commands with medians, ranges, counts, the change, and the verdict", async () => {
	const f = await fixture({ a: [metric(100), metric(110), metric(90)], b: [metric(80), metric(85), metric(75)] });
	try {
		const result = await f.call({ commands: [{ command: "a" }, { command: "b" }], metrics, errorsMetric: "errors", workMetric: "items", repetitions: 3 });
		expect(f.ctx.executeTool).toHaveBeenCalledTimes(6);
		expect(vi.mocked(f.ctx.executeTool).mock.calls.map(([name, input]) => [name, input])).toEqual(
			["a", "b", "a", "b", "a", "b"].map(command => ["bash", { command, timeout: 120 }]));
		expect(result.content[0]!.text).toBe([
			"Ran A and B alternately for 3 rounds.",
			"",
			"| Metric | A | B | Change (B vs A) |",
			"| --- | --- | --- | --- |",
			"| Time (objective, lower is better) | 100 ms (range 90–110 ms, n=3) | 80 ms (range 75–85 ms, n=3) | -20% |",
			"| errors (errors, lower is better) | 0 (range 0–0, n=3) | 0 (range 0–0, n=3) | 0% |",
			"| items (work, higher is better) | 10 (range 10–10, n=3) | 10 (range 10–10, n=3) | 0% |",
			"",
			"Verdict: B is better than A (Time, lower is better; ranges do not overlap).",
			"Range overlap is a coarse check, not a significance test.",
		].join("\n"));
		expect(result.details).toMatchObject({
			verdict: { verdict: "B is better than A" },
			sides: [{ label: "A", command: "a", samples: [{ ms: 100 }, { ms: 110 }, { ms: 90 }] }, { label: "B", command: "b", samples: [{ ms: 80 }, { ms: 85 }, { ms: 75 }] }],
		});
	} finally { await f.cleanup(); }
});

it("reports inconclusive with its reason, overlapping ranges, labels, and one-command results", async () => {
	const f = await fixture({
		a: [metric(100), metric(110, 1), metric(90), metric(0), metric(0), metric(100), metric(100), metric(90), metric(110)],
		b: [metric(80), metric(85), metric(75), metric(5), metric(7), metric(95), metric(105)],
	});
	try {
		const errored = (await f.call({ commands: [{ command: "a" }, { command: "b" }], metrics, errorsMetric: "errors", repetitions: 3 })).content[0]!.text;
		expect(errored).toContain("Verdict: inconclusive (errors reported in 1 of 3 runs of A).");
		const zero = (await f.call({ commands: [{ command: "a", label: "main" }, { command: "b", label: "new" }], metrics, repetitions: 2 })).content[0]!.text;
		expect(zero).toContain("| Metric | main | new | Change (new vs main) |");
		expect(zero).toContain("| Time (objective, lower is better) | 0 ms (range 0–0 ms, n=2) | 6 ms (range 5–7 ms, n=2) | +6 ms (absolute) |");
		expect(zero).toContain("Verdict: new is worse than main (Time, lower is better; ranges do not overlap).");
		const overlap = (await f.call({ commands: [{ command: "a" }, { command: "b" }], metrics, repetitions: 2 })).content[0]!.text;
		expect(overlap).toContain("| 100 ms (range 100–100 ms, n=2) | 100 ms (range 95–105 ms, n=2) | 0% |");
		expect(overlap).toContain("Verdict: no measurable difference (Time ranges overlap).");
		const single = (await f.call({ commands: [{ command: "a" }], metrics, workMetric: "items", repetitions: 2 })).content[0]!.text;
		expect(single).toBe([
			"Ran A 2 times.", "", "| Metric | A |", "| --- | --- |",
			"| Time (objective, lower is better) | 100 ms (range 90–110 ms, n=2) |",
			"| errors (informational, lower is better) | 0 (range 0–0, n=2) |",
			"| items (work, higher is better) | 10 (range 10–10, n=2) |",
			"", "Verdict: measured (one command, nothing compared).",
		].join("\n"));
	} finally { await f.cleanup(); }
});

it("defaults to 5 repetitions, a 120-second timeout, and the first metric as the objective", async () => {
	const f = await fixture({ a: Array.from({ length: 5 }, () => "METRIC ops=3\nMETRIC ms=2\n") });
	try {
		const result = await f.call({ commands: [{ command: "a" }], metrics: [{ name: "ops", direction: "higher" }, { name: "ms", direction: "lower" }] });
		expect(f.ctx.executeTool).toHaveBeenCalledTimes(5);
		expect(f.ctx.executeTool).toHaveBeenCalledWith("bash", { command: "a", timeout: 120 }, { signal: undefined });
		expect(result.content[0]!.text).toContain("| ops (objective, higher is better) | 3 (range 3–3, n=5) |");
		expect(result.content[0]!.text).toContain("| ms (informational, lower is better) | 2 (range 2–2, n=5) |");
	} finally { await f.cleanup(); }
});

it.each([
	{ case: "two objectives", args: { metrics: [{ name: "ms", direction: "lower", role: "objective" }, { name: "ops", direction: "higher", role: "objective" }] }, error: "Mark exactly one metric as the objective." },
	{ case: "errorsMetric not among the metrics", args: { errorsMetric: "failures" }, error: "errorsMetric 'failures' must be one of the metrics." },
	{ case: "errorsMetric equal to the objective", args: { errorsMetric: "ms" }, error: "errorsMetric 'ms' cannot be the objective." },
	{ case: "workMetric not among the metrics", args: { workMetric: "rows" }, error: "workMetric 'rows' must be one of the metrics." },
	{ case: "workMetric equal to the marked objective", args: { metrics: [{ name: "ms", direction: "lower" }, { name: "items", direction: "higher", role: "objective" }], workMetric: "items" }, error: "workMetric 'items' cannot be the objective." },
	{ case: "duplicate metric names", args: { metrics: [{ name: "ms", direction: "lower" }, { name: "ms", direction: "higher" }] }, error: "Metric names must be unique." },
	{ case: "equal labels", args: { commands: [{ command: "a", label: "X" }, { command: "b", label: "X" }] }, error: "The two commands need different labels." },
	{ case: "21 repetitions", args: { repetitions: 21 }, error: "repetitions: expected <= 20" },
	{ case: "0 repetitions", args: { repetitions: 0 }, error: "repetitions:" },
	{ case: "a 1801-second timeout", args: { timeoutSeconds: 1801 }, error: "timeoutSeconds:" },
	{ case: "no commands", args: { commands: [] }, error: "commands:" },
	{ case: "three commands", args: { commands: [{ command: "a" }, { command: "b" }, { command: "c" }] }, error: "commands:" },
	{ case: "a 2001-character command", args: { commands: [{ command: "x".repeat(2001) }] }, error: "commands.0.command:" },
	{ case: "a multi-line label", args: { commands: [{ command: "a", label: "A\nB" }] }, error: "commands.0.label:" },
	{ case: "nine metrics", args: { metrics: Array.from({ length: 9 }, (_, index) => ({ name: `m${index}`, direction: "lower" })) }, error: "metrics:" },
	{ case: "an invalid metric name", args: { metrics: [{ name: "1ms", direction: "lower" }] }, error: "metrics.0.name:" },
	{ case: "an unknown role", args: { metrics: [{ name: "ms", direction: "lower", role: "constraint" }] }, error: "metrics.0.role:" },
	{ case: "17 files", args: { files: Array.from({ length: 17 }, (_, index) => `f${index}`) }, error: "files:" },
])("rejects $case without running anything", async ({ args, error }) => {
	const f = await fixture();
	try {
		await expect(f.call({ commands: [{ command: "a" }, { command: "b" }], metrics: [{ name: "ms", direction: "lower" }, { name: "errors", direction: "lower" }, { name: "items", direction: "higher" }], ...args }))
			.rejects.toThrow(error);
		expect(f.ctx.executeTool).not.toHaveBeenCalled();
	} finally { await f.cleanup(); }
});

it("rejects pinned files that escape the project", async () => {
	const f = await fixture();
	try {
		await expect(f.call({ commands: [{ command: "a" }], metrics, files: ["../outside.sh"] })).rejects.toThrow();
		expect(f.ctx.executeTool).not.toHaveBeenCalled();
	} finally { await f.cleanup(); }
});

it("compares two node scripts alternately through the real Pi bash tool", async () => {
	const outputFiles = new Set<string>();
	const f = await fixture({}, directory => {
		const bash = createBashTool(directory);
		return (async (_name: string, input: BashToolInput, options?: { signal?: AbortSignal }) => {
			const result = await bash.execute("benchmark", input, options?.signal);
			if (result.details?.fullOutputPath) outputFiles.add(result.details.fullOutputPath);
			return { result, isError: result.isError ?? false };
		}) as unknown as ExtensionToolContext["executeTool"];
	});
	const { directory } = f;
	try {
		const script = (label: string, ms: number) => `import { appendFileSync } from "node:fs";\nappendFileSync("order.log", ${JSON.stringify(label)});\nprocess.stdout.write("METRIC ms=${ms}\\nMETRIC errors=0\\nMETRIC items=10\\n");\n`;
		await writeFile(join(directory, "a.mjs"), script("A", 100));
		await writeFile(join(directory, "b.mjs"), script("B", 50));
		const result = await f.call({
			commands: [{ command: "node a.mjs" }, { command: "node b.mjs" }], metrics, errorsMetric: "errors", workMetric: "items",
			repetitions: 2, timeoutSeconds: 30, files: ["a.mjs", "b.mjs"],
		});
		expect(await readFile(join(directory, "order.log"), "utf8")).toBe("ABAB");
		expect(result.content[0]!.text).toContain("| Time (objective, lower is better) | 100 ms (range 100–100 ms, n=2) | 50 ms (range 50–50 ms, n=2) | -50% |");
		expect(result.content[0]!.text).toContain("Verdict: B is better than A (Time, lower is better; ranges do not overlap).");
	} finally {
		await Promise.all([...outputFiles].map(file => rm(file, { force: true })));
		await f.cleanup();
	}
}, 30_000);
