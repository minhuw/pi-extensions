import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { Icon } from "../components/icons";
import { PikaLink as Link } from "../components/PikaLink";
import { Callout, cx, ErrorState, Pill } from "../components/ui";
import { ApiError, useApi } from "../lib/api";
import { formatCost, formatCount, formatDateTime, formatDuration, plural, totalTokens } from "../lib/format";
import { useViewState } from "../lib/viewState";
import { useFamily } from "./data";
import { continuesAt, defaultExpanded, expandAll, familyTotals, visibleRows, type FamilyNode, type FamilyTree } from "./model";
import { Caret, KIND_CLASSES, KindPill, rowLabel, TreeLines, TreeStub, type Kind } from "./parts";
import { AgentTreeSkeleton } from "./Skeleton";

/** Narrower pages drop the tokens column, then the timeline and subtree columns; see `WIDE` and `WIDEST`. */
const GRID =
	"grid items-center gap-x-3 grid-cols-[minmax(240px,1fr)_64px_68px] lg:grid-cols-[minmax(260px,3fr)_minmax(140px,2fr)_68px_68px_76px] xl:grid-cols-[minmax(280px,3fr)_minmax(160px,2fr)_72px_72px_72px_80px]";
const WIDE = "hidden lg:block";
const WIDEST = "hidden xl:block";
/** Half a row's height: where its caret and its branch meet. */
const ROW_ELBOW = 16;
/** A branch ends at its row's caret, or past a leaf's empty caret column, just before its tag. */
const CARET_REACH = 2;
const LEAF_REACH = 20;

function sessionPath(id: string, view: string): string {
	return `/s/${encodeURIComponent(id)}?view=${view}`;
}

function TimelineBar({ node, family, kind }: { node: FamilyNode; family: FamilyTree; kind: Kind }) {
	const span = family.span;
	if (!span || node.start === undefined || node.end === undefined) return <span className={cx("h-[6px]", WIDE)} />;
	const length = Math.max(1, span.end - span.start);
	const left = ((node.start - span.start) / length) * 100;
	const width = Math.max(0.6, ((node.end - node.start) / length) * 100);
	const title = `${formatDateTime(node.start)} – ${formatDateTime(node.end)} · ${formatDuration(node.end - node.start)}${node.live ? " · live" : ""}`;
	return (
		<span className="relative hidden h-[6px] rounded-full bg-hover lg:block" title={title} data-tree-bar="">
			<span
				className={cx("absolute inset-y-0 rounded-full opacity-80", KIND_CLASSES[kind].bar)}
				style={{ left: `${Math.min(left, 99.4)}%`, width: `${Math.min(width, 100 - Math.min(left, 99.4))}%` }}
			/>
		</span>
	);
}

function Num({ children, title, className }: { children: string; title?: string; className?: string }) {
	return (
		<span className={cx("tnum truncate text-right text-[12.5px]", className)} title={title}>
			{children}
		</span>
	);
}

interface RowProps {
	node: FamilyNode;
	/** From `continuesAt`. */
	lines: boolean[];
	family: FamilyTree;
	current: boolean;
	open: boolean;
	focused: boolean;
	register: (id: string, element: HTMLElement | null) => void;
	onToggle: (id: string) => void;
	onFocus: (id: string) => void;
}

function TreeRow({ node, lines, family, current, open, focused, register, onToggle, onFocus }: RowProps) {
	const { kind, type, description } = rowLabel(node);
	const expandable = node.children.length > 0;
	const tokens = totalTokens(node.session.tokens);
	return (
		<div
			ref={(element) => register(node.id, element)}
			role="treeitem"
			aria-level={node.depth + 1}
			aria-expanded={expandable ? open : undefined}
			aria-current={current ? "page" : undefined}
			aria-label={`${type}: ${description}`}
			tabIndex={focused ? 0 : -1}
			onFocus={() => onFocus(node.id)}
			className={cx(
				GRID,
				"group h-8 rounded-sm px-2 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-accent",
				current ? "bg-accent-soft" : "hover:bg-hover",
			)}
			data-tree-node={node.id}
			data-depth={node.depth}
			data-current={current ? "" : undefined}
		>
			<span className="flex h-full min-w-0 items-center gap-1.5">
				<span className="flex h-full shrink-0">
					<TreeLines continues={lines} elbow={ROW_ELBOW} reach={expandable ? CARET_REACH : LEAF_REACH} />
					<span className="relative flex w-[18px] items-center">
						{expandable && <Caret open={open} onClick={() => onToggle(node.id)} />}
						{expandable && open && <TreeStub from={ROW_ELBOW + 7} />}
					</span>
				</span>
				<KindPill kind={kind}>{type}</KindPill>
				{current ? (
					<span className="min-w-0 truncate font-medium" title={node.session.title || description}>
						{description}
					</span>
				) : (
					<Link
						to={sessionPath(node.id, "agents")}
						tabIndex={-1}
						className="min-w-0 truncate hover:underline"
						title={node.session.title || description}
						data-tree-link=""
					>
						{description}
					</Link>
				)}
				{expandable && !open && (
					<span className="tnum shrink-0 text-[12px] text-muted" title={`${plural(node.descendants, "session")} below`} data-tree-hidden="">
						+{formatCount(node.descendants)}
					</span>
				)}
				{current && (
					<span className="shrink-0 text-[11px] text-accent" data-this-session="">
						this session
					</span>
				)}
				{node.live && (
					<span className="shrink-0" data-live="">
						<Pill tone="green">live</Pill>
					</span>
				)}
				<Link
					to={sessionPath(node.id, "trajectory")}
					tabIndex={-1}
					title="Open the trajectory"
					aria-label="Open the trajectory"
					className="ml-auto inline-flex size-[18px] shrink-0 items-center justify-center rounded-sm text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100"
					data-open-trajectory=""
				>
					<Icon name="external" size={12} />
				</Link>
			</span>
			<TimelineBar node={node} family={family} kind={kind} />
			<Num>{formatDuration(node.session.durationMs)}</Num>
			<Num title={tokens.toLocaleString("en-US")} className={WIDEST}>
				{formatCount(tokens)}
			</Num>
			<Num>{formatCost(node.session.cost)}</Num>
			<span className={cx("tnum truncate text-right text-[12.5px] text-muted", WIDE)} data-tree-subtree="">
				{expandable ? formatCost(node.subtreeCost) : ""}
			</span>
		</div>
	);
}

/** The session's whole family, root first, with the current session marked. */
export function AgentTree({ sessionId }: { sessionId: string }) {
	const { tree, family } = useFamily(sessionId);
	if (family) return <TreeView sessionId={sessionId} family={family} />;
	if (tree.error instanceof ApiError && tree.error.status === 404) {
		return (
			<div className="px-6 pt-4" data-tree-missing="">
				<Callout title="Agent tree unavailable">
					<div className="text-[13px]">This server does not serve session trees yet, so the agent tree view is unavailable.</div>
				</Callout>
			</div>
		);
	}
	if (tree.isError) {
		return (
			<div className="px-6">
				<ErrorState error={tree.error} onRetry={() => void tree.refetch()} />
			</div>
		);
	}
	return <AgentTreeSkeleton />;
}

function TreeView({ sessionId, family }: { sessionId: string; family: FamilyTree }) {
	const navigate = useNavigate();
	const api = useApi();
	// Unset until the reader expands or collapses something, so the default follows the data.
	const [stored, setExpanded] = useViewState<string[] | null>("agent-tree:expanded", null);
	const expanded = useMemo(() => (stored ? new Set(stored) : defaultExpanded(family, sessionId)), [stored, family, sessionId]);
	const rows = useMemo(() => visibleRows(family, expanded), [family, expanded]);
	const totals = familyTotals(family);
	const rowElements = useRef(new Map<string, HTMLElement>());
	const register = (id: string, element: HTMLElement | null) => {
		if (element) rowElements.current.set(id, element);
		else rowElements.current.delete(id);
	};
	const [focusedId, setFocusedId] = useState(sessionId);
	const focused = rows.some((row) => row.id === focusedId) ? focusedId : (rows.find((row) => row.id === sessionId)?.id ?? rows[0]?.id);

	const scrolled = useRef(false);
	useEffect(() => {
		if (scrolled.current) return;
		scrolled.current = true;
		const element = rowElements.current.get(sessionId);
		if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
	}, [sessionId]);

	const setOpen = (id: string, open: boolean) => {
		const next = new Set(expanded);
		if (open) next.add(id);
		else next.delete(id);
		setExpanded([...next]);
	};
	const toggle = (id: string) => setOpen(id, !expanded.has(id));
	const focusRow = (id: string | undefined) => {
		if (!id) return;
		setFocusedId(id);
		rowElements.current.get(id)?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = rows.findIndex((row) => row.id === focused);
		const node = rows[index];
		if (!node) return;
		const open = expanded.has(node.id);
		switch (event.key) {
			case "ArrowDown":
				focusRow(rows[Math.min(rows.length - 1, index + 1)]?.id);
				break;
			case "ArrowUp":
				focusRow(rows[Math.max(0, index - 1)]?.id);
				break;
			case "Home":
				focusRow(rows[0]?.id);
				break;
			case "End":
				focusRow(rows[rows.length - 1]?.id);
				break;
			case "ArrowRight":
				if (node.children.length === 0) return;
				if (open) focusRow(node.children[0]);
				else setOpen(node.id, true);
				break;
			case "ArrowLeft":
				if (node.children.length > 0 && open) setOpen(node.id, false);
				else focusRow(node.parentId);
				break;
			case "Enter":
				if (node.id === sessionId) return;
				navigate(`${api.publicView ? "/public" : ""}${sessionPath(node.id, "agents")}`);
				break;
			default:
				return;
		}
		event.preventDefault();
	};

	const button = "inline-flex h-6 items-center rounded-sm px-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink";
	return (
		<div className="px-6 pt-3 pb-8" data-agent-tree="">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="tnum text-[13px] text-muted" data-tree-summary="">
					{plural(totals.sessions, "session")} · {plural(totals.levels, "level")} · {formatCost(totals.cost)} · {formatCount(totals.tokens)} tokens across the tree
				</span>
				<span className="ml-auto flex items-center gap-0.5">
					<button type="button" className={button} onClick={() => setExpanded([...expandAll(family)])}>
						Expand all
					</button>
					<button type="button" className={button} onClick={() => setExpanded([])}>
						Collapse all
					</button>
				</span>
			</div>
			{family.truncated && (
				<div className="mt-2" data-tree-truncated="">
					<Callout title="Only part of this family is shown">
						<div className="text-[13px]">Only the first 2,000 sessions, at most 32 levels deep, are listed; the rest of the tree was left out.</div>
					</Callout>
				</div>
			)}
			{/* The header scrolls with the rows when even the narrowest grid does not fit. */}
			<div className="mt-2 overflow-x-auto">
				<div className={cx(GRID, "h-7 border-b border-line px-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase")} aria-hidden="true">
					<span>Session</span>
					<span className={WIDE}>Timeline</span>
					<span className="text-right">Duration</span>
					<span className={cx("text-right", WIDEST)}>Tokens</span>
					<span className="text-right">Cost</span>
					<span className={cx("text-right", WIDE)}>Subtree</span>
				</div>
				<div role="tree" aria-label="Agent tree" className="mt-1" onKeyDown={onKeyDown}>
					{rows.map((node) => (
						<TreeRow
							key={node.id}
							node={node}
							lines={continuesAt(family, node)}
							family={family}
							current={node.id === sessionId}
							open={expanded.has(node.id)}
							focused={node.id === focused}
							register={register}
							onToggle={toggle}
							onFocus={setFocusedId}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
