import { expect, it } from "vitest";
import { compare, noise, type MetricDefinition, type Roles, type Side } from "../core.ts";

const time: MetricDefinition = { name: "ms", label: "Time", unit: "ms", direction: "lower" };
const rate: MetricDefinition = { name: "ops", label: "Rate", unit: "op/s", direction: "higher" };
const errors: MetricDefinition = { name: "errors", label: "Errors", unit: "", direction: "lower" };
const work: MetricDefinition = { name: "items", label: "Items", unit: "", direction: "higher" };
/** One side's samples from per-metric columns of equal length. */
function side(label: string, columns: Record<string, number[]>): Side {
	const names = Object.keys(columns);
	return { label, samples: columns[names[0]!]!.map((_, index) => Object.fromEntries(names.map(name => [name, columns[name]![index]!]))) };
}
const timed: Roles = { objective: "ms" };
const guarded: Roles = { objective: "ms", errors: "errors", work: "items" };
const clean = { errors: [0, 0, 0], items: [10, 10, 10] };

it.each([
	{ case: "lower is better, B lower", metrics: [time], roles: timed, sides: [side("A", { ms: [100, 110, 90] }), side("B", { ms: [80, 85, 75] })], verdict: "B is better than A" },
	{ case: "lower is better, B higher", metrics: [time], roles: timed, sides: [side("A", { ms: [80, 85, 75] }), side("B", { ms: [100, 110, 90] })], verdict: "B is worse than A" },
	{ case: "higher is better, B higher", metrics: [rate], roles: { objective: "ops" }, sides: [side("A", { ops: [100, 110, 90] }), side("B", { ops: [200, 210, 190] })], verdict: "B is better than A" },
	{ case: "higher is better, B lower", metrics: [rate], roles: { objective: "ops" }, sides: [side("A", { ops: [200, 210, 190] }), side("B", { ops: [100, 110, 90] })], verdict: "B is worse than A" },
	{ case: "labels", metrics: [time], roles: timed, sides: [side("main", { ms: [100, 110] }), side("new", { ms: [80, 85] })], verdict: "new is better than main" },
	{ case: "touching ranges", metrics: [time], roles: timed, sides: [side("A", { ms: [1, 2] }), side("B", { ms: [2, 3] })], verdict: "no measurable difference" },
	{ case: "overlapping ranges", metrics: [time], roles: timed, sides: [side("A", { ms: [100, 110, 90] }), side("B", { ms: [95, 100, 105] })], verdict: "no measurable difference" },
	{ case: "contained range", metrics: [time], roles: timed, sides: [side("A", { ms: [1, 10] }), side("B", { ms: [4, 5] })], verdict: "no measurable difference" },
	{ case: "clean errors and equal work", metrics: [time, errors, work], roles: guarded, sides: [side("A", { ms: [100, 110, 90], ...clean }), side("B", { ms: [80, 85, 75], ...clean })], verdict: "B is better than A" },
	{ case: "errors in A", metrics: [time, errors, work], roles: guarded, sides: [side("A", { ms: [100, 110, 90], errors: [0, 1, 0], items: clean.items }), side("B", { ms: [80, 85, 75], ...clean })], verdict: "inconclusive", reason: "errors reported in 1 of 3 runs of A" },
	{ case: "errors in B", metrics: [time, errors, work], roles: guarded, sides: [side("A", { ms: [100, 110, 90], ...clean }), side("B", { ms: [80, 85, 75], errors: [2, 0, 3], items: clean.items })], verdict: "inconclusive", reason: "errors reported in 2 of 3 runs of B" },
	{ case: "errors in both", metrics: [time, errors], roles: { objective: "ms", errors: "errors" }, sides: [side("A", { ms: [1, 2], errors: [0, 1] }), side("B", { ms: [1, 2], errors: [5, 5] })], verdict: "inconclusive", reason: "errors reported in 1 of 2 runs of A and 2 of 2 runs of B" },
	{ case: "work differs within a side", metrics: [time, errors, work], roles: guarded, sides: [side("A", { ms: [100, 110, 90], ...clean }), side("B", { ms: [80, 85, 75], errors: clean.errors, items: [10, 9, 10] })], verdict: "inconclusive", reason: "work differs between runs" },
	{ case: "work differs between sides", metrics: [time, work], roles: { objective: "ms", work: "items" }, sides: [side("A", { ms: [100, 110, 90], items: [10, 10, 10] }), side("B", { ms: [80, 85, 75], items: [12, 12, 12] })], verdict: "inconclusive", reason: "work differs between runs" },
	{ case: "errors and unequal work", metrics: [time, errors, work], roles: guarded, sides: [side("A", { ms: [1, 2], errors: [1, 0], items: [1, 2] }), side("B", { ms: [3, 4], errors: [0, 0], items: [1, 1] })], verdict: "inconclusive", reason: "errors reported in 1 of 2 runs of A; work differs between runs" },
	{ case: "one A sample", metrics: [time], roles: timed, sides: [side("A", { ms: [100] }), side("B", { ms: [80, 85] })], verdict: "inconclusive", reason: "fewer than 2 samples" },
	{ case: "one B sample", metrics: [time], roles: timed, sides: [side("A", { ms: [100, 110] }), side("B", { ms: [80] })], verdict: "inconclusive", reason: "fewer than 2 samples" },
	{ case: "one command", metrics: [time, errors, work], roles: guarded, sides: [side("A", { ms: [100, 110, 90], ...clean })], verdict: "measured" },
	{ case: "one command, one sample", metrics: [time], roles: timed, sides: [side("A", { ms: [100] })], verdict: "measured" },
	{ case: "one command with errors", metrics: [time, errors, work], roles: guarded, sides: [side("A", { ms: [100, 110, 90], errors: [0, 0, 4], items: clean.items })], verdict: "inconclusive", reason: "errors reported in 1 of 3 runs of A" },
	{ case: "one command with unequal work", metrics: [time, errors, work], roles: guarded, sides: [side("A", { ms: [100, 110, 90], errors: clean.errors, items: [10, 10, 11] })], verdict: "inconclusive", reason: "work differs between runs" },
])("judges $case as $verdict", ({ metrics, roles, sides, verdict, reason }) => {
	expect(compare(metrics, roles, sides).verdict).toEqual(reason ? { verdict, reason } : { verdict });
});

it("summarizes every metric for each side and the change of B's median against A's", () => {
	const result = compare([time, rate], timed, [side("A", { ms: [100, 110, 90], ops: [0, 0, 1] }), side("B", { ms: [80, 85, 75], ops: [2, 3, 4] })]);
	expect(result.metrics).toEqual([
		{ name: "ms", summaries: [{ median: 100, min: 90, max: 110, count: 3 }, { median: 80, min: 75, max: 85, count: 3 }], change: { percent: -20 } },
		{ name: "ops", summaries: [{ median: 0, min: 0, max: 1, count: 3 }, { median: 3, min: 2, max: 4, count: 3 }], change: { absolute: 3 } },
	]);
	expect(compare([time], timed, [side("A", { ms: [0, 0] }), side("B", { ms: [0, 0] })]).metrics[0]!.change).toEqual({ percent: 0 });
	expect(compare([time], timed, [side("A", { ms: [-50, -50] }), side("B", { ms: [-25, -25] })]).metrics[0]!.change).toEqual({ percent: 50 });
	expect(compare([time], timed, [side("A", { ms: [3, 1, 2] })]).metrics).toEqual([{ name: "ms", summaries: [{ median: 2, min: 1, max: 3, count: 3 }] }]);
});

it("judges 2 of the 252 ways to split two identical 5-sample versions outside noise, as the README states", () => {
	const subsets = (items: number[], size: number): number[][] => size === 0 ? [[]] : items.length < size ? []
		: [...subsets(items.slice(1), size - 1).map(rest => [items[0]!, ...rest]), ...subsets(items.slice(1), size)];
	const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
	const splits = subsets(values, 5);
	expect(splits).toHaveLength(252);
	expect(splits.filter(a => noise(a, values.filter(value => !a.includes(value))) === "outside noise")).toHaveLength(2);
});
