import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { PikaLink as Link } from "../components/PikaLink";
import { FilterChip, MenuOption, optionLabel, plainOptions, type FilterOption } from "../components/FilterChip";
import { Icon, PikaLogo } from "../components/icons";
import { useScrollRoot } from "../components/Layout";
import { cx, EmptyState, ErrorState, Page, PageTitle, Skeleton } from "../components/ui";
import { ApiError, useApi, type SessionFilters } from "../lib/api";
import { deviceLabel, deviceOptions } from "../lib/devices";
import { colorOf, modelColor, Tag } from "../components/Tag";
import { formatCost, formatCount, formatDateTime, formatDuration, formatRelative, plural, totalTokens } from "../lib/format";
import { isLive } from "../lib/liveness";
import type { SessionSummary, Tokens } from "../lib/types";
import { useScrollMargin } from "../lib/virtual";
import { useFamily } from "../tree/data";
import { continuesAt, defaultExpanded, visibleRows, type FamilyNode } from "../tree/model";
import { Caret, KindIcon, KindPill, sessionLabel, TreeLines, TreeStub } from "../tree/parts";

const PAGE_SIZE = 50;
/** A family up to this size opens fully under its session; a larger one shows its direct children. */
const OPEN_FAMILY_LIMIT = 12;
/** A family lists this many rows until the reader asks for the rest. */
const FAMILY_ROWS = 12;
/** A live family refetches this often here: the list may show many families, each a few rows of its tree. */
const FAMILY_REFRESH_MS = 30_000;
/**
 * A family that scrolls away stays cached this long, so it comes back at its size instead of as a skeleton.
 * The anonymous client caches nothing by default; it still revalidates the family as it comes back.
 */
const FAMILY_GC_MS = 60_000;
/** How far below a card's top its title line sits, past its border: its caret and its branch meet there. */
const CARD_ELBOW = 17;
/** A branch ends at its card's caret, or past a leaf's empty caret column, at its card's border. */
const CARET_REACH = 2;
const LEAF_REACH = 18;

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
		// Subagents and steps show inside their session's family, never as rows of their own.
		root: true,
	};
}

interface CardProps {
	session: SessionSummary;
	/** Levels below the top of the list. */
	depth?: number;
	/** A nested card's lines, from `continuesAt`. */
	lines?: boolean[];
	/** A nested card's parent, whose project and device the card need not repeat. */
	parent?: SessionSummary;
	/** Whether the list shows the tree: every card says what it is and has room for a caret. */
	tree: boolean;
	/** The caret of a card whose children the tree lists. */
	toggle?: { open: boolean; onToggle: () => void };
	/** With the tree, the cost and size of the card's session together with every session below it. */
	subtree?: { cost: number; sessions: number };
}

const TOKEN_PARTS: [keyof Tokens, string, string][] = [
	["cacheRead", "cache read", "bg-k-read"],
	["cacheWrite", "cache write", "bg-k-compaction"],
	["input", "input", "bg-k-user"],
	["output", "output", "bg-k-llm"],
];

/** Tokens, with a small bar of their kinds: what the prompt cache served, what was new, and what the model wrote. */
function TokenMeter({ tokens }: { tokens: Tokens }) {
	const total = totalTokens(tokens);
	const breakdown = TOKEN_PARTS.map(([key, label]) => `${tokens[key].toLocaleString("en-US")} ${label}`).join(" · ");
	return (
		<span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted" title={breakdown}>
			<Icon name="tokens" size={11} className="opacity-70" />
			<span>{formatCount(total)} tokens</span>
			{total > 0 && (
				<span className="flex h-[5px] w-9 overflow-hidden rounded-full bg-hover" aria-hidden="true">
					{TOKEN_PARTS.map(([key, , color]) =>
						tokens[key] ? <span key={key} className={cx(color, "opacity-80")} style={{ width: `${(tokens[key] / total) * 100}%` }} /> : null,
					)}
				</span>
			)}
		</span>
	);
}

/** The share of the prompt the cache served: the more, the cheaper each call. */
function cacheShare(tokens: Tokens): number | undefined {
	const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	return prompt > 0 && tokens.cacheRead > 0 ? tokens.cacheRead / prompt : undefined;
}

/**
 * A session's card, the same at every level of the list: its page icon, title, and status; how long it ran, what it
 * cost, and when; and its properties as Notion-style tags. At the top it is a main session, or a child whose parent pika
 * has not recorded; below, a subagent or step under its parent.
 */
function SessionCard({ session, depth = 0, lines, parent, tree, toggle, subtree }: CardProps) {
	const nested = depth > 0;
	// Public summaries leave out unpublished parents, so a published child reads as a main session there.
	const orphan = !nested && Boolean(session.parentSessionId);
	const { kind, type, description: title } = sessionLabel(session, !nested && !orphan);
	const herder = session.link?.herder;
	const cached = cacheShare(session.tokens);
	const card = (
		<Link
			to={`/s/${encodeURIComponent(session.id)}`}
			className="block min-w-0 flex-1 rounded-lg border border-line bg-page px-3 py-1.5 transition-[background-color,box-shadow] duration-150 hover:bg-soft hover:shadow-[0_1px_4px_rgba(15,15,15,0.08)]"
			title={session.title && session.title !== title ? session.title : undefined}
			data-session-row={nested ? undefined : session.id}
		>
			<div className="flex min-w-0 items-center gap-2 text-[14px] leading-5">
				<KindIcon kind={kind} type={type} />
				<span className="min-w-0 truncate font-medium">{title}</span>
				{isLive(session.lastAt) && (
					<span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-green" data-live="">
						<span className="relative flex size-1.5">
							<span className="absolute inline-flex size-full animate-ping rounded-full bg-green opacity-60" />
							<span className="relative inline-flex size-1.5 rounded-full bg-green" />
						</span>
						Live
					</span>
				)}
				{/* Fixed widths, so the numbers line up down the list. */}
				<span className="tnum ml-auto flex shrink-0 items-center gap-3 pl-3 text-[12.5px] text-muted">
					<span className="flex w-[70px] items-center justify-end gap-1" title="Duration">
						<Icon name="clock" size={12} className="shrink-0 opacity-60" />
						{formatDuration(session.durationMs)}
					</span>
					<span className="flex w-[66px] items-center justify-end gap-1 font-medium text-ink/80" title="Cost">
						<Icon name="coins" size={12} className="shrink-0 text-muted opacity-60" />
						{formatCost(session.cost)}
					</span>
					<span className="flex w-[114px] items-center justify-end gap-1" title={formatDateTime(session.startedAt)}>
						<Icon name="calendar" size={12} className="shrink-0 opacity-60" />
						{formatRelative(session.startedAt)}
					</span>
				</span>
			</div>
			<div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 pl-7">
				{(tree || orphan) && <KindPill kind={kind}>{type}</KindPill>}
				{orphan && (
					<span data-parent-missing="">
						<Tag color="yellow" icon="alert" title="pika has no record of the session that started this one: it was not uploaded, or not yet">
							parent not recorded
						</Tag>
					</span>
				)}
				{herder?.task && (
					<Tag icon="tag" title="Herder task">
						{herder.task}
					</Tag>
				)}
				{herder && herder.attempt > 1 && (
					<Tag color="yellow" title="Herder ran this step again after an earlier attempt">
						attempt {herder.attempt}
					</Tag>
				)}
				{session.link?.workflowId && (
					<Tag icon="branch" title={`Workflow ${session.link.workflowId}`}>
						workflow
					</Tag>
				)}
				{/* Below the top, a card leaves out where it ran when that is where its parent ran. */}
				{(!parent || session.project !== parent.project) && (
					<Tag color={colorOf(session.project || "—")} icon="folder" title={session.cwd}>
						{session.project || "—"}
					</Tag>
				)}
				{(!parent || session.device !== parent.device) && (
					<Tag icon="device" title={session.device}>
						<span data-device-label={session.device}>{deviceLabel(session)}</span>
					</Tag>
				)}
				{session.models.slice(0, 2).map((model) => (
					<Tag key={model} color={modelColor(model)} icon="model">
						{model}
					</Tag>
				))}
				{session.models.length > 2 && <Tag title={session.models.slice(2).join(", ")}>+{session.models.length - 2}</Tag>}
				{session.childCount > 0 && (
					<Tag icon="children" title="Child sessions">
						{plural(session.childCount, "subagent")}
					</Tag>
				)}
				{subtree && (
					<Tag title="The cost of this session and every session below it">
						{`Σ ${formatCost(subtree.cost)} · ${plural(subtree.sessions, "session")}`}
					</Tag>
				)}
				<span className="ml-1 flex items-center gap-3">
					<TokenMeter tokens={session.tokens} />
					{cached !== undefined && (
						<span className="flex items-center gap-1 text-[11.5px] text-muted" title="The share of the prompt tokens the prompt cache served">
							<Icon name="compress" size={11} className="opacity-70" />
							{Math.round(cached * 100)}% cached
						</span>
					)}
				</span>
			</div>
		</Link>
	);
	if (!tree) return card;
	return (
		<div className="flex min-w-0">
			{lines && <TreeLines continues={lines} elbow={CARD_ELBOW} reach={toggle ? CARET_REACH : LEAF_REACH} />}
			{/* The caret sits in line with the title; an open card's line runs from it down to its first child. */}
			<span className="relative flex w-[18px] shrink-0 justify-center self-stretch pt-[8px]">
				{toggle && <Caret open={toggle.open} onClick={toggle.onToggle} label={title} focusable />}
				{toggle?.open && <TreeStub from={CARD_ELBOW + 7} />}
			</span>
			{/* The gap below the card belongs to the row, so its lines and caret column run through it to the next card. */}
			<div className="min-w-0 flex-1 pb-1.5">{card}</div>
		</div>
	);
}

interface FamilyProps {
	root: SessionSummary;
	/** The sessions whose children show, once the reader opened or closed one; until then it follows the family's size. */
	expanded?: string[];
	onExpand: (expanded: string[]) => void;
	full: boolean;
	onFull: () => void;
}

/** A session's card, with its subagents and steps as a tree of cards under it. */
function FamilyCards({ root, expanded, onExpand, full, onFull }: FamilyProps) {
	const { tree, family } = useFamily(root.id, { refreshMs: FAMILY_REFRESH_MS, gcTime: FAMILY_GC_MS });
	// The opening the family first had stays, so a live family does not fold up as it grows past the limit.
	useEffect(() => {
		if (family && !expanded) onExpand([...defaultExpanded(family, family.rootId, OPEN_FAMILY_LIMIT)]);
	}, [family, expanded, onExpand]);
	// Under the first level's caret, in line with the nested cards' text.
	const note = "flex min-h-7 items-center gap-2 pl-[46px] text-[12.5px] text-muted";
	if (!family) {
		const status =
			tree.error instanceof ApiError && tree.error.status === 404 ? (
				<div className={note} data-family-missing="">
					This server does not list subagents by family yet.
				</div>
			) : tree.isError ? (
				<div className={note}>
					The subagents could not be loaded.
					<button type="button" onClick={() => void tree.refetch()} className="rounded-sm px-1 hover:bg-hover hover:text-ink">
						Try again
					</button>
				</div>
			) : (
				<div className="pb-2 pl-[46px]" aria-busy="true" aria-label="Loading subagents">
					{Array.from({ length: Math.min(root.childCount, 3) }, (_, i) => (
						<Skeleton key={i} className="my-3 h-4 w-1/2" />
					))}
				</div>
			);
		return (
			<>
				<SessionCard session={root} tree />
				{status}
			</>
		);
	}
	const open = expanded ? new Set(expanded) : defaultExpanded(family, family.rootId, OPEN_FAMILY_LIMIT);
	const toggle = (id: string) => {
		const next = new Set(open);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		onExpand([...next]);
	};
	const caret = (node: FamilyNode | undefined) => (node && node.children.length > 0 ? { open: open.has(node.id), onToggle: () => toggle(node.id) } : undefined);
	const subtree = (node: FamilyNode | undefined) => (node && node.descendants > 0 ? { cost: node.subtreeCost, sessions: node.descendants + 1 } : undefined);
	const top = family.byId.get(family.rootId);
	const rows = visibleRows(family, open).filter((node) => node.depth > 0);
	const shown = full ? rows : rows.slice(0, FAMILY_ROWS);
	const button = "rounded-sm px-1 hover:bg-hover hover:text-ink";
	return (
		<>
			<SessionCard session={root} tree toggle={caret(top)} subtree={subtree(top)} />
			{rows.length > 0 && (
				<ul aria-label={`Subagents of ${root.title || "Untitled session"}`} data-family={root.id}>
					{shown.map((node) => (
						<li key={node.id} data-family-node={node.id} data-depth={node.depth}>
							<SessionCard
								session={node.session}
								depth={node.depth}
								lines={continuesAt(family, node)}
								parent={node.parentId ? family.byId.get(node.parentId)?.session : undefined}
								tree
								toggle={caret(node)}
								subtree={subtree(node)}
							/>
						</li>
					))}
					{rows.length > shown.length && (
						<li className={note}>
							<button type="button" onClick={onFull} className={button} data-family-more="">
								Show {rows.length - shown.length} more
							</button>
							<span aria-hidden="true">·</span>
							<Link to={`/s/${encodeURIComponent(root.id)}?view=agents`} className={button} data-family-tree-link="">
								Open the agent tree
							</Link>
						</li>
					)}
				</ul>
			)}
		</>
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

	const facet = (key: "device" | "project" | "model", label: string, icon: "device" | "folder" | "model", options: FilterOption[]) => (
		<FilterChip key={key} icon={icon} label={label} value={optionLabel(options, params.get(key))}>
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
			{facet("device", "Device", "device", deviceOptions(facets.data?.devices ?? []))}
			{facet("project", "Project", "folder", plainOptions(facets.data?.projects ?? []))}
			{facet("model", "Model", "model", plainOptions(facets.data?.models ?? []))}
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
				Show subagents and steps
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
	const showFamilies = params.get("children") === "1";
	// Per family, kept here because the list unmounts rows that scroll away.
	const [expanded, setExpanded] = useState<Record<string, string[]>>({});
	const [full, setFull] = useState<Record<string, boolean>>({});

	const scrollRoot = useScrollRoot();
	const listRef = useRef<HTMLDivElement>(null);
	const scrollMargin = useScrollMargin(listRef, scrollRoot);
	const count = items.length + (sessions.hasNextPage ? 1 : 0);
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollRoot,
		estimateSize: () => 48,
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
			<PageTitle>{api.publicView ? "Published trajectories" : "Sessions"}</PageTitle>
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
					{api.publicView ? "No projects have been published yet." : <>Run <code className="code-chip">/pika login</code> in pi on each machine. Sessions appear here as they run.</>}
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
								{session ? (
									// The space around a session is part of its measured row. With the tree, a divider sets each
									// session and its subagents apart from the one above.
									<div
										className={showFamilies ? cx("pb-3.5", row.index > 0 && "border-t border-line pt-4") : "pb-1.5"}
										data-family-divider={showFamilies && row.index > 0 ? "" : undefined}
									>
										{showFamilies && session.childCount > 0 ? (
											<FamilyCards
												root={session}
												expanded={expanded[session.id]}
												onExpand={(ids) => setExpanded((all) => ({ ...all, [session.id]: ids }))}
												full={full[session.id] ?? false}
												onFull={() => setFull((all) => ({ ...all, [session.id]: true }))}
											/>
										) : (
											<SessionCard session={session} tree={showFamilies} />
										)}
									</div>
								) : (
									<RowSkeleton />
								)}
							</div>
						);
					})}
				</div>
			)}
			{sessions.isFetchNextPageError && <ErrorState error={sessions.error} onRetry={() => void sessions.fetchNextPage()} />}
		</Page>
	);
}
