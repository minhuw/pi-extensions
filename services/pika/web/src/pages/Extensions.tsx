import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { cx, EmptyState, ErrorState, Page, PageTitle, Segmented, Skeleton } from "../components/ui";
import { useApi } from "../lib/api";
import { formatCount, formatDateTime, formatRelative } from "../lib/format";
import type { CommandUsage, ExtensionUsage, ToolUsage } from "../lib/types";

const RANGES = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["365", "365 days"]] as const;
type Range = (typeof RANGES)[number][0];

const TH = "h-7 px-2 pb-1 text-left align-bottom text-[12px] font-medium whitespace-nowrap text-muted";
const TH_NUM = cx(TH, "text-right");
const TD = "px-2 py-1.5 align-middle";
const TD_NUM = cx(TD, "tnum text-right whitespace-nowrap");

const errorRate = (tool: ToolUsage) => (tool.calls > 0 ? `${((tool.errors / tool.calls) * 100).toFixed(1)}%` : "—");

function LastUsed({ at }: { at: number | null }) {
	return (
		<td className={cx(TD, "tnum whitespace-nowrap text-muted")} title={at === null ? undefined : formatDateTime(at)}>
			{at === null ? "—" : formatRelative(new Date(at).toISOString())}
		</td>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	const id = `extension-usage-${title.toLowerCase()}`;
	return (
		<section aria-labelledby={id} className="mt-9 min-w-0">
			<h2 id={id} className="text-[16px] font-semibold">{title}</h2>
			<div className="mt-3 overflow-x-auto">{children}</div>
		</section>
	);
}

function ToolsTable({ tools }: { tools: ToolUsage[] }) {
	if (tools.length === 0) return <EmptyState title="No tool calls in this range" />;
	return (
		<table className="w-full border-collapse text-[13px]" data-extension-tools="">
			<thead>
				<tr className="border-b border-ink">
					<th scope="col" className={TH}>Tool</th>
					<th scope="col" className={TH_NUM}>Calls</th>
					<th scope="col" className={TH_NUM}>Sessions</th>
					<th scope="col" className={TH_NUM}>Error rate</th>
					<th scope="col" className={TH}>Last used</th>
				</tr>
			</thead>
			<tbody>
				{tools.map((tool) => (
					<tr key={tool.name} className="border-b border-line hover:bg-hover" data-tool={tool.name}>
						<td className={cx(TD, "font-mono text-[12px] [overflow-wrap:anywhere]")}>{tool.name}</td>
						<td className={TD_NUM}>{formatCount(tool.calls)}</td>
						<td className={TD_NUM}>{formatCount(tool.sessions)}</td>
						<td className={cx(TD_NUM, tool.errors > 0 ? "text-red" : "text-muted")} title={`${tool.errors} of ${tool.calls} calls failed`}>
							{errorRate(tool)}
						</td>
						<LastUsed at={tool.lastAt} />
					</tr>
				))}
			</tbody>
		</table>
	);
}

function CommandsTable({ commands }: { commands: CommandUsage[] }) {
	if (commands.length === 0) return <EmptyState title="No commands in this range" />;
	return (
		<table className="w-full border-collapse text-[13px]" data-extension-commands="">
			<thead>
				<tr className="border-b border-ink">
					<th scope="col" className={TH}>Command</th>
					<th scope="col" className={TH}>Kind</th>
					<th scope="col" className={TH}>Extension</th>
					<th scope="col" className={TH_NUM}>Uses</th>
					<th scope="col" className={TH_NUM}>Sessions</th>
					<th scope="col" className={TH}>Last used</th>
				</tr>
			</thead>
			<tbody>
				{commands.map((command) => (
					<tr key={`${command.kind}:${command.extension ?? ""}:${command.command}`} className="border-b border-line hover:bg-hover" data-command={command.command}>
						<td className={cx(TD, "font-mono text-[12px] [overflow-wrap:anywhere]")}>/{command.command}</td>
						<td className={cx(TD, "text-muted")}>{command.kind}</td>
						<td className={cx(TD, "text-muted [overflow-wrap:anywhere]")}>{command.extension ?? "—"}</td>
						<td className={TD_NUM}>{formatCount(command.uses)}</td>
						<td className={TD_NUM}>{formatCount(command.sessions)}</td>
						<LastUsed at={command.lastAt} />
					</tr>
				))}
			</tbody>
		</table>
	);
}

function ExtensionUsageData({ data }: { data: ExtensionUsage }) {
	return (
		<>
			<Section title="Tools">
				<ToolsTable tools={data.tools} />
			</Section>
			<Section title="Commands">
				<CommandsTable commands={data.commands} />
			</Section>
		</>
	);
}

export function ExtensionsPage() {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	const rawDays = params.get("days") ?? "90";
	const days: Range = RANGES.find(([value]) => value === rawDays)?.[0] ?? "90";
	const usage = useQuery({
		queryKey: ["extension-usage", days],
		queryFn: () => api.extensionUsage(Number(days)),
		// A new range keeps the current tables, dimmed, until its own arrive.
		placeholderData: keepPreviousData,
	});
	const change = (value: Range) =>
		setParams((previous) => {
			const next = new URLSearchParams(previous);
			next.set("days", value);
			return next;
		}, { replace: true });
	return (
		<Page className="pb-24">
			<div data-extensions-page="">
				<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
					<div className="min-w-0">
						<PageTitle>Extensions</PageTitle>
						<p className="tnum mt-1.5 text-[13px] text-muted">
							{usage.data ? `Tool calls and commands since ${formatDateTime(usage.data.since)}` : "Tool calls and commands"}
						</p>
					</div>
					<Segmented label="Usage period" value={days} options={RANGES} onChange={change} />
				</div>
				{usage.isPending ? (
					<div className="mt-9" aria-busy="true" aria-label="Loading extension usage">
						<Skeleton className="h-64 w-full" />
					</div>
				) : usage.isError ? (
					<div className="mt-6">
						<ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
					</div>
				) : (
					<div className={cx("transition-opacity duration-150", usage.isPlaceholderData && "opacity-55")} aria-busy={usage.isPlaceholderData || undefined}>
						<ExtensionUsageData data={usage.data} />
					</div>
				)}
			</div>
		</Page>
	);
}
