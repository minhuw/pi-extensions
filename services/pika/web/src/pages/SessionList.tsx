import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { PikaLink as Link } from "../components/PikaLink";
import { FilterChip, MenuOption, optionLabel, plainOptions, type FilterOption } from "../components/FilterChip";
import { PikaLogo } from "../components/icons";
import { useScrollRoot } from "../components/Layout";
import { cx, EmptyState, ErrorState, Page, PageTitle, Pill, Skeleton } from "../components/ui";
import { ApiError, useApi, type SessionFilters } from "../lib/api";
import { deviceLabel, deviceOptions } from "../lib/devices";
import { Tag } from "../components/Tag";
import { formatCost, formatCount, formatDateTime, formatDuration, formatRelative, plural, totalTokens } from "../lib/format";
import { isLive } from "../lib/liveness";
import type { SessionSummary, Tokens } from "../lib/types";
import { useScrollMargin } from "../lib/virtual";
import { useFamily } from "../tree/data";
import { continuesAt, defaultExpanded, visibleRows, type FamilyNode } from "../tree/model";
import { CostDot } from "../trace/parts";
import { Caret, KindIcon, KindPill, lineTones, sessionLabel, TreeLines, TreeStub, type LineTone } from "../tree/parts";

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
/** How far below a row's top its title line's middle sits: its caret and its branch meet there. */
const CARD_ELBOW = 16;
/** A branch ends at its row's caret, or past a leaf's empty caret column, at its row's left edge. */
const CARET_REACH = 2;
const LEAF_REACH = 18;
/**
 * The list's columns: the name plate, then tokens, cost, duration, and start, at fixed widths on the right so they line
 * up down the list at any depth of the tree. Narrow screens drop tokens and duration.
 */
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_88px_76px] gap-x-4 md:grid-cols-[minmax(0,1fr)_128px_88px_64px_104px]";
const WIDE = "max-md:hidden";
/** The project and device shortcuts list this many of each. */
const BROWSE_ITEMS = 8;

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
	/** A nested card's lines, from `continuesAt`, and their tones, from `lineTones`. */
	lines?: boolean[];
	tones?: { trunks: LineTone[]; own: LineTone };
	/** A nested card's parent, whose project and device the card need not repeat. */
	parent?: SessionSummary;
	/** Whether the list shows the tree: every card says what it is and has room for a caret. */
	tree: boolean;
	/** The caret of a card whose children the tree lists. */
	toggle?: { open: boolean; onToggle: () => void; stub: LineTone };
	/** With the tree, the cost and size of the card's session together with every session below it. */
	subtree?: { cost: number; sessions: number };
}

/** Token kinds as ink steps, lightest to darkest: what the prompt cache served, what was new, and what the model wrote. */
const TOKEN_PARTS: [keyof Tokens, string, string][] = [
	["cacheRead", "cache read", "bg-ink/20"],
	["cacheWrite", "cache write", "bg-ink/45"],
	["input", "input", "bg-ink/70"],
	["output", "output", "bg-ink"],
];

/** Tokens, with a small bar of their kinds, and the share the cache served under them. */
function TokenMeter({ tokens }: { tokens: Tokens }) {
	const total = totalTokens(tokens);
	const breakdown = TOKEN_PARTS.map(([key, label]) => `${tokens[key].toLocaleString("en-US")} ${label}`).join(" · ");
	const cached = cacheShare(tokens);
	return (
		<span className={cx("flex min-w-0 flex-col items-end gap-0.5", WIDE)}>
			<span className="flex items-center gap-1.5" title={breakdown}>
				<span className="tnum whitespace-nowrap">{formatCount(total)} tokens</span>
				{total > 0 && (
					<span className="flex h-[5px] w-8 overflow-hidden bg-hover" aria-hidden="true">
						{TOKEN_PARTS.map(([key, , color]) => (tokens[key] ? <span key={key} className={color} style={{ width: `${(tokens[key] / total) * 100}%` }} /> : null))}
					</span>
				)}
			</span>
			{cached !== undefined && (
				<span className="tnum text-[11.5px] whitespace-nowrap text-muted" title="The share of the prompt tokens the prompt cache served">
					{Math.round(cached * 100)}% cached
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

/** Context in the name plate's second line: muted text, separated by thin gaps. */
function Context({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
	return (
		<span className={cx("min-w-0 shrink truncate", className)} title={title}>
			{children}
		</span>
	);
}

/**
 * A session's row, the same at every level of the list: a name plate (its title, short id, and state; then where it
 * ran and with which models), and its tokens, cost, duration, and start in aligned columns. At the top it is a main
 * session, or a child whose parent pika has not recorded; below, a subagent or step under its parent.
 */
function SessionCard({ session, depth = 0, lines, tones, parent, tree, toggle, subtree }: CardProps) {
	const nested = depth > 0;
	// Public summaries leave out unpublished parents, so a published child reads as a main session there.
	const orphan = !nested && Boolean(session.parentSessionId);
	const { kind, type, description: title } = sessionLabel(session, !nested && !orphan);
	const herder = session.link?.herder;
	const showProject = !parent || session.project !== parent.project;
	const showDevice = !parent || session.device !== parent.device;
	const card = (
		<Link
			to={`/s/${encodeURIComponent(session.id)}`}
			className={cx(COLUMNS, "min-w-0 flex-1 items-start py-1.5 pr-2 pl-1.5 text-[13px] leading-5 hover:bg-hover")}
			title={session.title && session.title !== title ? session.title : undefined}
			data-session-row={nested ? undefined : session.id}
		>
			<span className="flex min-w-0 flex-col">
				<span className="flex min-w-0 items-center gap-2">
					{tree && <KindIcon kind={kind} />}
					<span className="min-w-0 text-[13.5px] font-medium text-ink max-md:line-clamp-2 max-md:[overflow-wrap:anywhere] md:truncate">{title}</span>
					<span className="mono shrink-0 text-[11.5px] leading-5 text-muted max-md:hidden">{session.id.slice(0, 8)}</span>
					{isLive(session.lastAt) && (
						<span className="flex shrink-0" data-live="">
							<Pill tone="green">Live</Pill>
						</span>
					)}
					{(tree || orphan) && <KindPill kind={kind}>{type}</KindPill>}
					{orphan && (
						<span className="flex shrink-0" data-parent-missing="">
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
				</span>
				<span className={cx("flex min-w-0 items-center gap-x-3 text-[12px] text-muted", tree && "pl-6")}>
					{/* Below the top, a row leaves out where it ran when that is where its parent ran. */}
					{showProject && (
						<Context title={session.cwd} className="text-ink/80">
							{session.project || "—"}
						</Context>
					)}
					{showDevice && (
						<Context title={session.device}>
							<span data-device-label={session.device}>{deviceLabel(session)}</span>
						</Context>
					)}
					{session.models.slice(0, 2).map((model) => (
						<Context key={model} className="mono text-[11.5px]">
							{model}
						</Context>
					))}
					{session.models.length > 2 && <Context title={session.models.slice(2).join(", ")}>+{session.models.length - 2}</Context>}
					{session.childCount > 0 && (
						<span className="shrink-0" title="Child sessions">
							{plural(session.childCount, "subagent")}
						</span>
					)}
					{subtree && (
						<span className="tnum shrink-0" title="The cost of this session and every session below it">
							{`Σ ${formatCost(subtree.cost)} · ${plural(subtree.sessions, "session")}`}
						</span>
					)}
				</span>
			</span>
			<TokenMeter tokens={session.tokens} />
			<span className="flex items-center justify-end gap-1.5" title="Cost">
				<CostDot cost={session.cost} scale="session" />
				<span className="tnum font-medium">{formatCost(session.cost)}</span>
			</span>
			<span className={cx("tnum text-right text-muted", WIDE)} title="Duration">
				{formatDuration(session.durationMs)}
			</span>
			<span className="tnum truncate text-right text-muted" title={formatDateTime(session.startedAt)}>
				{formatRelative(session.startedAt)}
			</span>
		</Link>
	);
	if (!tree) return card;
	return (
		<div className="flex min-w-0">
			{lines && tones && <TreeLines continues={lines} elbow={CARD_ELBOW} reach={toggle ? CARET_REACH : LEAF_REACH} tones={tones} />}
			{/* The caret sits in line with the title; an open row's line runs from it down to its first child. */}
			<span className="relative flex w-[18px] shrink-0 justify-center self-stretch pt-[7px]">
				{toggle && <Caret open={toggle.open} onClick={toggle.onToggle} label={title} focusable />}
				{toggle?.open && <TreeStub from={CARD_ELBOW + 7} tone={toggle.stub} />}
			</span>
			{card}
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
	// Under the first level's caret, in line with the nested rows' text.
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
					<button type="button" onClick={() => void tree.refetch()} className="rounded-sm px-1 text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink">
						Try again
					</button>
				</div>
			) : (
				<div className="pb-2 pl-[46px]" aria-busy="true" aria-label="Loading subagents">
					{Array.from({ length: Math.min(root.childCount, 3) }, (_, i) => (
						<Skeleton key={i} className="my-2 h-4 w-1/2" />
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
	const caret = (node: FamilyNode | undefined) =>
		node && node.children.length > 0 ? { open: open.has(node.id), onToggle: () => toggle(node.id), stub: lineTones(family, node).stub } : undefined;
	const subtree = (node: FamilyNode | undefined) => (node && node.descendants > 0 ? { cost: node.subtreeCost, sessions: node.descendants + 1 } : undefined);
	const top = family.byId.get(family.rootId);
	const rows = visibleRows(family, open).filter((node) => node.depth > 0);
	const shown = full ? rows : rows.slice(0, FAMILY_ROWS);
	const button = "rounded-sm px-1 text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink";
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
								tones={lineTones(family, node)}
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
		<div className="border-b border-line px-1.5 py-2">
			<Skeleton className="h-4 w-1/2" />
			<Skeleton className="mt-1.5 h-3 w-1/3" />
		</div>
	);
}

/** The project and device shortcuts the sidebar used to list: each links to the list filtered by it. */
function BrowseSection({ title, items, param }: { title: string; items: FilterOption[]; param: string }) {
	const [params] = useSearchParams();
	if (items.length === 0) return null;
	return (
		<section className="min-w-0">
			<h2 className="border-b border-ink pb-1 text-[13px] font-semibold">{title}</h2>
			<ul className="mt-0.5">
				{items.slice(0, BROWSE_ITEMS).map((item) => {
					const current = params.get(param) === item.value;
					return (
						<li key={item.value}>
							<Link
								to={`/?${param}=${encodeURIComponent(item.value)}`}
								className={cx("flex h-7 min-w-0 items-center rounded-sm px-1.5 text-[13px] text-ink hover:bg-hover", current && "bg-hover font-medium")}
								title={item.label}
								aria-current={current ? "true" : undefined}
							>
								<span className="truncate">{item.label}</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** The owner's index of projects and devices: a column left of the list on wide screens, above it on narrow ones. */
function BrowseIndex() {
	const api = useApi();
	const facets = useQuery({ queryKey: ["facets"], queryFn: () => api.facets(), staleTime: 60_000 });
	return (
		<nav aria-label="Browse" className="grid grid-cols-2 max-md:hidden gap-x-8 gap-y-5 max-[1099px]:mb-6 min-[1100px]:grid-cols-1 min-[1100px]:content-start" data-browse="">
			<BrowseSection title="Projects" items={plainOptions(facets.data?.projects ?? [])} param="project" />
			<BrowseSection title="Devices" items={deviceOptions(facets.data?.devices ?? [])} param="device" />
		</nav>
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
								className="h-7 rounded-sm border border-line bg-page px-1.5 focus:border-ink focus:outline-none"
							/>
						</label>
						<label className="flex items-center justify-between gap-3">
							<span className="text-muted">To</span>
							<input
								type="date"
								value={to}
								min={from || undefined}
								onChange={(event) => set("to", event.target.value || undefined)}
								className="h-7 rounded-sm border border-line bg-page px-1.5 focus:border-ink focus:outline-none"
							/>
						</label>
					</div>
				)}
			</FilterChip>
			<label className="ml-1 flex h-7 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-[13px] text-ink hover:bg-hover">
				<input
					type="checkbox"
					checked={includeChildren}
					onChange={(event) => set("children", event.target.checked ? "1" : undefined)}
					className="accent-ink"
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
					className="h-7 rounded-sm px-1.5 text-[13px] text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink"
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

	const list = sessions.isPending ? (
		<div aria-busy="true" aria-label="Loading sessions">
			{Array.from({ length: 8 }, (_, i) => (
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
							// The hairline below a session is part of its measured row. With the tree, it sets each session and its
							// subagents apart from the next.
							<div className={cx("border-b border-line", showFamilies && "pb-1")} data-family-divider={showFamilies && row.index > 0 ? "" : undefined}>
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
	);

	return (
		<Page className="pb-24">
			<PageTitle>{api.publicView ? "Published trajectories" : "Sessions"}</PageTitle>
			<div className="mt-5">
				<Filters />
			</div>
			<div className={cx("mt-6", !api.publicView && "min-[1100px]:grid min-[1100px]:grid-cols-[184px_minmax(0,1fr)] min-[1100px]:gap-x-10")}>
				{!api.publicView && <BrowseIndex />}
				<div className="min-w-0">
					{/* The columns' names over the header rule; the rows below share their widths. */}
					<div className={cx(COLUMNS, "h-7 items-end border-b border-ink pr-2 pb-1 pl-1.5 text-[12px] font-medium text-muted", showFamilies && "ml-[18px]")} aria-hidden="true">
						<span>Session</span>
						<span className={cx("text-right", WIDE)}>Tokens</span>
						<span className="text-right">Cost</span>
						<span className={cx("text-right", WIDE)}>Duration</span>
						<span className="text-right">Started</span>
					</div>
					{list}
					{sessions.isFetchNextPageError && <ErrorState error={sessions.error} onRetry={() => void sessions.fetchNextPage()} />}
				</div>
			</div>
		</Page>
	);
}
