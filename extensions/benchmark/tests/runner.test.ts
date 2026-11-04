import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { fingerprint, measure, runRounds, type Rounds } from "../core.ts";

type Reply = (command: string, call: number) => Promise<{ text: string; isError?: boolean }> | { text: string; isError?: boolean };

async function fixture(reply: Reply) {
	const directory = await mkdtemp(join(tmpdir(), "pi-benchmark-rounds-"));
	await writeFile(join(directory, "measure.sh"), "echo ok\n");
	const calls: { command: string; timeout: number }[] = [];
	const ctx = {
		cwd: directory,
		executeTool: async (name: string, input: { command: string; timeout: number }) => {
			expect(name).toBe("bash");
			calls.push(input);
			const { text, isError = false } = await reply(input.command, calls.length);
			return { isError, result: { content: [{ type: "text", text }], details: undefined } };
		},
	} as unknown as ExtensionToolContext;
	const rounds = async (commands: string[], repetitions: number): Promise<Rounds> => ({
		root: await realpath(directory), commands: commands.map((command, index) => ({ label: index ? "B" : "A", command })),
		files: await fingerprint(directory, ["measure.sh"]), repetitions, timeoutSeconds: 10,
	});
	return { directory, ctx, calls, rounds, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

it("runs two commands alternately, A then B, for every round", async () => {
	const f = await fixture((_command, call) => ({ text: `building\nMETRIC ms=${call}\n` }));
	try {
		await expect(runRounds(f.ctx, await f.rounds(["run a", "run b"], 3), ["ms"], undefined)).resolves.toEqual([
			{ label: "A", samples: [{ ms: 1 }, { ms: 3 }, { ms: 5 }] },
			{ label: "B", samples: [{ ms: 2 }, { ms: 4 }, { ms: 6 }] },
		]);
		expect(f.calls).toEqual(["run a", "run b", "run a", "run b", "run a", "run b"].map(command => ({ command, timeout: 10 })));
	} finally { await f.cleanup(); }
});

it("runs one command n times", async () => {
	const f = await fixture((_command, call) => ({ text: `METRIC ms=${call * 10}` }));
	try {
		await expect(runRounds(f.ctx, await f.rounds(["run a"], 4), ["ms"], undefined)).resolves.toEqual([
			{ label: "A", samples: [{ ms: 10 }, { ms: 20 }, { ms: 30 }, { ms: 40 }] },
		]);
		expect(f.calls.map(call => call.command)).toEqual(["run a", "run a", "run a", "run a"]);
	} finally { await f.cleanup(); }
});

it("verifies pinned files before the first run and after the last", async () => {
	const changed = await fixture(async (_command, call) => {
		if (call === 2) await writeFile(join(changed.directory, "measure.sh"), "echo changed\n");
		return { text: "METRIC ms=1" };
	});
	try {
		await expect(runRounds(changed.ctx, await changed.rounds(["run a", "run b"], 2), ["ms"], undefined)).rejects.toThrow("Benchmark harness changed.");
		expect(changed.calls).toHaveLength(4);
	} finally { await changed.cleanup(); }
	const before = await fixture(() => ({ text: "METRIC ms=1" }));
	try {
		const rounds = await before.rounds(["run a"], 2);
		await writeFile(join(before.directory, "measure.sh"), "echo changed\n");
		await expect(runRounds(before.ctx, rounds, ["ms"], undefined)).rejects.toThrow("Benchmark harness changed.");
		expect(before.calls).toHaveLength(0);
	} finally { await before.cleanup(); }
});

it("fails on a failing command in the style of measure, and names the side", async () => {
	const f = await fixture(command => command === "run b" ? { text: "boom", isError: true } : { text: "METRIC ms=1" });
	try {
		await expect(runRounds(f.ctx, await f.rounds(["run a", "run b"], 3), ["ms"], undefined)).rejects.toThrow("Benchmark B command failed: boom");
		expect(f.calls).toHaveLength(2);
		const harness = { ...await f.rounds([], 1), command: "run b" };
		await expect(measure(f.ctx, harness, ["ms"], undefined, () => {})).rejects.toThrow("Benchmark/check command failed: boom");
	} finally { await f.cleanup(); }
});

it("fails when a run is missing a metric", async () => {
	const f = await fixture(() => ({ text: "METRIC ms=1" }));
	try {
		await expect(runRounds(f.ctx, await f.rounds(["run a"], 2), ["ms", "errors"], undefined))
			.rejects.toThrow("Benchmark A: Benchmark must print one METRIC name=value line for every metric: ms, errors");
	} finally { await f.cleanup(); }
});

it("stops before running anything once aborted", async () => {
	const f = await fixture(() => ({ text: "METRIC ms=1" }));
	try {
		const controller = new AbortController(); controller.abort(new Error("stopped"));
		await expect(runRounds(f.ctx, await f.rounds(["run a", "run b"], 3), ["ms"], controller.signal)).rejects.toThrow("stopped");
		expect(f.calls).toHaveLength(0);
	} finally { await f.cleanup(); }
});
