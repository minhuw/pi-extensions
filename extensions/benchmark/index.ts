import { realpath } from "node:fs/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compare, fingerprint, runRounds, type Change, type Comparison, type MetricDefinition, type Side, type Summary } from "./core.ts";

const line = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\x00-\\x1f\\x7f-\\x9f]+$" });
export const Parameters = Type.Object({
	commands: Type.Array(Type.Object({
		command: Type.String({ minLength: 1, maxLength: 2000 }),
		label: Type.Optional(line(48)),
	}), { minItems: 1, maxItems: 2 }),
	metrics: Type.Array(Type.Object({
		name: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,47}$" }),
		label: Type.Optional(line(48)),
		unit: Type.Optional(line(16)),
		direction: Type.Union([Type.Literal("lower"), Type.Literal("higher")]),
		role: Type.Optional(Type.Union([Type.Literal("objective"), Type.Literal("informational")])),
	}), { minItems: 1, maxItems: 8 }),
	errorsMetric: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
	workMetric: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
	repetitions: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
	files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 16 })),
});
type Role = "objective" | "informational" | "errors" | "work";

const number = (value: number) => new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value);
const quantity = (value: number, unit: string) => `${number(value)}${unit ? ` ${unit}` : ""}`;
const spread = (s: Summary, unit: string) => `${quantity(s.median, unit)} (range ${number(s.min)}–${quantity(s.max, unit)}, n=${s.count})`;
function delta(change: Change, unit: string): string {
	const value = "percent" in change ? change.percent : change.absolute;
	if (!Number.isFinite(value)) return "—";
	const sign = value > 0 ? "+" : "";
	// Relative change is undefined at a zero A median; show the absolute change instead.
	return "percent" in change ? `${sign}${number(value)}%` : `${sign}${quantity(value, unit)} (absolute)`;
}
const cell = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function render(metrics: (MetricDefinition & { role: Role })[], sides: Side[], result: Comparison): string {
	const [a, b] = sides as [Side, Side | undefined];
	const objective = metrics.find(metric => metric.role === "objective")!;
	const header = ["Metric", ...sides.map(side => side.label), ...(b ? [`Change (${b.label} vs ${a.label})`] : [])];
	const rows = metrics.map((metric, index) => {
		const { summaries, change } = result.metrics[index]!;
		return [`${metric.label} (${metric.role}, ${metric.direction} is better)`, ...summaries.map(s => spread(s, metric.unit)), ...(change ? [delta(change, metric.unit)] : [])];
	});
	const { verdict, reason } = result.verdict;
	const because = reason ?? (verdict === "measured" ? "one command, nothing compared"
		: verdict === "no measurable difference" ? `${objective.label} ranges overlap`
		: `${objective.label}, ${objective.direction} is better; ranges do not overlap`);
	return [
		b ? `Ran ${a.label} and ${b.label} alternately for ${a.samples.length} rounds.` : `Ran ${a.label} ${a.samples.length} times.`,
		"",
		...[header, header.map(() => "---"), ...rows].map(cells => `| ${cells.map(cell).join(" | ")} |`),
		"",
		`Verdict: ${verdict} (${because}).`,
		...(b ? ["Range overlap is a coarse check, not a significance test."] : []),
	].join("\n");
}

export default function benchmarkExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "benchmark_compare", label: "Benchmark Compare", executionMode: "sequential", reachesTools: () => ["bash"],
		description: "Measure one shell command, or compare two, through bash. Runs each command `repetitions` times; two commands alternate A, B, A, B. Every run must print one `METRIC name=value` line per declared metric. Reports each metric's median, min–max range, and sample count, the median change of B against A, and a verdict on the objective metric: inconclusive (with its reason) when the errors metric is above zero in any run, the work metric differs between runs, or a side has fewer than 2 samples; no measurable difference when the objective's ranges overlap; otherwise B is better or worse than A. Declare errorsMetric and workMetric so failed or skipped work is caught. Listed files are pinned and must not change during the measurement. Stores nothing.",
		promptSnippet: "Measure one command or compare two from METRIC lines, with medians, ranges, and a verdict.",
		parameters: Parameters,
		async execute(_id, params, signal, _update, ctx) {
			const names = params.metrics.map(metric => metric.name);
			if (new Set(names).size !== names.length) throw new Error("Metric names must be unique.");
			const marked = params.metrics.filter(metric => metric.role === "objective");
			if (marked.length > 1) throw new Error("Mark exactly one metric as the objective.");
			const objective = (marked[0] ?? params.metrics[0]!).name;
			for (const [key, name] of [["errorsMetric", params.errorsMetric], ["workMetric", params.workMetric]] as const) {
				if (name === undefined) continue;
				if (!names.includes(name)) throw new Error(`${key} '${name}' must be one of the metrics.`);
				if (name === objective) throw new Error(`${key} '${name}' cannot be the objective.`);
			}
			const metrics = params.metrics.map(metric => ({
				name: metric.name, label: metric.label ?? metric.name, unit: metric.unit ?? "", direction: metric.direction,
				role: (metric.name === objective ? "objective" : metric.name === params.errorsMetric ? "errors" : metric.name === params.workMetric ? "work" : "informational") as Role,
			}));
			const commands = params.commands.map((entry, index) => ({ command: entry.command, label: entry.label ?? (index ? "B" : "A") }));
			if (commands.length === 2 && commands[0]!.label === commands[1]!.label) throw new Error("The two commands need different labels.");
			const sides = await runRounds(ctx, {
				root: await realpath(ctx.cwd), commands, files: await fingerprint(ctx.cwd, params.files ?? []),
				repetitions: params.repetitions ?? 5, timeoutSeconds: params.timeoutSeconds ?? 120,
			}, names, signal);
			const result = compare(metrics, { objective, errors: params.errorsMetric, work: params.workMetric }, sides);
			return {
				content: [{ type: "text", text: render(metrics, sides, result) }],
				details: { sides: sides.map((side, index) => ({ ...side, command: commands[index]!.command })), metrics: result.metrics, verdict: result.verdict },
			};
		},
	});
}
