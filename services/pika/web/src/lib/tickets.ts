// Superagent tickets as pika sees them: a ticket child's link data and the reports a ticket sends its main session.
import { formatDuration } from "./format";
import type { SessionLink, TicketInfo, TraceChild, TraceTurnReport } from "./types";

/** The highest ticket id the server accepts; anything else is ignored. */
export const TICKET_ID_MAX = 1_000_000_000;
/** A longer branch name is dropped, since a cut one names another branch. */
export const TICKET_BRANCH_CHARS = 255;
/** Ticket and report titles are cut to this many characters. */
export const TICKET_TITLE_CHARS = 200;
/** At most this many reports are read from one message. */
export const MAX_REPORTS = 50;

/** The tool that creates a ticket; its call spawns the ticket's child session. */
export const TICKET_CREATE_TOOL = "ticket_create";
/** The custom message type of a ticket's report in its main session. */
export const REPORT_TYPE = "superagent-report";

function validId(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= TICKET_ID_MAX ? value : undefined;
}

/** Trims a string and turns control characters into spaces; blank or non-strings give undefined. */
function cleanText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// eslint-disable-next-line no-control-regex
	const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
	return text || undefined;
}

function cutTitle(value: unknown): string | undefined {
	const text = cleanText(value);
	return text === undefined ? undefined : Array.from(text).slice(0, TICKET_TITLE_CHARS).join("");
}

function cleanBranch(value: unknown): string | undefined {
	const text = cleanText(value);
	return text !== undefined && Array.from(text).length <= TICKET_BRANCH_CHARS ? text : undefined;
}

function info(id: unknown, branch: unknown, title: unknown): TicketInfo | undefined {
	const valid = validId(id);
	if (valid === undefined) return undefined;
	const ticket: TicketInfo = { id: valid };
	const b = cleanBranch(branch);
	const t = cutTitle(title);
	if (b !== undefined) ticket.branch = b;
	if (t !== undefined) ticket.title = t;
	return ticket;
}

/** A session link's ticket: its `superagent: { ticketId, branch, title }` data, validated; malformed data is ignored. */
export function linkTicket(link: SessionLink | undefined): TicketInfo | undefined {
	const data = link?.superagent;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	return info(record.ticketId, record.branch, record.title);
}

/** A trace child's ticket, as the server sends it, checked again. */
export function traceTicket(child: Pick<TraceChild, "ticket"> | undefined): TicketInfo | undefined {
	const data = child?.ticket as unknown;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	return info(record.id, record.branch, record.title);
}

/** The title attribute of a ticket badge: the ticket and its branch. */
export function ticketTitle(ticket: TicketInfo): string {
	return ticket.branch ? `Ticket #${ticket.id} · ${ticket.branch}` : `Ticket #${ticket.id}`;
}

/** One report of a `superagent-report` message. */
export interface TicketReport {
	ticketId: number;
	kind: string;
	title: string;
	branch?: string;
	summary?: string;
	question?: string;
	reason?: string;
}

/** Report kinds that ask for the user's or the router's attention; failures among them are red. */
const ATTENTION = new Set(["question", "ready", "waiting", "merge-handed"]);
const FAILURE = new Set(["failed", "blocked", "merge-refused"]);

/** `attention` and `failure` reports start a turn; `settled` ones (merged, dropped, unknown) are notices. */
export type ReportTone = "attention" | "failure" | "settled";

export function reportTone(kind: string): ReportTone {
	if (FAILURE.has(kind)) return "failure";
	if (ATTENTION.has(kind)) return "attention";
	return "settled";
}

/** A report kind as words: `merge-refused` reads "merge refused". */
export function reportKindLabel(kind: string): string {
	return kind.replace(/-/g, " ");
}

const KIND = /^[a-z-]{1,32}$/;

function reportFrom(value: unknown): TicketReport | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const ticketId = validId(record.ticketId);
	const kind = typeof record.kind === "string" && KIND.test(record.kind) ? record.kind : undefined;
	if (ticketId === undefined || kind === undefined) return undefined;
	const report: TicketReport = { ticketId, kind, title: cutTitle(record.title) ?? "" };
	const branch = cleanBranch(record.branch);
	if (branch) report.branch = branch;
	for (const key of ["summary", "question", "reason"] as const) {
		const text = typeof record[key] === "string" ? (record[key] as string).trim() : "";
		if (text) report[key] = text.slice(0, 4000);
	}
	return report;
}

/** Reports from a message's `details`: one report, or `{ batch: [...] }`; undefined when it holds none. */
export function reportsFromDetails(details: unknown): TicketReport[] | undefined {
	if (!details || typeof details !== "object") return undefined;
	const batch = (details as { batch?: unknown }).batch;
	const list = Array.isArray(batch) ? batch : [details];
	const reports = list.slice(0, MAX_REPORTS).map(reportFrom).filter((report): report is TicketReport => report !== undefined);
	return reports.length ? reports : undefined;
}

const HEADER = /^#(\d{1,10}) ([a-z-]{1,32})(?: · (.*))?$/;

/** Reports from a message's text: each `#<ticketId> <kind> · <title>` line that starts it or follows a blank line. */
export function reportsFromText(text: string): TicketReport[] {
	const reports: TicketReport[] = [];
	let starts = true;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			starts = true;
			continue;
		}
		if (!starts) continue;
		starts = false;
		const match = HEADER.exec(line);
		const ticketId = match ? validId(Number(match[1])) : undefined;
		if (!match || ticketId === undefined) continue;
		reports.push({ ticketId, kind: match[2], title: cutTitle(match[3]) ?? "" });
		if (reports.length >= MAX_REPORTS) break;
	}
	return reports;
}

/** A message's reports: from its details when they hold any, else from its text. */
export function messageReports(details: unknown, text: string): TicketReport[] {
	return reportsFromDetails(details) ?? reportsFromText(text);
}

/** A turn's reports: the trace's `reports` (read from the whole text), else its text's headers. */
export function turnReports(turn: { customType?: string; userText: string; reports?: TraceTurnReport[] }): TicketReport[] {
	if (turn.customType !== REPORT_TYPE) return [];
	if (Array.isArray(turn.reports)) {
		const reports = turn.reports.map(reportFrom).filter((report): report is TicketReport => report !== undefined);
		if (reports.length) return reports;
	}
	return reportsFromText(turn.userText);
}

/** The label of a report message: "Ticket #3 ready" for one, "3 ticket reports" for a batch. */
export function reportsLabel(reports: TicketReport[]): string {
	if (reports.length === 0) return "Ticket report";
	if (reports.length === 1) return `Ticket #${reports[0].ticketId} ${reportKindLabel(reports[0].kind)}`;
	return `${reports.length} ticket reports`;
}

/** The note on a child that outlived its call: "background · ran 4m after the call returned". */
export function backgroundLabel(ms: number): string {
	return `background · ran ${formatDuration(ms)} after the call returned`;
}

/** How long a child ran after the call that spawned it returned, in ms, when more than a second; else undefined. */
export function ranPastCall(callEnd: number | undefined, childLast: number | undefined): number | undefined {
	if (callEnd === undefined || childLast === undefined || !Number.isFinite(callEnd) || !Number.isFinite(childLast)) return undefined;
	const after = childLast - callEnd;
	return after > 1000 ? after : undefined;
}
