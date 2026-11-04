import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fingerprint, median, parseMetrics } from "../core.ts";

it("parses requested metrics and ignores unrelated lines", () => {
	expect(parseMetrics("building\nMETRIC compile_ms=12.5\nMETRIC other=3\nmetric size=1\n  METRIC size=2\nMETRIC size=4 \r\ndone", ["compile_ms", "size"]))
		.toEqual({ compile_ms: 12.5, size: 4 });
});

it("rejects missing, duplicate, and non-finite metrics", () => {
	expect(() => parseMetrics("METRIC compile_ms=1", ["compile_ms", "size"])).toThrow("Benchmark must print one METRIC name=value line for every metric: compile_ms, size");
	expect(() => parseMetrics("METRIC compile_ms=1\nMETRIC compile_ms=2", ["compile_ms"])).toThrow("Duplicate metric 'compile_ms'.");
	for (const value of ["NaN", "Infinity", "-Infinity", "fast"]) expect(() => parseMetrics(`METRIC compile_ms=${value}`, ["compile_ms"])).toThrow("Non-finite metric 'compile_ms'.");
});

it("takes the median of odd and even sample counts per metric", () => {
	expect(median([{ a: 3, b: 10 }, { a: 1, b: 30 }, { a: 2, b: 20 }], ["a", "b"])).toEqual({ a: 2, b: 20 });
	expect(median([{ a: 4 }, { a: 1 }, { a: 3 }, { a: 2 }], ["a"])).toEqual({ a: 2.5 });
	expect(median([{ a: Number.MAX_VALUE }, { a: Number.MAX_VALUE }], ["a"])).toEqual({ a: Number.MAX_VALUE });
});

it("rejects absolute harness paths and paths that escape the root", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-benchmark-fingerprint-"));
	try {
		const root = join(directory, "project");
		await mkdir(root); await writeFile(join(root, "measure.sh"), "echo ok\n"); await writeFile(join(directory, "outside.sh"), "echo out\n");
		await symlink(join(directory, "outside.sh"), join(root, "link.sh"));
		expect(Object.keys(await fingerprint(root, ["measure.sh"]))).toEqual(["measure.sh"]);
		await expect(fingerprint(root, [join(root, "measure.sh")])).rejects.toThrow("Benchmark files must be relative to the project.");
		for (const file of ["../outside.sh", "link.sh", "."]) await expect(fingerprint(root, [file])).rejects.toThrow("Benchmark file escapes the project.");
	} finally { await rm(directory, { recursive: true, force: true }); }
});
