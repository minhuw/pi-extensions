import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { FilterChip, MenuOption } from "../components/FilterChip";
import { Icon, type IconName } from "../components/icons";
import { EmptyState, ErrorState, PageTitle, SkeletonLines } from "../components/ui";
import { useApi } from "../lib/api";
import { formatRelative } from "../lib/format";
import { useShortcuts } from "../lib/keyboard";
import { parseSnippet } from "../lib/snippet";
import type { SearchHit } from "../lib/types";

export const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;

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
					<mark key={index} className="rounded-sm bg-yellow-soft px-0.5 text-ink">
						{part.text}
					</mark>
				) : (
					<span key={index}>{part.text}</span>
				),
			)}
		</span>
	);
}

export interface HitGroup {
	sessionId: string;
	title: string;
	hits: SearchHit[];
}

/** Groups hits by session, in the order each session first appears. */
export function groupHits(hits: SearchHit[]): HitGroup[] {
	const groups = new Map<string, HitGroup>();
	for (const hit of hits) {
		let group = groups.get(hit.sessionId);
		if (!group) {
			group = { sessionId: hit.sessionId, title: hit.sessionTitle, hits: [] };
			groups.set(hit.sessionId, group);
		}
		group.hits.push(hit);
	}
	return [...groups.values()];
}

function hitLink(hit: SearchHit): string {
	return `/s/${encodeURIComponent(hit.sessionId)}?seq=${hit.seq}`;
}

function SearchFilters() {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	const facets = useQuery({ queryKey: ["facets"], queryFn: () => api.facets(), staleTime: 60_000 });
	const set = (key: string, value: string | undefined) => {
		const next = new URLSearchParams(params);
		if (value) next.set(key, value);
		else next.delete(key);
		setParams(next, { replace: true });
	};
	return (
		<div className="flex flex-wrap items-center gap-2" aria-label="Filters">
			{(
				[
					["device", "Device", "device", facets.data?.devices ?? []],
					["project", "Project", "folder", facets.data?.projects ?? []],
				] as const
			).map(([key, title, icon, options]) => (
				<FilterChip key={key} icon={icon} label={title} value={params.get(key) ?? undefined}>
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
						</>
					)}
				</FilterChip>
			))}
		</div>
	);
}

export function SearchPage() {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	const q = params.get("q") ?? "";
	const device = params.get("device") ?? undefined;
	const project = params.get("project") ?? undefined;
	const [input, setInput] = useState(q);
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

	const query = q.trim();
	const results = useInfiniteQuery({
		queryKey: ["search", query, device, project],
		queryFn: ({ pageParam }) => api.search({ q: query, device, project, cursor: pageParam, limit: PAGE_SIZE }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled: query.length > 0,
	});
	const groups = useMemo(() => groupHits(results.data?.pages.flatMap((page) => page.items) ?? []), [results.data]);

	return (
		<div className="mx-auto w-full max-w-[900px] px-12 pt-16 pb-24">
			<PageTitle>Search</PageTitle>
			<label className="mt-6 flex h-10 items-center gap-2 rounded-md border border-line px-3 focus-within:border-accent/50">
				<Icon name="search" className="shrink-0 text-muted" />
				<input
					ref={inputRef}
					type="search"
					value={input}
					autoFocus
					onChange={(event) => setInput(event.target.value)}
					placeholder="Search prompts, answers, and tool calls"
					aria-label="Search"
					className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
				/>
				<kbd className="mono rounded-sm border border-line px-1 text-[11px] text-muted">/</kbd>
			</label>
			<div className="mt-3">
				<SearchFilters />
			</div>
			<hr className="mt-4 mb-2 border-0 border-t border-line" />
			{!query ? (
				<EmptyState title="Search every session">Type to search prompts, answers, tool calls, results, and titles.</EmptyState>
			) : results.isPending ? (
				<div className="py-3">
					<SkeletonLines lines={4} />
				</div>
			) : results.isError && groups.length === 0 ? (
				<ErrorState error={results.error} onRetry={() => void results.refetch()} />
			) : groups.length === 0 ? (
				<EmptyState title="No results">Nothing matches “{query}”.</EmptyState>
			) : (
				<div data-search-results="">
					{groups.map((group) => (
						<section key={group.sessionId} className="mt-4" data-result-group={group.sessionId}>
							<Link
								to={`/s/${encodeURIComponent(group.sessionId)}`}
								className="-mx-1 block truncate rounded-sm px-1 font-medium hover:bg-hover"
							>
								{group.title || "Untitled session"}
							</Link>
							<div className="mt-1">
								{group.hits.map((hit) => {
									const kind = KINDS[hit.kind] ?? KINDS.assistant;
									return (
										<Link
											key={`${hit.seq}:${hit.kind}:${hit.entryId ?? ""}`}
											to={hitLink(hit)}
											className="flex gap-3 rounded-md px-2 py-1.5 text-[14px] hover:bg-hover"
											data-hit={hit.seq}
											data-kind={hit.kind}
										>
											<Icon name={kind.icon} className="mt-1 shrink-0 text-muted" />
											<span className="sr-only">{kind.label}</span>
											<span className="min-w-0 flex-1">
												<Snippet text={hit.snippet} />
											</span>
											<span className="shrink-0 text-[12px] text-muted">{formatRelative(hit.at)}</span>
										</Link>
									);
								})}
							</div>
						</section>
					))}
					{results.hasNextPage && (
						<button
							type="button"
							disabled={results.isFetchingNextPage}
							onClick={() => void results.fetchNextPage()}
							className="mt-4 rounded-sm px-3 py-1 text-[14px] text-muted hover:bg-hover"
						>
							{results.isFetchingNextPage ? "Loading…" : "More results"}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
