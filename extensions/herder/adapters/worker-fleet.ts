import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { PiWorkerSnapshot } from "./worker-engine.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 200;
const MAX_VISIBLE_WORKERS = 5;

// Nerd Font glyphs (Font Awesome range), matching the statusline footer.
const I = {
	herder: "\uF0C0", // users
	initializing: "\uF110", // spinner
	running: "\uF04B", // play
	paused: "\uF04C", // pause
	needsInput: "\uF128", // question
	complete: "\uF00C", // check
	failed: "\uF00D", // times
	stopped: "\uF04D", // stop
	dashboard: "\uF0E4", // tachometer
	profile: "\uF135", // rocket
	parallel: "\uF0E8", // sitemap
	plans: "\uF07C", // folder-open
	progress: "\uF0AE", // tasks
} as const;

const ACTIVITY_LABELS: Record<string, string> = {
	bash: "running command",
	edit: "editing",
	find: "finding files",
	grep: "searching",
	ls: "listing files",
	read: "reading",
	write: "writing",
};

export interface HerderWidgetModel {
	status: "initializing" | "running" | "paused" | "needs_input" | "complete" | "failed" | "stopped";
	profile: string;
	maxParallel: number;
	planName: string;
	summaryLine?: string;
	dashboardUrl?: string;
	workers: readonly PiWorkerSnapshot[];
}

type WidgetKind = "component" | "static";
type WidgetUI = ExtensionContext["ui"];

function roleLabel(role: PiWorkerSnapshot["role"]): string {
	const label = role.replace(/^plan-/, "");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}t`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
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

function workerActivity(worker: PiWorkerSnapshot): string {
	if (worker.status === "stopping") return "stopping…";
	if (worker.status === "prepared") return "starting…";
	if (!worker.activity) return "thinking…";
	return `${ACTIVITY_LABELS[worker.activity] ?? worker.activity}…`;
}

function rightAlign(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	const clampedLeft = truncateToWidth(left, leftWidth);
	const gap = Math.max(1, width - visibleWidth(clampedLeft) - rightWidth);
	return truncateToWidth(`${clampedLeft}${" ".repeat(gap)}${right}`, width);
}

function renderWorkerLine(
	worker: PiWorkerSnapshot,
	prefix: string,
	connector: "├─" | "└─",
	width: number,
	theme: Theme,
	now: number,
	frame: number,
): string {
	const activity = theme.fg("dim", workerActivity(worker));
	const left = `${theme.fg("dim", prefix + connector)} ${workerIcon(worker, frame, theme)} ${theme.bold(roleLabel(worker.role))}  ${activity}`;
	const stats: string[] = [`r${worker.round}`];
	if (worker.turns > 0) stats.push(`↻${worker.turns}`);
	if (worker.toolUses > 0) stats.push(`${worker.toolUses} tool${worker.toolUses === 1 ? "" : "s"}`);
	if (worker.tokens > 0) stats.push(formatTokens(worker.tokens));
	stats.push(formatWorkerElapsed(worker.startedAt, now));
	return rightAlign(left, theme.fg("dim", stats.join(" · ")), width);
}

export function workerFleetTreeLines(
	model: HerderWidgetModel,
	theme: Theme,
	width: number,
	now = Date.now(),
	frame = 0,
	limit = MAX_VISIBLE_WORKERS,
): string[] {
	const style = statusStyle(model.status);
	const separator = theme.fg("borderMuted", " · ");
	const headerParts = [
		theme.fg("accent", `${I.herder} `) + theme.bold("Herder") + " " + theme.fg(style.color, `${style.icon} ${model.status.toUpperCase()}`),
		...(model.dashboardUrl
			? [theme.fg("syntaxFunction", `${I.dashboard} `) + theme.fg("muted", `Dashboard ${model.dashboardUrl}`)]
			: []),
		theme.fg("syntaxKeyword", `${I.profile} `) + theme.fg("muted", model.profile),
		theme.fg("syntaxFunction", `${I.parallel} `) + theme.fg("muted", `max ${model.maxParallel}`),
		theme.fg("syntaxType", `${I.plans} `) + theme.fg("muted", model.planName),
		...(model.summaryLine
			? [theme.fg("success", `${I.progress} `) + theme.fg("muted", `Progress ${model.summaryLine}`)]
			: []),
	];
	const lines = [truncateToWidth(headerParts.join(separator), width)];
	const visibleWorkers = model.workers.slice(0, limit);
	const groups = new Map<string, PiWorkerSnapshot[]>();
	for (const worker of visibleWorkers) {
		const group = groups.get(worker.planId) ?? [];
		group.push(worker);
		groups.set(worker.planId, group);
	}

	type RootItem =
		| { kind: "plan"; planId: string; workers: PiWorkerSnapshot[] }
		| { kind: "waiting" }
		| { kind: "overflow"; count: number };
	const items: RootItem[] = [];
	for (const [planId, workers] of groups) items.push({ kind: "plan", planId, workers });
	if (model.workers.length === 0 && ["initializing", "running", "paused"].includes(model.status)) items.push({ kind: "waiting" });
	if (model.workers.length > visibleWorkers.length) items.push({ kind: "overflow", count: model.workers.length - visibleWorkers.length });

	for (const [itemIndex, item] of items.entries()) {
		const isLastRoot = itemIndex === items.length - 1;
		const connector = isLastRoot ? "└─" : "├─";
		if (item.kind === "waiting") {
			lines.push(truncateToWidth(`${theme.fg("dim", connector)} ${theme.fg("dim", "Waiting for manager dispatch…")}`, width));
			continue;
		}
		if (item.kind === "overflow") {
			lines.push(truncateToWidth(`${theme.fg("dim", connector)} ${theme.fg("dim", `+${item.count} more worker${item.count === 1 ? "" : "s"}`)}`, width));
			continue;
		}
		lines.push(truncateToWidth(`${theme.fg("dim", connector)} ${theme.fg("muted", `Plan ${item.planId}`)}`, width));
		const prefix = isLastRoot ? "   " : "│  ";
		for (const [workerIndex, worker] of item.workers.entries()) {
			lines.push(renderWorkerLine(
				worker,
				prefix,
				workerIndex === item.workers.length - 1 ? "└─" : "├─",
				width,
				theme,
				now,
				frame,
			));
		}
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
