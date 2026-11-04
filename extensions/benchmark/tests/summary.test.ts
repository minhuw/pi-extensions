import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { median, noise, summarize } from "../core.ts";

it.each([
	{ samples: [3, 1, 2], median: 2, min: 1, max: 3, count: 3 },
	{ samples: [4, 1, 3, 2], median: 2.5, min: 1, max: 4, count: 4 },
	{ samples: [7], median: 7, min: 7, max: 7, count: 1 },
	{ samples: [-5, 0], median: -2.5, min: -5, max: 0, count: 2 },
	{ samples: [Number.MAX_VALUE, Number.MAX_VALUE], median: Number.MAX_VALUE, min: Number.MAX_VALUE, max: Number.MAX_VALUE, count: 2 },
])("summarizes $samples", ({ samples, ...summary }) => {
	const input = [...samples];
	expect(summarize(samples)).toEqual(summary);
	expect(samples).toEqual(input);
	expect(summarize(samples).median).toBe(median(samples.map(a => ({ a })), ["a"]).a);
});

it.each([
	{ samples: [], error: "A benchmark summary needs at least one sample." },
	{ samples: [1, Number.NaN], error: "Benchmark samples must be finite numbers." },
	{ samples: [Number.POSITIVE_INFINITY], error: "Benchmark samples must be finite numbers." },
	{ samples: [2, Number.NEGATIVE_INFINITY, 3], error: "Benchmark samples must be finite numbers." },
])("rejects $samples", ({ samples, error }) => {
	expect(() => summarize(samples)).toThrow(error);
	expect(() => noise(samples, [1, 2])).toThrow(error);
	expect(() => noise([1, 2], samples)).toThrow(error);
});

it.each([
	{ case: "overlapping", a: [100, 110, 90], b: [95, 100, 105], verdict: "within noise" },
	{ case: "contained", a: [1, 10], b: [4, 5], verdict: "within noise" },
	{ case: "touching above", a: [1, 2], b: [2, 3], verdict: "within noise" },
	{ case: "touching below", a: [2, 3], b: [1, 2], verdict: "within noise" },
	{ case: "disjoint below", a: [100, 110, 90], b: [80, 85, 75], verdict: "outside noise" },
	{ case: "disjoint above", a: [80, 85, 75], b: [100, 110, 90], verdict: "outside noise" },
	{ case: "one baseline sample", a: [100], b: [80, 85, 75], verdict: "noise unknown" },
	{ case: "one candidate sample", a: [100, 110, 90], b: [80], verdict: "noise unknown" },
	{ case: "one sample on both sides", a: [100], b: [100], verdict: "noise unknown" },
	{ case: "two-sample disjoint", a: [1, 2], b: [3, 4], verdict: "outside noise" },
	{ case: "two-sample identical", a: [5, 5], b: [5, 5], verdict: "within noise" },
	{ case: "one sample inside the other range", a: [100], b: [90, 110], verdict: "noise unknown" },
])("reports $verdict for $case ranges", ({ a, b, verdict }) => {
	expect(noise(a, b)).toBe(verdict);
});

it("agrees with the measurement median and the inclusive range-overlap rule for generated samples", () => {
	let seed = 0x5eed;
	const random = () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
	const list = () => {
		const length = random() < 0.05 ? 5000 : 1 + Math.floor(random() * 12);
		const scale = [1, 0.001, 1e6, 1e300][Math.floor(random() * 4)]!;
		return Array.from({ length }, () => random() < 0.5 ? Math.floor(random() * 6) * scale : (random() - 0.5) * 10 * scale);
	};
	for (let run = 0; run < 500; run++) {
		const a = list(), b = list(), input = [...a];
		const s = summarize(a);
		expect(s).toEqual({ median: median(a.map(value => ({ value })), ["value"]).value, min: Math.min(...a), max: Math.max(...a), count: a.length });
		expect(s.min <= s.median && s.median <= s.max).toBe(true);
		expect(a).toEqual(input);
		const t = summarize(b);
		const verdict = a.length < 2 || b.length < 2 ? "noise unknown" : s.min <= t.max && t.min <= s.max ? "within noise" : "outside noise";
		expect(noise(a, b)).toBe(verdict);
		expect(noise(b, a)).toBe(verdict);
	}
});

it("judges about 1 in 10 orderings of two identical 3-sample versions outside noise, as the README states", () => {
	const orderings = (items: number[]): number[][] => items.length ? items.flatMap(item => orderings(items.filter(other => other !== item)).map(rest => [item, ...rest])) : [[]];
	const all = orderings([0, 1, 2, 3, 4, 5]);
	const outside = all.filter(order => noise(order.slice(0, 3), order.slice(3)) === "outside noise").length;
	expect(outside / all.length).toBe(0.1);
});

it("keeps the shared module free of Pi registration and other extensions", async () => {
	const source = await readFile(new URL("../core.ts", import.meta.url), "utf8");
	const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map(match => match[1]!);
	expect(imports.length).toBeGreaterThan(0);
	for (const specifier of imports) expect(specifier).toMatch(/^(node:|@earendil-works\/pi-coding-agent$)/);
	expect(Object.keys(await import("../core.ts"))).not.toContain("default");
});
