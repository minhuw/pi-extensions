import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { FilterChip, MenuOption } from "../components/FilterChip";
import { Icon, PikaLogo } from "../components/icons";
import { useScrollRoot } from "../components/Layout";
import { EmptyState, ErrorState, Page, PageTitle, Pill, Skeleton } from "../components/ui";
import { useApi, type SessionFilters } from "../lib/api";
import { formatCost, formatCount, formatDuration, formatRelative, totalTokens } from "../lib/format";
import type { SessionSummary } from "../lib/types";
import { useScrollMargin } from "../lib/virtual";

const PAGE_SIZE = 50;

function dayStart(value: string | null): string | undefined {
	if (!value) return undefined;
	const date = new Date(`${value}T00:00:00`);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function dayEnd(value: string | null): string | undefined {
	if (!value) return undefined;
	const date = new Date(`${value}T23:59:59.999`);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function filtersFromParams(params: URLSearchParams): SessionFilters {
	return {
		device: params.get("device") ?? undefined,
		project: params.get("project") ?? undefined,
		model: params.get("model") ?? undefined,
		from: dayStart(params.get("from")),
		to: dayEnd(params.get("to")),
		root: params.get("children") !== "1",
	};
}

function SessionRow({ session }: { session: SessionSummary }) {
	const tokens = totalTokens(session.tokens);
	return (
		<Link
			to={`/s/${encodeURIComponent(session.id)}`}
			className="block rounded-md px-3 py-2.5 hover:bg-hover"
			data-session-row={session.id}
		>
			<div className="flex min-w-0 items-center gap-2">
				<span className="min-w-0 truncate font-medium">{session.title || "Untitled session"}</span>
				{session.parentSessionId && <Pill>{session.link?.kind === "herder-step" ? "herder step" : "subagent"}</Pill>}
				{session.childCount > 0 && (
					<span className="flex shrink-0 items-center gap-1 text-[13px] text-muted" title="Child sessions">
						<Icon name="children" size={13} />
						{session.childCount}
					</span>
				)}
				<span className="ml-auto shrink-0 pl-3 text-[13px] text-muted" title={session.startedAt}>
					{formatRelative(session.startedAt)}
				</span>
			</div>
			<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
				<span className="flex items-center gap-1">
					<Icon name="folder" size={13} />
					{session.project || "—"}
				</span>
				<span className="flex items-center gap-1">
					<Icon name="device" size={13} />
					{session.device}
				</span>
				<span className="flex items-center gap-1">
					<Icon name="clock" size={13} />
					{formatDuration(session.durationMs)}
				</span>
				<span>{formatCount(tokens)} tokens</span>
				<span>{formatCost(session.cost)}</span>
				<span className="flex min-w-0 flex-wrap gap-1">
					{session.models.slice(0, 3).map((model) => (
						<Pill key={model}>{model}</Pill>
					))}
					{session.models.length > 3 && <Pill>+{session.models.length - 3}</Pill>}
				</span>
			</div>
		</Link>
	);
}

function RowSkeleton() {
	return (
		<div className="px-3 py-3">
			<Skeleton className="h-4 w-1/2" />
			<Skeleton className="mt-2 h-3 w-3/4" />
		</div>
	);
}

function Filters() {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	const facets = useQuery({ queryKey: ["facets"], queryFn: () => api.facets(), staleTime: 60_000 });

	const set = (key: string, value: string | undefined) => {
		const next = new URLSearchParams(params);
		if (value) next.set(key, value);
		else next.delete(key);
		setParams(next, { replace: true });
	};

	const facet = (key: "device" | "project" | "model", label: string, icon: "device" | "folder" | "model", options: string[]) => (
		<FilterChip key={key} icon={icon} label={label} value={params.get(key) ?? undefined}>
			{(close) => (
				<>
					<MenuOption
						selected={!params.get(key)}
						onSelect={() => {
							set(key, undefined);
							close();
						}}
					>
						Any {label.toLowerCase()}
					</MenuOption>
					{options.map((option) => (
						<MenuOption
							key={option}
							selected={params.get(key) === option}
							onSelect={() => {
								set(key, option);
								close();
							}}
						>
							{option}
						</MenuOption>
					))}
					{facets.isLoading && <div className="px-2 py-1 text-[13px] text-muted">Loading…</div>}
				</>
			)}
		</FilterChip>
	);

	const from = params.get("from") ?? "";
	const to = params.get("to") ?? "";
	const dateValue = from || to ? `${from || "…"} → ${to || "…"}` : undefined;
	const includeChildren = params.get("children") === "1";
	const active = ["device", "project", "model", "from", "to"].some((key) => params.get(key));

	return (
		<div className="flex flex-wrap items-center gap-2" aria-label="Filters">
			{facet("device", "Device", "device", facets.data?.devices ?? [])}
			{facet("project", "Project", "folder", facets.data?.projects ?? [])}
			{facet("model", "Model", "model", facets.data?.models ?? [])}
			<FilterChip icon="calendar" label="Date" value={dateValue}>
				{() => (
					<div className="space-y-2 p-2 text-[13px]">
						<label className="flex items-center justify-between gap-3">
							<span className="text-muted">From</span>
							<input
								type="date"
								value={from}
								max={to || undefined}
								onChange={(event) => set("from", event.target.value || undefined)}
								className="rounded-sm border border-line bg-page px-1.5 py-0.5"
							/>
						</label>
						<label className="flex items-center justify-between gap-3">
							<span className="text-muted">To</span>
							<input
								type="date"
								value={to}
								min={from || undefined}
								onChange={(event) => set("to", event.target.value || undefined)}
								className="rounded-sm border border-line bg-page px-1.5 py-0.5"
							/>
						</label>
					</div>
				)}
			</FilterChip>
			<label className="ml-1 flex h-7 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-[13px] text-muted hover:bg-hover">
				<input
					type="checkbox"
					checked={includeChildren}
					onChange={(event) => set("children", event.target.checked ? "1" : undefined)}
					className="accent-[#2383e2]"
				/>
				Include subagents and steps
			</label>
			{active && (
				<button
					type="button"
					onClick={() => {
						const next = new URLSearchParams();
						if (includeChildren) next.set("children", "1");
						setParams(next, { replace: true });
					}}
					className="h-7 rounded-sm px-1.5 text-[13px] text-muted hover:bg-hover"
				>
					Clear filters
				</button>
			)}
		</div>
	);
}

export function SessionListPage() {
	const api = useApi();
	const [params] = useSearchParams();
	const filters = useMemo(() => filtersFromParams(params), [params]);
	const sessions = useInfiniteQuery({
		queryKey: ["sessions", filters],
		queryFn: ({ pageParam }) => api.sessions(filters, pageParam, PAGE_SIZE),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
	});
	const items = useMemo(() => sessions.data?.pages.flatMap((page) => page.items) ?? [], [sessions.data]);

	const scrollRoot = useScrollRoot();
	const listRef = useRef<HTMLDivElement>(null);
	const scrollMargin = useScrollMargin(listRef, scrollRoot);
	const count = items.length + (sessions.hasNextPage ? 1 : 0);
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollRoot,
		estimateSize: () => 72,
		overscan: 8,
		scrollMargin,
		getItemKey: (index) => items[index]?.id ?? "loader",
	});
	const virtualItems = virtualizer.getVirtualItems();
	const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;

	const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = sessions;
	useEffect(() => {
		if (lastIndex >= items.length - 1 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
	}, [lastIndex, items.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

	return (
		<Page className="pb-24">
			<PageTitle>Sessions</PageTitle>
			<div className="mt-5">
				<Filters />
			</div>
			<hr className="mt-4 mb-2 border-0 border-t border-line" />
			{sessions.isPending ? (
				<div aria-busy="true" aria-label="Loading sessions">
					{Array.from({ length: 6 }, (_, i) => (
						<RowSkeleton key={i} />
					))}
				</div>
			) : sessions.isError && items.length === 0 ? (
				<ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
			) : items.length === 0 && params.toString() ? (
				<EmptyState title="No sessions">Nothing matches these filters.</EmptyState>
			) : items.length === 0 ? (
				<EmptyState title="No sessions yet" visual={<PikaLogo size={40} />}>
					Run <code className="code-chip">/pika login</code> in pi on each machine. Sessions appear here as they run.
				</EmptyState>
			) : (
				<div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }} data-session-list="">
					{virtualItems.map((row) => {
						const session = items[row.index];
						return (
							<div
								key={row.key}
								ref={virtualizer.measureElement}
								data-index={row.index}
								className="absolute top-0 left-0 w-full"
								style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
							>
								{session ? <SessionRow session={session} /> : <RowSkeleton />}
							</div>
						);
					})}
				</div>
			)}
			{sessions.isFetchNextPageError && <ErrorState error={sessions.error} onRetry={() => void sessions.fetchNextPage()} />}
		</Page>
	);
}
