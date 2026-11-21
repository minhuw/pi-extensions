import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { FilterChip, MenuOption, optionLabel, plainOptions } from "../components/FilterChip";
import { Icon, type IconName } from "../components/icons";
import { PikaLink as Link } from "../components/PikaLink";
import { BUTTON, cx, EmptyState, ErrorState, Page, PageTitle, Segmented, SkeletonLines } from "../components/ui";
import { useApi, type SearchSort } from "../lib/api";
import { deviceOptions } from "../lib/devices";
import { formatRelative } from "../lib/format";
import { useShortcuts } from "../lib/keyboard";
import { parseSnippet } from "../lib/snippet";
import type { SearchHit, SessionMatches } from "../lib/types";

export const SEARCH_DEBOUNCE_MS = 250;
/** Sessions per search; the server ranks the newest matches, so more would mostly be older ones. */
export const SESSION_LIMIT = 20;
/** Flat matches per page when browsing individual hits (`group=entry`). */
export const ENTRY_LIMIT = 50;

type SearchGroup = "session" | "entry";

const SORT_OPTIONS: readonly (readonly [SearchSort, string])[] = [
	["newest", "Newest"],
	["relevance", "Relevance"],
];

const GROUP_OPTIONS: readonly (readonly [SearchGroup, string])[] = [
	["session", "Sessions"],
	["entry", "Matches"],
];

const KINDS: Record<SearchHit["kind"], { icon: IconName; label: string }> = {
	user: { icon: "user", label: "Prompt" },
	assistant: { icon: "sparkle", label: "Assistant" },
	"tool-call": { icon: "tool", label: "Tool call" },
	"tool-result": { icon: "terminal", label: "Tool result" },
	title: { icon: "pencil", label: "Title" },
};

export function Snippet({ text }: { text: string }) {
	const parts = useMemo(() => parseSnippet(text), [text]);
	return (
		<span className="[overflow-wrap:anywhere] whitespace-pre-wrap" data-snippet="">
			{parts.map((part, index) =>
				part.mark ? (
					<mark key={index} className="rounded-sm bg-ink px-0.5 text-page">
						{part.text}
					</mark>
				) : (
					<span key={index}>{part.text}</span>
				),
			)}
		</span>
	);
}

function hitLink(hit: SearchHit): string {
	return `/s/${encodeURIComponent(hit.sessionId)}?seq=${hit.seq}`;
}

function hitKey(hit: SearchHit): string {
	return `${hit.sessionId}:${hit.seq}:${hit.kind}:${hit.entryId ?? ""}`;
}

function SearchFilters() {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	const facets = useQuery({ queryKey: ["facets"], queryFn: () => api.facets(), staleTime: 60_000 });
	const sort: SearchSort = params.get("sort") === "relevance" ? "relevance" : "newest";
	const group: SearchGroup = params.get("group") === "entry" ? "entry" : "session";
	const set = (key: string, value: string | undefined) => {
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace: true },
		);
	};
	return (
		<div className="flex flex-wrap items-center gap-2" aria-label="Filters">
			{(
				[
					["device", "Device", "device", deviceOptions(facets.data?.devices ?? [])],
					["project", "Project", "folder", plainOptions(facets.data?.projects ?? [])],
				] as const
			).map(([key, title, icon, options]) => (
				<FilterChip key={key} icon={icon} label={title} value={optionLabel(options, params.get(key))}>
					{(close) => (
						<>
							<MenuOption
								selected={!params.get(key)}
								onSelect={() => {
									set(key, undefined);
									close();
								}}
							>
								Any {title.toLowerCase()}
							</MenuOption>
							{options.map((option) => (
								<MenuOption
									key={option.value}
									selected={params.get(key) === option.value}
									onSelect={() => {
										set(key, option.value);
										close();
									}}
								>
									{option.label}
								</MenuOption>
							))}
						</>
					)}
				</FilterChip>
			))}
			<div className="ml-auto flex flex-wrap items-center gap-2">
				<Segmented
					size="sm"
					label="Sort"
					value={sort}
					options={SORT_OPTIONS}
					onChange={(value) => set("sort", value === "relevance" ? "relevance" : undefined)}
				/>
				<Segmented
					size="sm"
					label="Group"
					value={group}
					options={GROUP_OPTIONS}
					onChange={(value) => set("group", value === "entry" ? "entry" : undefined)}
				/>
			</div>
		</div>
	);
}

export function SearchPage() {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	const q = params.get("q") ?? "";
	const device = params.get("device") ?? undefined;
	const project = params.get("project") ?? undefined;
	const sort: SearchSort = params.get("sort") === "relevance" ? "relevance" : "newest";
	const group: SearchGroup = params.get("group") === "entry" ? "entry" : "session";
	const [input, setInput] = useState(q);
	const [syncedQ, setSyncedQ] = useState(q);
	// Follow `q` when it changes from outside the input, e.g. history navigation.
	if (q !== syncedQ) {
		setSyncedQ(q);
		setInput(q);
	}
	const inputRef = useRef<HTMLInputElement>(null);

	useShortcuts({ "/": () => inputRef.current?.focus() });

	// Debounce typing into the `q` URL parameter.
	useEffect(() => {
		if (input === q) return;
		const timer = setTimeout(() => {
			setParams(
				(current) => {
					const next = new URLSearchParams(current);
					if (input.trim()) next.set("q", input);
					else next.delete("q");
					return next;
				},
				{ replace: true },
			);
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [input, q, setParams]);

	// A trailing space stays: it marks the last word finished, so it no longer matches as a prefix.
	const query = q.trimStart();
	const hasQuery = query.trim().length > 0;
	const sortParam = sort === "relevance" ? "relevance" : undefined;

	const sessionResults = useInfiniteQuery({
		queryKey: ["search", "session", query, device, project, sort],
		queryFn: ({ pageParam }) =>
			api.searchSessions({ q: query, device, project, sort: sortParam, cursor: pageParam, limit: SESSION_LIMIT }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		enabled: hasQuery && group === "session",
	});

	const entryResults = useInfiniteQuery({
		queryKey: ["search", "entry", query, device, project, sort],
		queryFn: ({ pageParam }) =>
			api.searchEntries({ q: query, device, project, sort: sortParam, cursor: pageParam, limit: ENTRY_LIMIT }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		enabled: hasQuery && group === "entry",
	});

	const groups = useMemo(() => {
		const pages = sessionResults.data?.pages ?? [];
		const seen = new Set<string>();
		const items: SessionMatches[] = [];
		for (const page of pages) {
			for (const item of page.items) {
				if (seen.has(item.sessionId)) continue;
				seen.add(item.sessionId);
				items.push(item);
			}
		}
		return items;
	}, [sessionResults.data]);

	const entries = useMemo(() => {
		const pages = entryResults.data?.pages ?? [];
		const seen = new Set<string>();
		const items: SearchHit[] = [];
		for (const page of pages) {
			for (const item of page.items) {
				const key = hitKey(item);
				if (seen.has(key)) continue;
				seen.add(key);
				items.push(item);
			}
		}
		return items;
	}, [entryResults.data]);

	const setGroup = (value: SearchGroup) => {
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				if (value === "entry") next.set("group", "entry");
				else next.delete("group");
				return next;
			},
			{ replace: true },
		);
	};

	const active = group === "session" ? sessionResults : entryResults;
	const activeCount = group === "session" ? groups.length : entries.length;

	return (
		<Page className="pb-24">
			<PageTitle>Search</PageTitle>
			<label className="mt-6 flex h-10 items-center gap-2 rounded-sm border border-line px-3 focus-within:border-ink">
				<Icon name="search" className="shrink-0 text-muted" />
				<input
					ref={inputRef}
					type="search"
					value={input}
					autoFocus
					onChange={(event) => setInput(event.target.value)}
					placeholder="Search prompts, answers, and tool calls"
					aria-label="Search"
					className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
				/>
				<kbd className="rounded-sm border border-line px-1 font-sans text-[11px] text-muted">/</kbd>
			</label>
			<div className="mt-3">
				<SearchFilters />
			</div>
			<hr className="mt-5 mb-1 border-0 border-t border-ink" />
			{!hasQuery ? (
				<EmptyState title={api.publicView ? "Search published trajectories" : "Search every session"}>
					Type to search prompts, answers, tool calls, results, and titles.
				</EmptyState>
			) : active.isPending ? (
				<div className="py-3">
					<SkeletonLines lines={4} />
				</div>
			) : active.isError && activeCount === 0 ? (
				<ErrorState error={active.error} onRetry={() => void active.refetch()} />
			) : activeCount === 0 ? (
				<EmptyState title="No results">Nothing matches “{query.trim()}”.</EmptyState>
			) : group === "session" ? (
				<div data-search-results="">
					{groups.map((item) => (
						<section key={item.sessionId} className="mt-5 first:mt-2" data-result-group={item.sessionId}>
							<Link
								to={`/s/${encodeURIComponent(item.sessionId)}`}
								className="flex min-w-0 items-baseline gap-2 border-b border-line px-1.5 pb-1 text-[14px] hover:bg-hover"
							>
								<span className="min-w-0 truncate font-medium">{item.sessionTitle || "Untitled session"}</span>
								<span className="mono shrink-0 text-[11.5px] text-muted" aria-hidden="true">
									{item.sessionId.slice(0, 8)}
								</span>
								<span className="tnum ml-auto shrink-0 text-[12px] text-muted" data-matches="">
									{item.matches} {item.matches === 1 ? "match" : "matches"}
								</span>
							</Link>
							<div>
								{item.hits.map((hit) => {
									const kind = KINDS[hit.kind] ?? KINDS.assistant;
									return (
										<Link
											key={hitKey(hit)}
											to={hitLink(hit)}
											className="flex gap-3 border-b border-line px-1.5 py-1 text-[13px] leading-5 hover:bg-hover"
											data-hit={hit.seq}
											data-kind={hit.kind}
										>
											<Icon name={kind.icon} className="mt-[3px] shrink-0 text-muted" />
											<span className="sr-only">{kind.label}</span>
											<span className="min-w-0 flex-1">
												<Snippet text={hit.snippet} />
											</span>
											<span className="tnum shrink-0 text-[12px] text-muted">{formatRelative(hit.at)}</span>
										</Link>
									);
								})}
							</div>
						</section>
					))}
					{sessionResults.isFetchNextPageError && (
						<ErrorState error={sessionResults.error} onRetry={() => void sessionResults.fetchNextPage()} />
					)}
					{sessionResults.hasNextPage ? (
						<button
							type="button"
							disabled={sessionResults.isFetchingNextPage}
							onClick={() => void sessionResults.fetchNextPage()}
							className={cx(BUTTON.secondary, "mt-4")}
						>
							{sessionResults.isFetchingNextPage ? "Loading…" : "Load more"}
						</button>
					) : (
						groups.length === SESSION_LIMIT && (
							<p className="mt-4 px-1.5 text-[12px] text-muted">
								Showing the {SESSION_LIMIT} most {sort === "relevance" ? "relevant" : "recent"} sessions. Add words or a filter to narrow the search
								{sort === "newest" && (
									<>
										, or{" "}
										<button
											type="button"
											onClick={() => setGroup("entry")}
											className="underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink"
										>
											view all matches
										</button>
									</>
								)}
								.
							</p>
						)
					)}
				</div>
			) : (
				<div data-search-results="" data-result-view="entry">
					{entries.map((hit) => {
						const kind = KINDS[hit.kind] ?? KINDS.assistant;
						return (
							<Link
								key={hitKey(hit)}
								to={hitLink(hit)}
								className="flex gap-3 border-b border-line px-1.5 py-1.5 text-[13px] leading-5 hover:bg-hover"
								data-result-entry={`${hit.sessionId}:${hit.seq}`}
								data-hit={hit.seq}
								data-kind={hit.kind}
							>
								<Icon name={kind.icon} className="mt-[3px] shrink-0 text-muted" />
								<span className="sr-only">{kind.label}</span>
								<span className="min-w-0 flex-1">
									<span className="flex min-w-0 items-baseline gap-2">
										<span className="min-w-0 truncate font-medium text-ink">{hit.sessionTitle || "Untitled session"}</span>
										<span className="mono shrink-0 text-[11.5px] text-muted" aria-hidden="true">
											{hit.sessionId.slice(0, 8)}
										</span>
									</span>
									<span className="mt-0.5 block">
										<Snippet text={hit.snippet} />
									</span>
								</span>
								<span className="tnum shrink-0 text-[12px] text-muted">{formatRelative(hit.at)}</span>
							</Link>
						);
					})}
					{entryResults.isFetchNextPageError && (
						<ErrorState error={entryResults.error} onRetry={() => void entryResults.fetchNextPage()} />
					)}
					{entryResults.hasNextPage ? (
						<button
							type="button"
							disabled={entryResults.isFetchingNextPage}
							onClick={() => void entryResults.fetchNextPage()}
							className={cx(BUTTON.secondary, "mt-4")}
						>
							{entryResults.isFetchingNextPage ? "Loading…" : "Load more"}
						</button>
					) : (
						sort === "relevance" &&
						entries.length === ENTRY_LIMIT && (
							<p className="mt-4 px-1.5 text-[12px] text-muted">
								Showing the {ENTRY_LIMIT} most relevant matches. Add words or a filter to narrow the search.
							</p>
						)
					)}
				</div>
			)}
		</Page>
	);
}
