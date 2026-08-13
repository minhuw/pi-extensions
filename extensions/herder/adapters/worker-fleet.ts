import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { PiNestedAgentSnapshot, PiWorkerSnapshot } from "./worker-engine.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 200;
const MAX_VISIBLE_AGENTS = 16;

const I = {
	herder: "\uF0C0",
	initializing: "\uF110",
	running: "\uF04B",
	paused: "\uF04C",
	needsInput: "\uF128",
	complete: "\uF00C",
	failed: "\uF00D",
	stopped: "\uF04D",
	dashboard: "\uF0E4",
	profile: "\uF135",
	parallel: "\uF0E8",
	plans: "\uF07C",
	progress: "\uF0AE",
} as const;

const ACTIVITY_LABELS: Record<string, string> = {
	bash: "running command",
	edit: "editing",
	find: "finding files",
	grep: "searching",
	ls: "listing files",
	read: "reading",
	write: "writing",
	Agent: "delegating",
};

export interface HerderWidgetModel {
	status: "initializing" | "running" | "paused" | "needs_input" | "complete" | "failed" | "stopped";
	profile: string;
	maxParallel: number;
	planName: string;
	summaryLine?: string;
	dashboardUrl?: string;
	idleDetail?: string;
	workers: readonly PiWorkerSnapshot[];
}

type WidgetKind = "component" | "static";
type WidgetUI = ExtensionContext["ui"];

function roleLabel(role: PiWorkerSnapshot["role"]): string {
	const label = role.replace(/^plan-/, "");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Compact model/thinking/tier identity shown next to agent names everywhere.
 * Order is always: model · thinking · service tier (omit missing fields).
 * Kept local to Herder so the two tree implementations stay independent while
 * showing the same identity information shape as subagents.
 */
export function formatAgentIdentity(source?: {
	model?: string | null;
	effort?: string | null;
	serviceTier?: string | null;
} | null): string | undefined {
	if (!source) return undefined;
	const parts = [source.model, source.effort, source.serviceTier]
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatAgentNameIdentity(
	theme: Theme,
	source: { model?: string | null; effort?: string | null; serviceTier?: string | null },
): string {
	const identity = formatAgentIdentity(source);
	return identity ? ` ${theme.fg("dim", `· ${identity}`)}` : "";
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}t`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function tokenStats(tokens: number, contextPercent: number | null, compactions: number): string {
	const annotations: string[] = [];
	if (contextPercent !== null) annotations.push(`${Math.round(contextPercent)}%`);
	if (compactions > 0) annotations.push(`⇊${compactions}`);
	return `${formatTokens(tokens)}${annotations.length ? ` (${annotations.join(" · ")})` : ""}`;
}

export function formatWorkerElapsed(startedAt: number, now = Date.now()): string {
	const wholeSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	if (wholeSeconds < 60) return `${wholeSeconds}s`;
	const minutes = Math.floor(wholeSeconds / 60);
	const seconds = wholeSeconds % 60;
	if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function statusStyle(status: HerderWidgetModel["status"]): { color: ThemeColor; icon: string } {
	if (status === "complete") return { color: "success", icon: I.complete };
	if (status === "failed") return { color: "error", icon: I.failed };
	if (status === "stopped") return { color: "dim", icon: I.stopped };
	if (status === "needs_input") return { color: "warning", icon: I.needsInput };
	if (status === "paused") return { color: "warning", icon: I.paused };
	if (status === "initializing") return { color: "accent", icon: I.initializing };
	return { color: "accent", icon: I.running };
}

function workerIcon(worker: PiWorkerSnapshot, frame: number, theme: Theme): string {
	if (worker.status === "stopping") return theme.fg("warning", "■");
	if (worker.status === "prepared") return theme.fg("muted", "○");
	return theme.fg("accent", SPINNER[frame % SPINNER.length]!);
}

function nestedIcon(agent: PiNestedAgentSnapshot, frame: number, theme: Theme): string {
	if (agent.status === "completed") return theme.fg("success", "✓");
	if (["error", "aborted"].includes(agent.status)) return theme.fg("error", "✗");
	if (agent.status === "stopped") return theme.fg("warning", "■");
	return theme.fg("accent", SPINNER[frame % SPINNER.length]!);
}

function activityLabel(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return ACTIVITY_LABELS[value] ?? value;
}

function responseActivity(text: string | undefined): string | undefined {
	return text?.split("\n").find((line) => line.trim())?.trim();
}

function workerActivity(worker: PiWorkerSnapshot): string {
	if (worker.status === "stopping") return "stopping…";
	if (worker.status === "prepared") return "starting…";
	const active = activityLabel(worker.activeTools[0]);
	const value = active ?? activityLabel(worker.activity) ?? responseActivity(worker.responseText) ?? "thinking";
	return value.endsWith("…") ? value : `${value}…`;
}

function nestedActivity(agent: PiNestedAgentSnapshot): string {
	if (agent.status === "completed") return "done";
	if (["error", "aborted", "stopped"].includes(agent.status)) return agent.status;
	const active = activityLabel(agent.activeTools[0]);
	const live = active ?? activityLabel(agent.activity) ?? responseActivity(agent.responseText);
	if (live) return live.endsWith("…") ? live : `${live}…`;
	return "thinking…";
}

function rightAlign(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	const clampedLeft = truncateToWidth(left, leftWidth);
	const gap = Math.max(1, width - visibleWidth(clampedLeft) - rightWidth);
	return `${clampedLeft}${" ".repeat(gap)}${right}`;
}

function topStats(worker: PiWorkerSnapshot, now: number): string {
	return [
		`r${worker.round}`,
		`↻${worker.turns}`,
		`${worker.toolUses} tool${worker.toolUses === 1 ? "" : "s"}`,
		tokenStats(worker.lifetimeTokens, worker.contextPercent, worker.compactionCount),
		formatWorkerElapsed(worker.startedAt, now),
	].join(" · ");
}

function nestedStats(agent: PiNestedAgentSnapshot, now: number): string {
	return [
		`↻${agent.turns}`,
		`${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}`,
		tokenStats(agent.lifetimeTokens, agent.contextPercent, agent.compactionCount),
		formatWorkerElapsed(agent.startedAt, agent.completedAt ?? now),
	].join(" · ");
}

interface RenderRow {
	kind: "top" | "nested" | "summary";
	worker?: PiWorkerSnapshot;
	agent?: PiNestedAgentSnapshot;
	completed?: readonly PiNestedAgentSnapshot[];
	prefix: string;
	connector: "├─" | "└─";
}

function completedSummaryLabel(agents: readonly PiNestedAgentSnapshot[]): string {
	const counts = new Map<string, number>();
	for (const agent of agents) {
		counts.set(agent.displayName, (counts.get(agent.displayName) ?? 0) + 1);
	}
	return `${[...counts.entries()].map(([name, count]) => `${count} ${name}`).join(" · ")} done`;
}

function appendNestedRows(rows: RenderRow[], children: readonly PiNestedAgentSnapshot[], prefix: string): void {
	const live = children.filter((agent) => agent.status !== "completed");
	const completed = children.filter((agent) => agent.status === "completed");
	const items: RenderRow[] = live.map((agent) => ({ kind: "nested", agent, prefix, connector: "├─" as const }));
	if (completed.length > 0) items.push({ kind: "summary", completed, prefix, connector: "├─" });
	items.forEach((item, index) => {
		item.connector = index === items.length - 1 ? "└─" : "├─";
		rows.push(item);
	});
}

function agentRows(workers: readonly PiWorkerSnapshot[]): RenderRow[] {
	const rows: RenderRow[] = [];
	workers.forEach((worker, index) => {
		const connector = index === workers.length - 1 ? "└─" : "├─";
		rows.push({ kind: "top", worker, prefix: "", connector });
		// Start direct child connectors beneath the role segment while retaining
		// the outer tree stem when a later plan sibling still follows.
		const roleColumn = visibleWidth(`${connector} Plan ${worker.planId} · `);
		const outerStem = connector === "├─" ? "│" : " ";
		appendNestedRows(rows, worker.children, `${outerStem}${" ".repeat(Math.max(0, roleColumn - 1))}`);
	});
	return rows;
}

function renderRow(row: RenderRow, width: number, theme: Theme, now: number, frame: number): string {
	if (row.kind === "top") {
		const worker = row.worker!;
		const identityTag = formatAgentNameIdentity(theme, worker);
		const left = `${theme.fg("dim", row.connector)} ${theme.fg("muted", `Plan ${worker.planId}`)} ${theme.fg("dim", "·")} ${workerIcon(worker, frame, theme)} ${theme.bold(roleLabel(worker.role))}${identityTag}  ${theme.fg("dim", workerActivity(worker))}`;
		return rightAlign(left, theme.fg("dim", topStats(worker, now)), width);
	}
	if (row.kind === "summary") {
		const left = `${row.prefix}${theme.fg("dim", row.connector)} ${theme.fg("success", "✓")} ${theme.fg("dim", completedSummaryLabel(row.completed!))}`;
		return truncateToWidth(left, width);
	}
	const agent = row.agent!;
	const identityTag = formatAgentNameIdentity(theme, agent);
	const left = `${row.prefix}${theme.fg("dim", row.connector)} ${nestedIcon(agent, frame, theme)} ${theme.bold(agent.displayName)}${identityTag}  ${theme.fg("dim", nestedActivity(agent))}`;
	return rightAlign(left, theme.fg("dim", nestedStats(agent, now)), width);
}

export function workerFleetTreeLines(
	model: HerderWidgetModel,
	theme: Theme,
	width: number,
	now = Date.now(),
	frame = 0,
	limit = MAX_VISIBLE_AGENTS,
): string[] {
	const style = statusStyle(model.status);
	const separator = theme.fg("borderMuted", " · ");
	const headerParts = [
		theme.fg("accent", `${I.herder} `) + theme.bold("Herder") + " " + theme.fg(style.color, `${style.icon} ${model.status.toUpperCase()}`),
		...(model.dashboardUrl ? [theme.fg("syntaxFunction", `${I.dashboard} `) + theme.fg("muted", `Dashboard ${model.dashboardUrl}`)] : []),
		theme.fg("syntaxKeyword", `${I.profile} `) + theme.fg("muted", model.profile),
		theme.fg("syntaxFunction", `${I.parallel} `) + theme.fg("muted", `max ${model.maxParallel}`),
		theme.fg("syntaxType", `${I.plans} `) + theme.fg("muted", model.planName),
		...(model.summaryLine ? [theme.fg("success", `${I.progress} `) + theme.fg("muted", `Progress ${model.summaryLine}`)] : []),
	];
	const lines = [truncateToWidth(headerParts.join(separator), width)];
	const rows = agentRows(model.workers);
	if (rows.length === 0) {
		const fallbackDetail: Record<HerderWidgetModel["status"], string> = {
			initializing: "Initializing…",
			running: "Waiting for manager dispatch…",
			paused: "Paused.",
			needs_input: "Waiting for input.",
			complete: "Complete.",
			failed: "Failed.",
			stopped: "Stopped.",
		};
		const idleDetail = model.idleDetail || fallbackDetail[model.status];
		lines.push(truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("dim", idleDetail)}`, width));
		return lines;
	}
	const visible = rows.slice(0, Math.max(0, limit));
	for (const row of visible) lines.push(renderRow(row, width, theme, now, frame));
	if (rows.length > visible.length) {
		lines.push(truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${rows.length - visible.length} more agents`)}`, width));
	}
	return lines;
}

export class HerderWidget {
	private ui?: WidgetUI;
	private tui?: TUI;
	private model?: HerderWidgetModel;
	private widgetKind?: WidgetKind;
	private timer?: ReturnType<typeof setInterval>;
	private frame = 0;

	update(ctx: ExtensionContext, model: HerderWidgetModel | undefined): void {
		if (ctx.ui !== this.ui) {
			this.clear();
			this.ui = ctx.ui;
		}
		this.model = model;
		if (!model) {
			this.clearWidget();
			return;
		}

		const active = model.workers.some((worker) => worker.status === "prepared" || worker.status === "running" || worker.status === "stopping");
		if (ctx.mode === "tui" && active) this.ensureTimer();
		else this.stopTimer();

		if (ctx.mode !== "tui") {
			ctx.ui.setWidget("herder", workerFleetTreeLines(model, ctx.ui.theme, 120), { placement: "belowEditor" });
			this.widgetKind = "static";
			this.tui = undefined;
			return;
		}

		if (this.widgetKind !== "component") {
			ctx.ui.setWidget("herder", (tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.model ? workerFleetTreeLines(this.model, theme, width, Date.now(), this.frame) : [],
					invalidate: () => {},
					dispose: () => {
						if (this.tui === tui) this.tui = undefined;
					},
				};
			}, { placement: "belowEditor" });
			this.widgetKind = "component";
			return;
		}
		this.tui?.requestRender();
	}

	dispose(): void {
		this.clear();
		this.ui = undefined;
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER.length;
			this.tui?.requestRender();
		}, TICK_MS);
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private clearWidget(): void {
		this.stopTimer();
		if (this.ui && this.widgetKind) this.ui.setWidget("herder", undefined);
		this.widgetKind = undefined;
		this.tui = undefined;
	}

	private clear(): void {
		this.model = undefined;
		this.clearWidget();
	}
}
