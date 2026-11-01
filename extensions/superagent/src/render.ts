// The `superagent-report` message (text and renderer), ticket descriptions, the footer status, and the board widget.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { DispatchSummary, NotifyExtra, NotifyKind, TicketInfo } from "./dispatcher.ts";
import { ATTENTION_STATES, REPORT_MESSAGE, type Ticket, type TicketState } from "./types.ts";
import type { Mode } from "./router.ts";

export interface ReportDetails {
	ticketId: number;
	kind: NotifyKind;
	state: TicketState;
	title: string;
	branch: string;
	summary?: string;
	question?: string;
	tests?: string;
	reason?: string;
	ahead?: number;
	files?: string[];
	target?: string;
	at: number;
}

/** Several reports delivered together. */
export interface ReportBatch { batch: ReportDetails[] }

const one = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
/** No terminal control sequences from a worker reach the TUI. */
export const sanitize = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const FILES_SHOWN = 20;

export function reportDetails(ticket: Ticket, kind: NotifyKind, extra: NotifyExtra = {}, now = Date.now()): ReportDetails {
	const summary = kind === "waiting" ? ticket.lastText
		: kind === "failed" && ticket.report?.state !== "failed" ? ticket.error
		: ticket.report?.summary;
	return {
		ticketId: ticket.id, kind, state: ticket.state, title: ticket.title, branch: ticket.branch,
		...(summary ? { summary } : {}),
		...(ticket.question && (kind === "question" || kind === "blocked") ? { question: ticket.question } : {}),
		...(ticket.report?.tests && kind === "ready" ? { tests: ticket.report.tests } : {}),
		...(extra.reason ? { reason: extra.reason } : {}),
		...(extra.ahead !== undefined ? { ahead: extra.ahead } : {}),
		...(extra.files ? { files: extra.files } : {}),
		...(extra.target ? { target: extra.target } : {}),
		at: now,
	};
}

/** The message's lines, also its model-facing content; the first is `#<id> <kind> · <title>`. */
export function reportLines(details: ReportDetails): string[] {
	const lines = [`#${details.ticketId} ${details.kind} · ${details.title}`];
	if (details.state !== details.kind && details.kind !== "dropped") lines.push(`State: ${details.state}`);
	if (details.question) lines.push(`Question: ${details.question}`);
	if (details.reason) lines.push(`${details.kind === "merge-refused" ? "Refused" : "Merge"}: ${details.reason}`);
	if (details.summary) lines.push(`${details.kind === "waiting" ? "Last text" : "Summary"}: ${details.summary}`);
	if (details.tests) lines.push(`Checks: ${details.tests}`);
	if (details.kind === "merged") lines.push(`Merged into ${details.target ?? "the target"}${details.ahead !== undefined ? ` (${details.ahead} commit${details.ahead === 1 ? "" : "s"})` : ""}; worktree and branch removed.`);
	else {
		lines.push(`Branch: ${details.branch}`);
		if (details.ahead !== undefined) lines.push(`Ahead of ${details.target ?? "the target"}: ${details.ahead} commit${details.ahead === 1 ? "" : "s"}`);
		if (details.files?.length) {
			lines.push(`Files (${details.files.length}):`);
			lines.push(...details.files.slice(0, FILES_SHOWN).map((file) => `  ${file}`));
			if (details.files.length > FILES_SHOWN) lines.push(`  … ${details.files.length - FILES_SHOWN} more`);
		}
	}
	return lines;
}

export function reportContent(details: ReportDetails): string {
	return reportLines(details).join("\n");
}

/** One report, or several joined by blank lines in one message. */
export function reportMessage(reports: readonly ReportDetails[]): { customType: string; content: string; display: true; details: ReportDetails | ReportBatch } {
	const content = reports.map(reportContent).join("\n\n");
	return { customType: REPORT_MESSAGE, content, display: true, details: reports.length === 1 ? reports[0]! : { batch: [...reports] } };
}

const isDetails = (value: unknown): value is ReportDetails => typeof (value as ReportDetails | undefined)?.ticketId === "number";

const COLOR: Partial<Record<TicketState, "success" | "warning" | "error" | "accent" | "dim">> = {
	ready: "success", merged: "success", question: "warning", blocked: "warning", waiting: "warning", interrupted: "warning",
	failed: "error", working: "accent", queued: "dim", closed: "dim",
};
const COLLAPSED = 4;

export function registerRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<ReportDetails | ReportBatch>(REPORT_MESSAGE, (message, { expanded }, theme) => {
		const details = message.details;
		if (isDetails(details)) return new Text(renderReport(details, expanded, theme), 0, 0);
		const batch = (details as ReportBatch | undefined)?.batch;
		if (!Array.isArray(batch) || !batch.every(isDetails)) return undefined;
		return new Text(batch.map((item) => renderReport(item, expanded, theme)).join("\n"), 0, 0);
	});
}

export function renderReport(details: ReportDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const [header, ...rest] = reportLines(details).map(sanitize);
	const body = rest.flatMap((line) => line.split("\n"));
	const shown = expanded ? body : body.slice(0, COLLAPSED).map((line) => clip(line, 200));
	const more = body.length - shown.length;
	const color = COLOR[details.state] ?? "accent";
	return [
		`${theme.fg(color, "◆ ticket")} ${theme.bold(header!)}`,
		...shown.map((line) => `  ${line}`),
		...(more > 0 ? [theme.fg("dim", `  … ${more} more line${more === 1 ? "" : "s"}`)] : []),
	].join("\n");
}

/** One line per ticket for `/tickets` and `ticket_status`. */
export function ticketLine(ticket: Ticket, sessionId?: string): string {
	const extra = ticket.question ? ` — asks: ${clip(one(ticket.question), 100)}` : ticket.state === "failed" && ticket.error ? ` — ${clip(one(ticket.error), 100)}` : "";
	const other = sessionId !== undefined && ticket.owner !== sessionId ? " (another session's)" : "";
	return `#${ticket.id} [${ticket.state}] ${ticket.title}${other}${extra}`;
}

/** `/tickets N`, `#N`, and `ticket_status({ id })`. */
export function describeTicket(info: TicketInfo): string {
	const { ticket } = info;
	const lines = [
		`#${ticket.id} ${ticket.title}`,
		`State: ${ticket.state}${info.running ? " (running)" : ""}${ticket.mergeRequested ? ", merge requested" : ""}${info.mine ? "" : `, owned by session ${ticket.owner}`}`,
		`Branch: ${ticket.branch}${ticket.state === "merged" ? ` (merged into ${ticket.mergedInto ?? "the target"})` : ""}`,
		`Worktree: ${ticket.worktree}`,
	];
	if (info.ahead !== undefined) lines.push(`Ahead of ${info.target ?? "the target"}: ${info.ahead}${info.behind ? `, behind ${info.behind}` : ""}`);
	if (info.files?.length) lines.push(`Files: ${info.files.slice(0, FILES_SHOWN).join(", ")}${info.files.length > FILES_SHOWN ? `, … ${info.files.length - FILES_SHOWN} more` : ""}`);
	if (ticket.question) lines.push(`Question: ${ticket.question}`);
	if (ticket.report) lines.push(`Last report (${ticket.report.state}): ${ticket.report.summary}${ticket.report.tests ? `\nChecks: ${ticket.report.tests}` : ""}`);
	else if (ticket.lastText) lines.push(`Last text: ${clip(ticket.lastText, 600)}`);
	if (ticket.error) lines.push(`Error: ${ticket.error}`);
	if (ticket.closedReason) lines.push(`Closed: ${ticket.closedReason}`);
	if (ticket.pending?.length) lines.push(`Pending messages: ${ticket.pending.length}`);
	return lines.map(sanitize).join("\n");
}

/** The footer: the mode and counts of working tickets and tickets waiting for the user. */
export function footerText(mode: Mode, summary?: Pick<DispatchSummary, "working" | "attention" | "queued">): string {
	const parts = [`superagent: ${mode === "superagent" ? "on" : "direct"}`];
	if (summary?.working) parts.push(`${summary.working} working`);
	if (summary?.queued) parts.push(`${summary.queued} queued`);
	if (summary?.attention) parts.push(`${summary.attention} for you`);
	return parts.join(" · ");
}

const GROUPS: { label: string; matches(ticket: Ticket): boolean }[] = [
	{ label: "needs you", matches: (ticket) => ATTENTION_STATES.has(ticket.state) && ticket.state !== "ready" },
	{ label: "ready to merge", matches: (ticket) => ticket.state === "ready" },
	{ label: "working", matches: (ticket) => ticket.state === "working" },
	{ label: "queued", matches: (ticket) => ticket.state === "queued" },
];

/**
 * The board widget: open tickets grouped by what they wait for, one line per non-empty group; empty without open
 * tickets. `waitsOn` gives the `after` tickets a queued one still waits for.
 */
export function boardLines(open: readonly Ticket[], waitsOn: (ticket: Ticket) => number[] = (ticket) => ticket.after ?? []): string[] {
	const lines: string[] = [];
	for (const group of GROUPS) {
		const items = open.filter((ticket) => group.matches(ticket)).map((ticket) => {
			const title = clip(one(sanitize(ticket.title)), 40);
			const detail = group.label === "needs you" ? ` (${ticket.state})`
				: group.label === "queued" && waitsOn(ticket).length ? ` (after ${waitsOn(ticket).map((dep) => `#${dep}`).join(", ")})`
				: group.label === "ready to merge" && ticket.mergeWhenReady ? " (merging)" : "";
			return `#${ticket.id} ${title}${detail}`;
		});
		if (items.length) lines.push(`${group.label}: ${items.join(" · ")}`);
	}
	return lines;
}
