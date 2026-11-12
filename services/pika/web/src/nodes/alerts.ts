import { paneLabel, type NodeView } from "./client";
import { sanitize, type TerminalInfo } from "./contract";

export interface PaneAlert {
	node: string;
	terminalId: string;
	kind: "waiting" | "done";
	title: string;
	body: string;
}

export interface PaneFocus {
	node?: string;
	terminalId?: string;
	/** The page is visible (`document.visibilityState`). */
	visible: boolean;
}

const waiting = (terminal: TerminalInfo): boolean => !terminal.exited && terminal.status?.state === "waiting";
const done = (terminal: TerminalInfo): boolean => !terminal.exited && terminal.status?.state === "idle" && terminal.status.unread;

function waitingBody(terminal: TerminalInfo): string {
	const program = terminal.status?.program;
	const message = sanitize(program?.message);
	if (message) return message;
	if (program?.kind === "permission") return "Needs permission";
	if (program?.kind === "auth") return "Needs login";
	return "Waiting for you";
}

/**
 * Which panes just started waiting or just finished (unread), for browser notifications. A pane alerts on the change
 * only, never for the state it had when the page first saw it, and never while it is the pane on screen in a visible
 * page. Panes are remembered across reconnects, so a change made while the channel was down still alerts once.
 */
export class PaneAlerts {
	#seen = new Map<string, { waiting: boolean; done: boolean }>();

	update(nodes: readonly NodeView[], focus: PaneFocus): PaneAlert[] {
		const alerts: PaneAlert[] = [];
		for (const view of nodes) {
			for (const terminal of view.terminals) {
				const key = `${view.info.id}\n${terminal.terminalId}`;
				const now = { waiting: waiting(terminal), done: done(terminal) };
				const before = this.#seen.get(key);
				this.#seen.set(key, now);
				if (!before) continue;
				const onScreen = focus.visible && focus.node === view.info.id && focus.terminalId === terminal.terminalId;
				if (onScreen) continue;
				const base = { node: view.info.id, terminalId: terminal.terminalId, title: paneLabel(terminal) };
				if (now.waiting && !before.waiting) alerts.push({ ...base, kind: "waiting", body: waitingBody(terminal) });
				else if (now.done && !before.done) alerts.push({ ...base, kind: "done", body: `Finished on ${view.info.name}` });
			}
		}
		return alerts;
	}
}

/** Panes waiting for the user, and panes finished since last seen, on every node. */
export function paneCounts(nodes: readonly NodeView[]): { waiting: number; done: number } {
	let waitingCount = 0;
	let doneCount = 0;
	for (const view of nodes) {
		for (const terminal of view.terminals) {
			if (waiting(terminal)) waitingCount++;
			else if (done(terminal)) doneCount++;
		}
	}
	return { waiting: waitingCount, done: doneCount };
}

/**
 * The tab's title with the counts in front, so a background tab shows what needs looking at; with nothing to look at,
 * how many agents work (Orca's activity badge).
 */
export function countedTitle(base: string, counts: { waiting: number; done: number }, working = 0): string {
	const parts = [counts.waiting ? `${counts.waiting} waiting` : "", counts.done ? `${counts.done} done` : ""].filter(Boolean);
	if (parts.length) return `(${parts.join(", ")}) ${base}`;
	return working ? `(${working} working) ${base}` : base;
}
