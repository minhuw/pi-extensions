// `/ps`: pick a process, then show its last lines, restart it, or stop it; or clear finished records. Stops and
// restarts chosen here are reported to the owning session without starting a turn. Without a UI it prints the table.
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { exitDescription, isLive, processTable } from "./format.ts";
import { withRequestedStop } from "./state.ts";
import type { ProcessInfo, ProcessManager } from "./types.ts";

export const LOG_LINES = 100;
export const CLEAR = "Clear finished";
export const ACTIONS = { logs: "Logs", restart: "Restart", stop: "Stop" } as const;

export function processLabel(process: ProcessInfo): string {
	const exit = exitDescription(process);
	return [process.name, process.id, process.status + (exit ? ` (${exit})` : ""), process.pid === undefined ? "" : `pid ${process.pid}`, ...process.urls]
		.filter(Boolean)
		.join("  ");
}

/** Removes terminal escape sequences and control characters other than tabs. */
export function plain(line: string): string {
	return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** The last lines of a log, scrolled with the arrow keys and closed with Esc or q. */
class LogPane {
	private scroll: number;

	constructor(
		private readonly tui: Pick<TUI, "requestRender"> & { terminal: { rows: number } },
		private readonly theme: Theme,
		private readonly title: string,
		private readonly lines: string[],
		private readonly done: () => void,
	) {
		this.scroll = Math.max(0, lines.length - this.height());
	}

	private height(): number {
		return Math.max(3, Math.floor(this.tui.terminal.rows * 0.7) - 4);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const max = Math.max(0, this.lines.length - this.height());
		let next = this.scroll;
		if (matchesKey(data, "escape") || matchesKey(data, "q")) return this.done();
		if (matchesKey(data, "up")) next--;
		else if (matchesKey(data, "down")) next++;
		else if (matchesKey(data, "pageUp")) next -= this.height();
		else if (matchesKey(data, "pageDown")) next += this.height();
		else return;
		this.scroll = Math.max(0, Math.min(max, next));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const visible = this.lines.slice(this.scroll, this.scroll + this.height());
		const range = this.lines.length > 0 ? `lines ${this.scroll + 1}-${this.scroll + visible.length} of ${this.lines.length}` : "no output";
		return [
			th.fg("accent", this.title),
			...visible.map((line) => line.replace(/\t/g, "   ")),
			th.fg("dim", `${range} · ↑↓ scroll · Esc close`),
		].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
	}
}

async function showLogs(ctx: ExtensionCommandContext, manager: ProcessManager, process: ProcessInfo): Promise<void> {
	const read = await manager.logs(process.id, { tail: LOG_LINES });
	const lines = read.lines.map(plain);
	const title = `${process.name} · ${process.logPath}`;
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${title}\n${lines.join("\n") || "(no output)"}`, "info");
		return;
	}
	await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new LogPane(tui, theme, title, lines, () => done(undefined)), { overlay: true });
}

export function registerPsCommand(pi: ExtensionAPI, manager: () => ProcessManager): void {
	pi.registerCommand("ps", {
		description: "Managed processes: logs, restart, stop, clear finished",
		handler: async (_args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: "ps", kind: "extension", extension: "processes" });
			const processes = manager().list();
			if (!ctx.hasUI) {
				ctx.ui.notify(processTable(processes), "info");
				return;
			}
			if (processes.length === 0) {
				ctx.ui.notify("No managed processes.", "info");
				return;
			}
			const labels = processes.map(processLabel);
			const options = processes.some((p) => !isLive(p)) ? [...labels, CLEAR] : labels;
			const picked = await ctx.ui.select("Processes", options);
			if (picked === undefined) return;
			if (picked === CLEAR) {
				const count = manager().clear();
				ctx.ui.notify(`Cleared ${count} finished process${count === 1 ? "" : "es"}.`, "info");
				return;
			}
			const process = processes[labels.indexOf(picked)]!;
			const actions = isLive(process) ? [ACTIONS.logs, ACTIONS.restart, ACTIONS.stop] : [ACTIONS.logs, ACTIONS.restart];
			const action = await ctx.ui.select(processLabel(process), actions);
			const user = { by: "user" as const, session: ctx.sessionManager.getSessionId() };
			if (action === ACTIONS.logs) await showLogs(ctx, manager(), process);
			else if (action === ACTIONS.restart) {
				const restarted = await withRequestedStop(process.id, user, () => manager().restart(process.id));
				ctx.ui.notify(`Restarted ${restarted.name} (pid ${restarted.pid ?? "-"}).`, "info");
			} else if (action === ACTIONS.stop) {
				if (!(await ctx.ui.confirm("Stop process", `Stop ${process.name} (${process.command})?`))) return;
				const result = await withRequestedStop(process.id, user, () => manager().stop(process.id));
				ctx.ui.notify(`${process.name}: ${result.outcome}.`, result.outcome === "stuck" ? "error" : "info");
			}
		},
	});
}
