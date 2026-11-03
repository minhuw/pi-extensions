import { Fragment, useId, useMemo, useState } from "react";
import { BUTTON, cx } from "./ui";
import { Icon } from "./icons";
import { ModelName } from "./ModelName";
import { formatCost, formatCount, totalTokens } from "../lib/format";
import type { Tokens, UsageBreakdown, UsageRequestMetrics } from "../lib/types";
import { formatFineCost, formatSpan } from "../trace/format";
import { formatTokenRate } from "../trace/performance";

export function cacheReadShare(tokens: Tokens): number | undefined {
	const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	return prompt > 0 ? tokens.cacheRead / prompt : undefined;
}

export function completionShare(metrics: UsageRequestMetrics): number | undefined {
	const known = metrics.completed + metrics.failed + metrics.aborted;
	return known > 0 ? metrics.completed / known : undefined;
}

export function usageGroupName(row: UsageBreakdown): string {
	if (row.kind === "unpublished") return "Unpublished & hidden";
	if (row.kind === "other-usage") return "Compaction & other usage";
	return row.name ?? (row.kind === "model" ? "Unknown model" : "No project");
}

const percent = (value: number | undefined) => (value === undefined ? "—" : `${(value * 100).toFixed(1)}%`);
const exact = (value: number) => value.toLocaleString("en-US");
const keyOf = (row: UsageBreakdown) => JSON.stringify([row.kind, row.name]);
const PAGE_SIZE = 10;

type Sort = "tokens" | "requests" | "cost" | "cache" | "failures" | "ttft" | "speed";
function sortValue(row: UsageBreakdown, sort: Sort): number | undefined {
	switch (sort) {
		case "tokens": return totalTokens(row.tokens);
		case "requests": return row.requests;
		case "cost": return row.cost;
		case "cache": return cacheReadShare(row.tokens);
		case "failures": return row.metrics.failed;
		case "ttft": return row.metrics.ttftMs ?? undefined;
		case "speed": return row.metrics.tokensPerSecond ?? undefined;
	}
}

/**
 * The table's numeric columns. Narrow screens keep the name, tokens, and cost; each wider step adds columns back, and a
 * row's details always carry every value.
 */
const COLUMNS: { sort: Sort | "share"; label: string; width: string; hide?: string; title?: string }[] = [
	{ sort: "tokens", label: "Tokens", width: "w-[92px]" },
	{ sort: "share", label: "Share", width: "w-[136px]", hide: "max-sm:hidden", title: "Share of all tokens in the period" },
	{ sort: "requests", label: "Requests", width: "w-[96px]", hide: "max-md:hidden" },
	{ sort: "cost", label: "Cost", width: "w-[92px]" },
	{ sort: "cache", label: "Cache reads", width: "w-[108px]", hide: "max-lg:hidden", title: "Cache reads / recorded prompt tokens" },
	{ sort: "failures", label: "Failed / aborted", width: "w-[128px]", hide: "max-md:hidden" },
	{ sort: "ttft", label: "Avg TTFT", width: "w-[92px]", hide: "max-lg:hidden", title: "Mean time from request to first token" },
	{ sort: "speed", label: "Tok/s", width: "w-[76px]", hide: "max-lg:hidden", title: "Measured output tokens per streaming second" },
];

function SortArrow({ ascending }: { ascending: boolean }) {
	return (
		<svg width="8" height="8" viewBox="0 0 8 8" className={cx("shrink-0", ascending && "rotate-180")} aria-hidden="true">
			<path d="M1 2.5h6L4 6.5z" fill="currentColor" />
		</svg>
	);
}

function Chevron({ open }: { open: boolean }) {
	return (
		<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cx("shrink-0 text-muted transition-transform duration-150", open && "rotate-90")} aria-hidden="true">
			<path d="M3.5 2 6.5 5 3.5 8" />
		</svg>
	);
}

function DetailGroup({ title, items }: { title: string; items: [string, string][] }) {
	return (
		<div className="min-w-0">
			<h3 className="text-[12px] font-semibold">{title}</h3>
			<dl className="mt-1">
				{items.map(([label, value]) => (
					<div key={label} className="flex h-7 items-center justify-between gap-4 border-b border-line text-[12.5px] last:border-b-0">
						<dt className="text-muted">{label}</dt>
						<dd className="tnum">{value}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

/** Every exact value of one row, in three ledgers: what was used, what the requests did, and how fast they ran. */
function GroupDetails({ row }: { row: UsageBreakdown }) {
	const m = row.metrics;
	return (
		<div className="py-4 pr-2 pl-[18px] text-left">
			<div className="grid gap-x-10 gap-y-5 md:grid-cols-3">
				<DetailGroup
					title="Tokens"
					items={[
						["Input", exact(row.tokens.input)],
						["Output", exact(row.tokens.output)],
						["Cache read", exact(row.tokens.cacheRead)],
						["Cache write", exact(row.tokens.cacheWrite)],
						["Cache read share", percent(cacheReadShare(row.tokens))],
						["Tokens / request", row.requests ? formatCount(totalTokens(row.tokens) / row.requests) : "—"],
					]}
				/>
				<DetailGroup
					title="Requests"
					items={[
						["Requests", exact(row.requests)],
						["Completed", exact(m.completed)],
						["Failed", exact(m.failed)],
						["Aborted", exact(m.aborted)],
						["Outcome unknown", exact(m.unknown)],
						["Recorded cost / request", row.requests ? formatFineCost(row.cost / row.requests) || "$0" : "—"],
					]}
				/>
				<DetailGroup
					title="Timing"
					items={[
						["Average TTFT", formatSpan(m.ttftMs ?? undefined)],
						["Output rate", m.tokensPerSecond === null ? "—" : `${formatTokenRate(m.tokensPerSecond)} tok/s`],
						["TTFT timing coverage", `${exact(m.ttftCalls)} / ${exact(row.requests)}`],
						["Streams measured", exact(m.rateCalls)],
						["Trajectories", exact(row.sessions)],
					]}
				/>
			</div>
			{row.kind === "other-usage" && <p className="mt-3 text-[12px] text-muted">Compaction, summaries, and standalone usage have no recorded model attribution. They contribute tokens and cost, without adding model requests.</p>}
		</div>
	);
}

/**
 * Usage by project or by model, as the page's split switch chooses. `swatch` gives a row's layer colour in the chart
 * when the chart is split the same way, so the table doubles as the chart's key.
 */
export function UsageBreakdowns({
	projects,
	models,
	total,
	dimension,
	swatch,
}: {
	projects: UsageBreakdown[];
	models: UsageBreakdown[];
	total: number;
	dimension: "projects" | "models";
	swatch?: (row: UsageBreakdown) => string | undefined;
}) {
	const [search, setSearch] = useState("");
	const [sort, setSort] = useState<Sort>("tokens");
	const [ascending, setAscending] = useState(false);
	const [page, setPage] = useState(0);
	const [expanded, setExpanded] = useState(new Set<string>());
	const id = useId();
	const source = dimension === "projects" ? projects : models;
	const rows = useMemo(() => source.filter((row) => usageGroupName(row).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).toSorted((a, b) => {
		const av = sortValue(a, sort), bv = sortValue(b, sort);
		// Missing timing stays last in either sort direction; it never ranks as zero latency.
		if (av === undefined && bv !== undefined) return 1;
		if (av !== undefined && bv === undefined) return -1;
		return (av !== undefined && bv !== undefined ? (av - bv) * (ascending ? 1 : -1) : 0) || usageGroupName(a).localeCompare(usageGroupName(b)) || keyOf(a).localeCompare(keyOf(b));
	}), [source, search, sort, ascending]);
	const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
	const currentPage = Math.min(page, pages - 1);
	const visible = rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
	const noun = dimension === "projects" ? "Project" : "Model";
	const toggle = (key: string) => setExpanded((previous) => {
		const next = new Set(previous);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		return next;
	});
	// A new column sorts its most telling end first: the most usage, or the fastest first token.
	const sortBy = (key: Sort) => {
		if (key === sort) setAscending(!ascending);
		else {
			setSort(key);
			setAscending(key === "ttft");
		}
		setPage(0);
	};
	return (
		<section className="mt-14" aria-labelledby="usage-breakdown-title" data-usage-breakdowns="">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
				<h2 id="usage-breakdown-title" className="text-[16px] font-semibold">Breakdown by {noun.toLowerCase()}</h2>
				<div className="flex items-center gap-3 max-sm:w-full sm:ml-auto">
					<span className="tnum shrink-0 text-[12.5px] text-muted max-sm:order-last">{rows.length === source.length ? `${source.length} ${dimension}` : `${rows.length} of ${source.length}`}</span>
					<label className="flex h-8 min-w-0 items-center gap-1.5 rounded-sm border border-line px-2 text-muted focus-within:border-ink max-sm:flex-1 sm:w-[220px]">
						<Icon name="search" size={13} />
						<input
							type="search"
							aria-label={`Search ${dimension}`}
							placeholder={`Find a ${noun.toLowerCase()}`}
							value={search}
							onChange={(event) => {
								setSearch(event.target.value);
								setPage(0);
							}}
							className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
						/>
					</label>
				</div>
			</div>
			<div className="mt-3 overflow-x-auto">
				<table className="tnum w-full text-right text-[13px]">
					<caption className="sr-only">Usage by {dimension.slice(0, -1)} in this period; shares are of all tokens in the period. Select a name for its exact values.</caption>
					<thead className="text-[12px] text-muted">
						<tr className="border-b border-ink">
							<th scope="col" className="h-8 w-full pr-4 text-left font-medium">{noun}</th>
							{COLUMNS.map((column) => {
								const current = column.sort === sort;
								return (
									<th
										key={column.sort}
										scope="col"
										className={cx("pl-5 font-medium", column.width, column.hide)}
										aria-sort={current ? (ascending ? "ascending" : "descending") : undefined}
										title={column.title}
									>
										{column.sort === "share" ? (
											column.label
										) : (
											<button type="button" onClick={() => sortBy(column.sort as Sort)} className={cx("-mx-1 inline-flex h-6 items-center gap-1 rounded-sm px-1 whitespace-nowrap hover:text-ink", current && "text-ink")}>
												{current && <SortArrow ascending={ascending} />}
												{column.label}
											</button>
										)}
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						{visible.length === 0 ? (
							<tr>
								<td colSpan={COLUMNS.length + 1} className="py-8 text-left text-muted">{search ? `No ${dimension} match this search.` : "No attributed usage in this range."}</td>
							</tr>
						) : (
							visible.map((row, i) => {
								const key = keyOf(row), name = usageGroupName(row), open = expanded.has(key), detailId = `${id}-${dimension}-${i}`;
								const tokens = totalTokens(row.tokens);
								const share = total > 0 ? tokens / total : 0;
								// Sentinel rows (no project, unknown model, unpublished, other usage) are named by pika, not by the data.
								const sentinel = row.name === null;
								// A faint edge on the swatch keeps the lightest shades visible on the page.
								const fill = swatch?.(row);
								return (
									<Fragment key={key}>
										<tr className={cx("border-b border-line", open ? "bg-soft" : "hover:bg-hover")} data-usage-group={name}>
											<th scope="row" className="max-w-0 pr-4 text-left font-normal">
												<button
													type="button"
													onClick={() => toggle(key)}
													aria-expanded={open}
													aria-controls={open ? detailId : undefined}
													className="flex h-9 w-full min-w-0 items-center gap-2 rounded-sm text-left"
													title={row.kind === "unpublished" ? "Activity outside published projects, in one row so its project names stay private" : name}
												>
													<Chevron open={open} />
													{fill && <span className="size-2.5 shrink-0 [box-shadow:inset_0_0_0_1px_color-mix(in_srgb,var(--color-ink)_16%,transparent)]" style={{ background: fill }} aria-hidden="true" data-usage-swatch="" />}
													{row.kind === "model" && !sentinel ? (
														<ModelName model={name} keepName className="mono text-[12.5px] font-medium" />
													) : (
														<span className={cx("min-w-0 truncate", sentinel ? "text-muted" : "font-medium")}>{name}</span>
													)}
												</button>
											</th>
											<td className="pl-5" title={`${exact(tokens)} tokens`}>{formatCount(tokens)}</td>
											<td className="pl-5 max-sm:hidden">
												<span className="flex items-center justify-end gap-2">
													<span className="h-[5px] w-14 shrink-0 bg-hover" aria-hidden="true">
														<span className="block h-full bg-ink" style={{ width: `${share * 100}%` }} />
													</span>
													<span className="w-12 text-muted">{percent(share)}</span>
												</span>
											</td>
											<td className="pl-5 max-md:hidden">{formatCount(row.requests)}</td>
											<td className="pl-5">{formatCost(row.cost)}</td>
											<td className="pl-5 max-lg:hidden">{percent(cacheReadShare(row.tokens))}</td>
											<td className="pl-5 max-md:hidden" title={`${exact(row.metrics.failed)} failed, ${exact(row.metrics.aborted)} aborted`}>
												<span className={row.metrics.failed > 0 ? "text-red" : undefined}>{formatCount(row.metrics.failed)}</span>
												<span className="text-muted"> / {formatCount(row.metrics.aborted)}</span>
											</td>
											<td className="pl-5 max-lg:hidden" title={`${exact(row.metrics.ttftCalls)} requests timed`}>{formatSpan(row.metrics.ttftMs ?? undefined)}</td>
											<td className="pl-5 max-lg:hidden" title={`${exact(row.metrics.rateCalls)} streams measured`}>{formatTokenRate(row.metrics.tokensPerSecond ?? undefined)}</td>
										</tr>
										{open && (
											<tr id={detailId} className="border-b border-line bg-soft">
												<td colSpan={COLUMNS.length + 1}>
													<GroupDetails row={row} />
												</td>
											</tr>
										)}
									</Fragment>
								);
							})
						)}
					</tbody>
				</table>
			</div>
			{pages > 1 && (
				<div className="mt-2 flex items-center justify-end gap-1 text-[12.5px] text-muted">
					<span className="tnum mr-2">
						{currentPage * PAGE_SIZE + 1}–{Math.min(rows.length, (currentPage + 1) * PAGE_SIZE)} of {rows.length}
					</span>
					<button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className={BUTTON.quiet}>Previous</button>
					<button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)} className={BUTTON.quiet}>Next</button>
				</div>
			)}
		</section>
	);
}
