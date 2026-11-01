import { reportKindLabel, reportTone, ticketTitle, type ReportTone, type TicketReport } from "../lib/tickets";
import type { TicketInfo } from "../lib/types";
import { cx } from "./ui";

/** A superagent ticket's `#N`, with its branch in the title. */
export function TicketBadge({ ticket, className }: { ticket: TicketInfo | undefined; className?: string }) {
	if (!ticket) return null;
	return (
		<span
			className={cx(
				"mono inline-flex h-[18px] shrink-0 items-center rounded-sm px-1 text-[11px] leading-none font-medium whitespace-nowrap text-ink shadow-[inset_0_0_0_1px_var(--color-k-agent)]",
				className,
			)}
			title={ticketTitle(ticket)}
			data-ticket-badge={ticket.id}
		>
			#{ticket.id}
		</span>
	);
}

/** Reports that need attention take the agent colour, failures red, and merged or dropped ones stay grey. */
export const REPORT_TONE_CLASSES: Record<ReportTone, string> = {
	attention: "bg-k-agent text-k-agent-ink",
	failure: "bg-red-soft text-red",
	settled: "bg-hover text-muted",
};

/** A report's `#N kind` tag, coloured by its kind. */
export function ReportTag({ report }: { report: Pick<TicketReport, "ticketId" | "kind" | "branch"> }) {
	const tone = reportTone(report.kind);
	return (
		<span
			className={cx("mono inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] leading-none font-medium whitespace-nowrap", REPORT_TONE_CLASSES[tone])}
			title={report.branch ? `Ticket #${report.ticketId} · ${report.branch}` : `Ticket #${report.ticketId}`}
			data-report-tag={report.kind}
			data-report-tone={tone}
		>
			#{report.ticketId} {reportKindLabel(report.kind)}
		</span>
	);
}

/** Each report of a message on its own line: its tag and title, and, when known, the question or reason. */
export function ReportList({ reports, detail = false, className }: { reports: TicketReport[]; detail?: boolean; className?: string }) {
	if (!reports.length) return null;
	return (
		<ul className={cx("flex min-w-0 flex-col gap-1", className)} data-report-list={reports.length}>
			{reports.map((report, i) => {
				const note = detail ? (report.question ?? report.reason ?? report.summary) : undefined;
				return (
					<li key={`${report.ticketId}:${i}`} className="flex min-w-0 flex-col" data-report={report.ticketId}>
						<span className="flex min-w-0 items-center gap-2">
							<ReportTag report={report} />
							<span className="min-w-0 truncate text-[14px] text-ink" title={report.title}>
								{report.title || <span className="text-muted italic">Untitled ticket</span>}
							</span>
						</span>
						{note && <span className="mt-0.5 line-clamp-2 pl-1 text-[13px] text-muted">{note}</span>}
					</li>
				);
			})}
		</ul>
	);
}
