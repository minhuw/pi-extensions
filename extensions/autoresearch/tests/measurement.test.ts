import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, type BashToolInput, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { fingerprint, measure, type Benchmark } from "../campaign.ts";

it.each([
	{ limit: "lines", logs: "log\n".repeat(2100) },
	{ limit: "bytes", logs: `${"x".repeat(60_000)}\n` },
	{ limit: "structured output bytes", logs: `${"x".repeat(2 * 1024 * 1024)}\n` },
])("reads metrics and detects duplicates beyond Bash's $limit limit", async ({ logs }) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-research-output-"));
	const outputFiles = new Set<string>();
	try {
		const bash = createBashTool(directory);
		const ctx = {
			cwd: directory,
			executeTool: async (_name: string, input: BashToolInput, options?: { signal?: AbortSignal }) => {
				const result = await bash.execute("measurement", input, options?.signal);
				if (result.details?.fullOutputPath) outputFiles.add(result.details.fullOutputPath);
				expect(result.details?.truncation?.truncated).toBe(true);
				return { result, isError: result.isError ?? false };
			},
		} as unknown as ExtensionToolContext;
		const benchmark = async (output: string): Promise<Benchmark> => {
			await writeFile(join(directory, "measure.mjs"), `process.stdout.write(${JSON.stringify(output)});\n`);
			return {
				root: await realpath(directory), methodology: "Fixed verbose output fixture.", command: "node measure.mjs",
				files: await fingerprint(directory, ["measure.mjs"]), repetitions: 1, timeoutSeconds: 10,
			};
		};
		const valid = await benchmark(`METRIC compile_ms=100\n${logs}`);
		await expect(measure(ctx, valid, ["compile_ms"], undefined, () => {})).resolves.toMatchObject({
			samples: [{ compile_ms: 100 }], values: { compile_ms: 100 },
		});
		const duplicate = await benchmark(`METRIC compile_ms=999\n${logs}METRIC compile_ms=1\n`);
		await expect(measure(ctx, duplicate, ["compile_ms"], undefined, () => {})).rejects.toThrow("Duplicate metric 'compile_ms'");
	} finally {
		await Promise.all([...outputFiles].map(file => rm(file, { force: true })));
		await rm(directory, { recursive: true, force: true });
	}
});
