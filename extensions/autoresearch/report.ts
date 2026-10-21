import { Type, type Static } from "typebox";

export const SNAPSHOT = "autoresearch:report";
export const STATUS_KEY = "autoresearch";
const line = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\x00-\\x1f\\x7f-\\x9f]+$" });
const Direction = Type.Union([Type.Literal("lower"), Type.Literal("higher")]);
const Role = Type.Union([Type.Literal("objective"), Type.Literal("constraint"), Type.Literal("informational")]);
export const Phase = Type.Union([
	Type.Literal("planning"), Type.Literal("editing"), Type.Literal("measuring"),
	Type.Literal("checking"), Type.Literal("paused"), Type.Literal("complete"),
]);
export const Parameters = Type.Object({
	phase: Phase,
	message: line(240),
	metrics: Type.Optional(Type.Array(Type.Object({
		name: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,47}$" }),
		label: Type.Optional(line(48)),
		unit: Type.Optional(line(16)),
		direction: Type.Optional(Direction),
		role: Type.Optional(Role),
		value: Type.Optional(Type.Number()),
		baseline: Type.Optional(Type.Number()),
	}), { minItems: 1, maxItems: 8 })),
});
export type Update = Static<typeof Parameters>;
export interface Metric {
	name: string;
	label: string;
	unit: string;
	direction: "lower" | "higher";
	role: "objective" | "constraint" | "informational";
	value?: number;
	baseline?: number;
}
export interface Report {
	id: string;
	phase: Static<typeof Phase>;
	message: string;
	metrics: Metric[];
	updatedAt: number;
	provenance: "model-reported" | "tool-measured";
}
export interface Snapshot { version: 1; report: Report | null }

function text(value: unknown, max: number, empty = false): value is string {
	return typeof value === "string" && (empty || value.trim().length > 0) && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function validateMetric(metric: Metric): void {
	if (!text(metric.name, 48) || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(metric.name)
		|| !text(metric.label, 48) || !text(metric.unit, 16, true)
		|| !["lower", "higher"].includes(metric.direction)
		|| !["objective", "constraint", "informational"].includes(metric.role)
		|| (metric.value !== undefined && !finite(metric.value))
		|| (metric.baseline !== undefined && !finite(metric.baseline))) throw new Error("Invalid metric definition or non-finite value.");
}
function validateReport(report: Report): void {
	if (!text(report.id, 80) || !["planning", "editing", "measuring", "checking", "paused", "complete"].includes(report.phase)
		|| !text(report.message, 240) || !finite(report.updatedAt) || report.updatedAt < 0
		|| !["model-reported", "tool-measured"].includes(report.provenance) || !Array.isArray(report.metrics) || report.metrics.length > 8) throw new Error("Invalid research report.");
	for (const metric of report.metrics) validateMetric(metric);
	if (new Set(report.metrics.map(m => m.name)).size !== report.metrics.length
		|| (report.metrics.length > 0 && report.metrics.filter(m => m.role === "objective").length !== 1)) throw new Error("Metrics need unique names and exactly one objective.");
}

/** A new report is built before persistence; failed updates never mutate the previous report. */
export function updateReport(previous: Report | null, update: Update, id: string, now: number): Report {
	const report: Report = previous ? structuredClone(previous) : {
		id, phase: update.phase, message: update.message, metrics: [], updatedAt: now, provenance: "model-reported",
	};
	report.phase = update.phase;
	report.message = update.message;
	report.updatedAt = now;
	if (update.metrics) {
		if (!update.metrics.length || update.metrics.length > 8 || new Set(update.metrics.map(m => m.name)).size !== update.metrics.length) throw new Error("Supply 1–8 metrics with unique names.");
		if (!report.metrics.length) {
			const explicitObjective = update.metrics.some(m => m.role === "objective");
			report.metrics = update.metrics.map((metric, index) => {
				if (!metric.direction) throw new Error(`New metric '${metric.name}' needs a direction.`);
				return {
					name: metric.name, label: metric.label ?? metric.name, unit: metric.unit ?? "", direction: metric.direction,
					role: metric.role ?? (!explicitObjective && index === 0 ? "objective" : "informational"),
					...(metric.value !== undefined ? { value: metric.value } : {}),
					...(metric.baseline !== undefined || metric.value !== undefined ? { baseline: metric.baseline ?? metric.value } : {}),
				};
			});
		} else {
			for (const metric of update.metrics) {
				const current = report.metrics.find(m => m.name === metric.name);
				if (!current) throw new Error(`Unknown metric '${metric.name}'. Use /research-report clear to start a new comparison.`);
				for (const key of ["label", "unit", "direction", "role", "baseline"] as const) {
					if (metric[key] !== undefined && current[key] !== undefined && metric[key] !== current[key]) throw new Error(`Metric '${metric.name}' has a fixed ${key}. Use /research-report clear to start a new comparison.`);
				}
				if (metric.value !== undefined) current.value = metric.value;
				if (current.baseline === undefined) current.baseline = metric.baseline ?? metric.value;
			}
		}
	}
	validateReport(report);
	return report;
}

/** Read the latest branch snapshot only. A malformed latest snapshot must not resurrect older data. */
export function restoreReport(data: unknown): Report | null {
	if (!data || typeof data !== "object") throw new Error("Invalid research snapshot.");
	const snapshot = data as Snapshot;
	if (snapshot.version !== 1 || !("report" in snapshot)) throw new Error("Unsupported research snapshot.");
	if (snapshot.report === null) return null;
	validateReport(snapshot.report);
	return structuredClone(snapshot.report);
}

export function number(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value);
}
function quantity(value: number | undefined, unit: string): string {
	return value === undefined ? "—" : `${number(value)}${unit ? ` ${unit}` : ""}`;
}
export function change(metric: Metric): string {
	if (metric.baseline === undefined || metric.value === undefined) return "—";
	const delta = metric.value - metric.baseline;
	if (delta === 0) return "0%";
	// Relative change is undefined at a zero baseline; preserve the absolute change instead.
	const percent = metric.baseline === 0 ? undefined : delta / Math.abs(metric.baseline) * 100;
	if (!Number.isFinite(delta) || (percent !== undefined && !Number.isFinite(percent))) return "—";
	return percent === undefined
		? `${delta > 0 ? "+" : ""}${quantity(delta, metric.unit)} (absolute)`
		: `${percent > 0 ? "+" : ""}${number(percent)}%`;
}
export function summary(report: Report): string {
	const metric = report.metrics.find(m => m.role === "objective");
	return `research · ${report.phase} · ${report.provenance === "tool-measured" ? "measured" : "reported"}${metric ? ` · ${metric.label} ${quantity(metric.value, metric.unit)} (${change(metric)})` : ""}`;
}
const cell = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function renderReport(report: Report): string {
	const rows = report.metrics.map(metric => `| ${cell(metric.label)} | ${metric.role} | ${metric.direction} | ${cell(quantity(metric.baseline, metric.unit))} | ${cell(quantity(metric.value, metric.unit))} | ${cell(change(metric))} |`);
	return [
		`Research report — ${report.phase}`, "", report.message, "",
		report.provenance === "tool-measured"
			? "Values were parsed from benchmark output by the extension; the methodology still requires human review."
			: "Values are model-reported; this extension does not verify these measurements.",
		...(rows.length ? ["", "| Metric | Role | Better | Baseline | Latest | Change |", "| --- | --- | --- | --- | --- | --- |", ...rows] : []),
	].join("\n");
}
