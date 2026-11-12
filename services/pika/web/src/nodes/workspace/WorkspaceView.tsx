/**
 * One project's workspace on screen: its group split tree with dividers, and each group's tab strip and active tab.
 * Terminal tabs draw only slots (`TerminalSplitView`); the terminal layer draws the terminals over them.
 *
 * - **Dividers** follow the pointer live and commit their ratio on release, which is also when terminals send their
 *   sizes to the node (`TerminalSlots.resizeEnd`).
 * - **Dragging a tab** (with `@dnd-kit/core`, past 4 px): onto a strip it reorders or moves there, into the outer 20%
 *   of a group's body it splits that edge, into the rest of the body it moves into the group (`drop-zone.ts`).
 * - **Tab strips** are tab lists: arrows move between tabs, Home and End, Delete closes, Shift+F10 or the context
 *   menu key opens the tab's menu (Move Tab to Split Right/Left/Down/Up, Pin, Close, Close Others).
 *
 * After Orca's tab groups (`src/renderer/src/components/tab-group/`: `TabGroupSplitNodeTree.tsx`,
 * `TabGroupPanel.tsx`, `useTabDragSplit.ts`; MIT, Copyright (c) 2026 Lovecast Inc.; see ORCA-LICENSE); pika's own code.
 */

import { DndContext, DragOverlay, PointerSensor, useDraggable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../../components/icons";
import { BUTTON, cx } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import type { Theme } from "../../lib/theme";
import { paneLabel } from "../client";
import { isMenuKey, useMenu, type MenuEntry } from "../deck/Menu";
import { tip } from "../deck/Tooltips";
import { actionShortcut } from "../keys";
import { sanitize, type TerminalInfo } from "../contract";
import { isDirty, type EditorSnapshot, type EditorStore } from "../editor";
import { EditorTabBody, diffKind } from "../FilePanel";
import { baseName } from "../files";
import { TerminalSplitView } from "../panes/TerminalSplitView";
import { TerminalSlotsContext, type TerminalSlots } from "../panes/slot-contract";
import type { PaneDirection, PaneTree } from "../panes/pane-tree";
import { dropZone, TAB_STRIP_HEIGHT, zonePreview, type Box, type DropZone } from "./drop-zone";
import { clampRatio, type GroupTree, type Side, type TreePath } from "./layout-tree";
import { activeTab, groupOf, tabTerminals, type Group, type Workspace, type WorkspaceTab } from "./model";
import { paneMark, StatusGlyph, strongestMark } from "./status";

export interface WorkspaceActions {
	activate(tabId: string): void;
	focusGroup(groupId: string): void;
	/** Closes a tab (asking first when it has unsaved edits). */
	close(tabId: string): void;
	closeOthers(tabId: string): void;
	setPinned(tabId: string, pinned: boolean): void;
	/** Moves a tab within or between groups, at `index` (after the target's active tab without one). */
	move(tabId: string, groupId: string, index?: number): void;
	/** Moves a tab into a new group on `side` of `groupId`. */
	split(tabId: string, groupId: string, side: Side): void;
	setRatio(path: TreePath, ratio: number): void;
	/** A terminal tab's new pane tree (a divider or a moved pane). */
	setPanes(tabId: string, tree: PaneTree): void;
	focusPane(tabId: string, terminalId: string): void;
	splitPane(tabId: string, direction: PaneDirection): void;
	closePane(tabId: string, terminalId: string): void;
	newTerminal(groupId: string): void;
	/** An edited preview is kept. */
	promote(tabId: string): void;
	/** Tells the terminals their slots may have moved, and that a resize ended. */
	resizeEnd(): void;
}

export interface WorkspaceViewProps {
	node: string;
	nodeName: string;
	home: string;
	ws: Workspace;
	terminals: ReadonlyMap<string, TerminalInfo>;
	editors: EditorStore;
	editorSnapshot: EditorSnapshot;
	/** Every editor key open on the node, for Monaco's models. */
	editorKeys: readonly string[];
	slots: TerminalSlots;
	theme: Theme;
	diffInline: boolean;
	onDiffInline: (inline: boolean) => void;
	actions: WorkspaceActions;
	/** Called after every layout this view commits, so terminals can follow slots that moved without resizing. */
	onLayout: () => void;
}

/** A tab's title, icon, and status. */
function tabTitle(tab: WorkspaceTab, terminals: ReadonlyMap<string, TerminalInfo>): { name: string; detail?: string; title: string } {
	if (tab.kind === "terminal") {
		const ids = tabTerminals(tab);
		const focused = terminals.get(tab.focused);
		const name = focused ? paneLabel(focused) : "Terminal";
		return { name, ...(ids.length > 1 ? { detail: `+${ids.length - 1}` } : {}), title: focused?.cwd ?? name };
	}
	const name = sanitize(baseName(tab.path));
	return tab.kind === "diff" ? { name, detail: diffKind(tab), title: sanitize(tab.path) } : { name, title: sanitize(tab.path) };
}

interface DragTarget {
	groupId: string;
	zone: DropZone;
	/** For a strip: where among the group's tabs (without the dragged one) it goes. */
	index?: number;
	/** The preview, relative to the workspace. */
	preview: Box;
}

interface Menu {
	tabId: string;
	x: number;
	y: number;
}

export function WorkspaceView(props: WorkspaceViewProps) {
	const { ws, actions } = props;
	const root = useRef<HTMLDivElement>(null);
	const groupElements = useRef(new Map<string, HTMLElement>()).current;
	const [dragging, setDragging] = useState<string>();
	const [target, setTarget] = useState<DragTarget>();
	const start = useRef<{ x: number; y: number } | null>(null);
	const tabMenu = useMenu();
	const openMenu = (at: Menu) => {
		if (ws.tabs[at.tabId]) tabMenu.open({ anchor: { x: at.x, y: at.y }, items: tabMenuItems(ws, at.tabId, actions), label: "Tab", attrs: { "data-tab-menu": at.tabId } });
	};
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

	useLayoutEffect(() => props.onLayout());

	const locate = (point: { x: number; y: number }, tabId: string): DragTarget | undefined => {
		const view = root.current?.getBoundingClientRect();
		if (!view) return undefined;
		for (const [groupId, element] of groupElements) {
			const rect = element.getBoundingClientRect();
			const zone = dropZone(rect, point);
			if (!zone) continue;
			const group = ws.groups[groupId];
			if (!group) return undefined;
			const from = groupOf(ws, tabId);
			if (zone === "strip") {
				const tabs = [...element.querySelectorAll<HTMLElement>("[data-tab-id]")].filter((item) => item.dataset.tabId !== tabId);
				const index = tabs.filter((item) => {
					const box = item.getBoundingClientRect();
					return box.left + box.width / 2 < point.x;
				}).length;
				const after = tabs[index - 1]?.getBoundingClientRect();
				const before = tabs[index]?.getBoundingClientRect();
				const x = (after ? after.right : before ? before.left : rect.left) - view.left;
				return { groupId, zone, index, preview: { left: x - 1, top: rect.top - view.top + 4, width: 2, height: TAB_STRIP_HEIGHT - 8 } };
			}
			// A group's only tab dropped on its own body changes nothing.
			if (from?.id === groupId && (zone === "center" || group.tabOrder.length === 1)) return undefined;
			const fill = zonePreview(zone, rect);
			return { groupId, zone, preview: { left: rect.left - view.left + fill.left, top: rect.top - view.top + fill.top, width: fill.width, height: fill.height } };
		}
		return undefined;
	};

	const pointOf = (event: DragMoveEvent | DragEndEvent) => (start.current ? { x: start.current.x + event.delta.x, y: start.current.y + event.delta.y } : undefined);

	const onDragStart = (event: DragStartEvent) => {
		const activator = event.activatorEvent as PointerEvent | MouseEvent;
		start.current = "clientX" in activator ? { x: activator.clientX, y: activator.clientY } : null;
		setDragging(String(event.active.id));
		tabMenu.close();
	};
	const onDragMove = (event: DragMoveEvent) => {
		const point = pointOf(event);
		setTarget(point ? locate(point, String(event.active.id)) : undefined);
	};
	const onDragEnd = (event: DragEndEvent) => {
		const point = pointOf(event);
		const tabId = String(event.active.id);
		const drop = point ? locate(point, tabId) : undefined;
		setDragging(undefined);
		setTarget(undefined);
		start.current = null;
		if (!drop) return;
		if (drop.zone === "strip") actions.move(tabId, drop.groupId, drop.index);
		else if (drop.zone === "center") actions.move(tabId, drop.groupId);
		else actions.split(tabId, drop.groupId, drop.zone);
		actions.resizeEnd();
	};
	const onDragCancel = () => {
		setDragging(undefined);
		setTarget(undefined);
		start.current = null;
	};

	const draggedTab = dragging ? ws.tabs[dragging] : undefined;

	return (
		<TerminalSlotsContext.Provider value={props.slots}>
			<DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
				<div ref={root} className="relative flex min-h-0 min-w-0 flex-1" data-workspace="">
					<SplitNode node={ws.root} path={[]} view={props} groupElements={groupElements} onMenu={openMenu} style={{ flex: "1 1 0%" }} />
					{target && (
						<div
							className={cx("pointer-events-none absolute z-20", target.zone === "strip" ? "bg-dk-accent" : "border-2 border-dk-accent bg-dk-accent-soft")}
							style={{ left: target.preview.left, top: target.preview.top, width: target.preview.width, height: target.preview.height }}
							data-tab-drop={`${target.groupId}:${target.zone}`}
						/>
					)}
				</div>
				<DragOverlay dropAnimation={null}>
					{draggedTab && (
						<div className="flex h-8 items-center gap-1.5 rounded-sm border border-line bg-page px-3 text-[12.5px] font-medium shadow-md">
							{tabTitle(draggedTab, props.terminals).name}
						</div>
					)}
				</DragOverlay>
			</DndContext>
			{tabMenu.menu}
		</TerminalSlotsContext.Provider>
	);
}

interface NodeProps {
	node: GroupTree;
	path: TreePath;
	view: WorkspaceViewProps;
	groupElements: Map<string, HTMLElement>;
	onMenu: (menu: Menu) => void;
	style: CSSProperties;
}

function SplitNode({ node, path, view, groupElements, onMenu, style }: NodeProps) {
	const [live, setLive] = useState<number>();
	if (node.type === "leaf") {
		const group = view.ws.groups[node.groupId];
		return group ? <GroupPanel group={group} view={view} groupElements={groupElements} onMenu={onMenu} style={style} /> : null;
	}
	const ratio = live ?? node.ratio;
	const row = node.direction === "row";
	return (
		<div className={cx("flex min-h-0 min-w-0", row ? "flex-row" : "flex-col")} style={style} data-group-split={path.join("/")} data-direction={node.direction}>
			<SplitNode node={node.first} path={[...path, "first"]} view={view} groupElements={groupElements} onMenu={onMenu} style={{ flex: `${ratio} 1 0%` }} />
			<GroupDivider
				row={row}
				ratio={node.ratio}
				onLive={setLive}
				onCommit={(next) => {
					setLive(undefined);
					if (next !== node.ratio) view.actions.setRatio(path, next);
					view.actions.resizeEnd();
				}}
			/>
			<SplitNode node={node.second} path={[...path, "second"]} view={view} groupElements={groupElements} onMenu={onMenu} style={{ flex: `${1 - ratio} 1 0%` }} />
		</div>
	);
}

/** A 5 px gap between two groups: drag it (the layout follows live; the ratio commits on release), or arrow keys. */
function GroupDivider({ row, ratio, onLive, onCommit }: { row: boolean; ratio: number; onLive: (ratio: number | undefined) => void; onCommit: (ratio: number) => void }) {
	const drag = useRef<{ pointerId: number; total: number; origin: number; start: number; last: number; frame: number | null } | null>(null);

	const down = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		const element = event.currentTarget;
		const parent = element.parentElement;
		if (!parent) return;
		event.preventDefault();
		const box = parent.getBoundingClientRect();
		const total = (row ? box.width : box.height) - element.getBoundingClientRect()[row ? "width" : "height"];
		if (total <= 0) return;
		element.setPointerCapture?.(event.pointerId);
		drag.current = { pointerId: event.pointerId, total, origin: row ? event.clientX : event.clientY, start: ratio, last: ratio, frame: null };
	};
	const move = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current;
		if (!state || event.pointerId !== state.pointerId) return;
		state.last = clampRatio(state.start + ((row ? event.clientX : event.clientY) - state.origin) / state.total);
		if (state.frame === null)
			state.frame = requestAnimationFrame(() => {
				state.frame = null;
				onLive(state.last);
			});
	};
	const up = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current;
		if (!state || event.pointerId !== state.pointerId) return;
		drag.current = null;
		if (state.frame !== null) cancelAnimationFrame(state.frame);
		onCommit(state.last);
	};
	const cancel = () => {
		const state = drag.current;
		drag.current = null;
		if (state?.frame) cancelAnimationFrame(state.frame);
		if (state) onCommit(state.start);
	};
	const key = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? 0.2 : 0.05;
		const less = row ? "ArrowLeft" : "ArrowUp";
		const more = row ? "ArrowRight" : "ArrowDown";
		let next: number | undefined;
		if (event.key === less) next = ratio - step;
		else if (event.key === more) next = ratio + step;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = 1;
		if (next === undefined) return;
		event.preventDefault();
		onCommit(clampRatio(next));
	};

	return (
		<div
			role="separator"
			aria-orientation={row ? "vertical" : "horizontal"}
			aria-label={row ? "Resize the groups side by side" : "Resize the groups above and below"}
			aria-valuenow={Math.round(ratio * 100)}
			aria-valuemin={15}
			aria-valuemax={85}
			tabIndex={0}
			onPointerDown={down}
			onPointerMove={move}
			onPointerUp={up}
			onPointerCancel={cancel}
			onLostPointerCapture={(event) => {
				if (drag.current?.pointerId === event.pointerId) up(event);
			}}
			onDoubleClick={() => onCommit(0.5)}
			onKeyDown={key}
			className={cx(
				"relative shrink-0 touch-none bg-line outline-none hover:bg-dk-line-strong focus-visible:bg-dk-accent",
				row ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize",
			)}
			data-group-divider=""
		/>
	);
}

function GroupPanel({ group, view, groupElements, onMenu, style }: { group: Group; view: WorkspaceViewProps; groupElements: Map<string, HTMLElement>; onMenu: (menu: Menu) => void; style: CSSProperties }) {
	const { ws, actions } = view;
	const active = activeTab(ws, group.id);
	const focused = ws.activeGroupId === group.id;
	const multi = Object.keys(ws.groups).length > 1;
	const ref = useCallback(
		(element: HTMLDivElement | null) => {
			if (!element) return;
			groupElements.set(group.id, element);
			return () => {
				if (groupElements.get(group.id) === element) groupElements.delete(group.id);
			};
		},
		[groupElements, group.id],
	);

	return (
		<div
			ref={ref}
			className="flex min-h-0 min-w-0 flex-col"
			style={style}
			onPointerDownCapture={() => {
				if (!focused) actions.focusGroup(group.id);
			}}
			onFocusCapture={() => {
				if (!focused) actions.focusGroup(group.id);
			}}
			data-group-id={group.id}
			data-group-focused={focused ? "" : undefined}
		>
			<TabStrip group={group} view={view} focused={focused && multi} onMenu={onMenu} />
			<div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-group-body={group.id}>
				{active ? <TabBody tab={active} view={view} /> : <EmptyGroup onNew={() => actions.newTerminal(group.id)} />}
			</div>
		</div>
	);
}

function EmptyGroup({ onNew }: { onNew: () => void }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted" data-group-empty="">
			<p>Nothing open here. Open a file from the explorer, or start a terminal.</p>
			<button type="button" className={cx(BUTTON.secondary, "h-7")} onClick={onNew}>
				<Icon name="plus" size={13} />
				New terminal
			</button>
		</div>
	);
}

function TabBody({ tab, view }: { tab: WorkspaceTab; view: WorkspaceViewProps }) {
	const { actions, terminals } = view;
	if (tab.kind === "terminal") {
		return (
			<div className="flex min-h-0 min-w-0 flex-1" data-tab-body={tab.id}>
				<TerminalSplitView
					tree={tab.panes}
					focused={tab.focused}
					onChange={(tree) => actions.setPanes(tab.id, tree)}
					onFocus={(terminalId) => actions.focusPane(tab.id, terminalId)}
					onSplit={(direction) => actions.splitPane(tab.id, direction)}
					onClose={(terminalId) => actions.closePane(tab.id, terminalId)}
					label={(terminalId) => {
						const terminal = terminals.get(terminalId);
						return terminal ? paneLabel(terminal) : "Terminal";
					}}
				/>
			</div>
		);
	}
	const editorTab = view.editorSnapshot.tabs.find((item) => item.key === tab.id);
	if (!editorTab) return <div className="flex flex-1 items-center justify-center text-[13px] text-muted">Opening {sanitize(baseName(tab.path))}…</div>;
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col" data-tab-body={tab.id}>
			<EditorTabBody
				node={view.node}
				nodeName={view.nodeName}
				home={view.home}
				store={view.editors}
				tab={editorTab}
				keys={view.editorKeys}
				theme={view.theme}
				diffInline={view.diffInline}
				onDiffInline={view.onDiffInline}
				onEdit={() => actions.promote(tab.id)}
			/>
		</div>
	);
}

function TabStrip({ group, view, focused, onMenu }: { group: Group; view: WorkspaceViewProps; focused: boolean; onMenu: (menu: Menu) => void }) {
	const { ws, actions } = view;
	const strip = useRef<HTMLDivElement>(null);

	const focusTab = (index: number) => {
		const id = group.tabOrder[Math.max(0, Math.min(group.tabOrder.length - 1, index))];
		if (!id) return;
		actions.activate(id);
		requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)?.focus());
	};

	const keyDown = (event: KeyboardEvent<HTMLDivElement>, tabId: string) => {
		const at = group.tabOrder.indexOf(tabId);
		if (event.key === "ArrowRight") focusTab(at + 1);
		else if (event.key === "ArrowLeft") focusTab(at - 1);
		else if (event.key === "Home") focusTab(0);
		else if (event.key === "End") focusTab(group.tabOrder.length - 1);
		else if (event.key === "Delete") actions.close(tabId);
		else if (isMenuKey(event)) {
			const box = event.currentTarget.getBoundingClientRect();
			onMenu({ tabId, x: box.left, y: box.bottom });
		} else return;
		event.preventDefault();
	};

	return (
		<div
			ref={strip}
			className={cx("flex shrink-0 items-stretch border-b border-line bg-sidebar", focused && "shadow-[inset_0_2px_0_var(--dk-accent)]")}
			style={{ height: TAB_STRIP_HEIGHT }}
			data-tab-strip={group.id}
		>
			<div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:thin]" role="tablist" aria-label="Tabs">
				{group.tabOrder.map((id) => {
					const tab = ws.tabs[id];
					return tab ? <TabItem key={id} tab={tab} active={group.activeTabId === id} view={view} onKeyDown={keyDown} onMenu={onMenu} /> : null;
				})}
			</div>
			{/* An empty group says the same in its body, with a labelled button: one offer, not two. */}
			{group.tabOrder.length > 0 && (
				<button
					type="button"
					className="flex w-8 shrink-0 items-center justify-center text-muted hover:bg-hover hover:text-ink"
					aria-label="New terminal here"
					{...tip("New terminal here")}
					onClick={() => actions.newTerminal(group.id)}
					data-group-new-terminal={group.id}
				>
					<Icon name="plus" size={13} />
				</button>
			)}
		</div>
	);
}

function TabItem({
	tab,
	active,
	view,
	onKeyDown,
	onMenu,
}: {
	tab: WorkspaceTab;
	active: boolean;
	view: WorkspaceViewProps;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>, tabId: string) => void;
	onMenu: (menu: Menu) => void;
}) {
	const { actions } = view;
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: tab.id });
	const { name, detail, title } = tabTitle(tab, view.terminals);
	const editorTab = tab.kind === "file" ? view.editorSnapshot.tabs.find((item) => item.key === tab.id) : undefined;
	const dirty = editorTab ? isDirty(editorTab) : false;
	const mark = tab.kind === "terminal" ? strongestMark(tabTerminals(tab).map((id) => paneMark(view.terminals.get(id)))) : undefined;
	const preview = tab.kind === "file" && tab.preview;
	// dnd-kit's own button role and description do not apply: this is a tab, and dragging it is a pointer gesture.
	const { role: _role, "aria-roledescription": _description, tabIndex: _tabIndex, ...dragAttributes } = attributes;

	return (
		<div
			ref={setNodeRef}
			className={cx(
				"group relative flex max-w-[220px] shrink-0 items-center border-r border-line text-[12.5px]",
				active ? "bg-page font-medium text-ink shadow-[inset_0_-2px_0_var(--dk-accent)]" : "text-muted hover:bg-hover",
				isDragging && "opacity-40",
			)}
			onKeyDown={(event) => onKeyDown(event, tab.id)}
			onContextMenu={(event) => {
				event.preventDefault();
				onMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
			}}
			onAuxClick={(event) => {
				if (event.button === 1) actions.close(tab.id);
			}}
			data-tab-id={tab.id}
			data-tab-kind={tab.kind}
			data-preview={preview ? "" : undefined}
			data-pinned={tab.pinned ? "" : undefined}
			data-dirty={dirty ? "" : undefined}
		>
			<button
				type="button"
				role="tab"
				aria-selected={active}
				tabIndex={active ? 0 : -1}
				className="flex h-full min-w-0 items-center gap-1.5 pr-1 pl-2.5 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--dk-accent)]"
				{...tip(title)}
				onClick={() => actions.activate(tab.id)}
				onDoubleClick={() => preview && actions.promote(tab.id)}
				{...dragAttributes}
				{...listeners}
			>
				{tab.pinned && <PinGlyph />}
				{mark ? <StatusGlyph mark={mark} /> : tab.kind === "diff" ? <Icon name="branch" size={12} className="shrink-0" /> : <Icon name="file" size={12} className="shrink-0" />}
				<span className={cx("min-w-0 truncate", preview && "italic")}>{name}</span>
				{detail && <span className="shrink-0 text-[11px] text-muted">{detail}</span>}
			</button>
			<button
				type="button"
				tabIndex={-1}
				className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
				aria-label={dirty ? `Close ${name} (unsaved)` : `Close ${name}`}
				{...tip(dirty ? "Close (unsaved)" : "Close", "tab.close")}
				onClick={() => actions.close(tab.id)}
				data-tab-close={tab.id}
			>
				{dirty ? (
					<>
						<span className="size-2 rounded-full bg-ink group-hover:hidden" aria-hidden="true" data-dirty-marker="" />
						<Icon name="close" size={11} className="hidden group-hover:block" />
					</>
				) : (
					<Icon name="close" size={11} className={cx(!active && "opacity-0 group-hover:opacity-100")} />
				)}
			</button>
		</div>
	);
}

function PinGlyph() {
	return (
		<svg width="11" height="11" viewBox="0 0 12 12" className="shrink-0" aria-label="Pinned" role="img">
			<path d="M4.5 1.5h3l-.5 3 2 2H3l2-2zM6 6.5v4" fill="none" stroke="currentColor" strokeWidth="1.2" />
		</svg>
	);
}

const SPLITS: readonly [Side, string][] = [
	["right", "Move Tab to Split Right"],
	["left", "Move Tab to Split Left"],
	["down", "Move Tab to Split Down"],
	["up", "Move Tab to Split Up"],
];

/**
 * A tab's context menu entries (Deck's shared menu): the splits, Pin, Copy Path for a file, Close, Close Others. A
 * group's only tab has no splits to move into, and a tab with no unpinned neighbours no others to close: both are left
 * out rather than shown disabled.
 */
export function tabMenuItems(ws: Workspace, tabId: string, actions: WorkspaceActions): MenuEntry[] {
	const tab = ws.tabs[tabId]!;
	const group = groupOf(ws, tab.id)!;
	const alone = group.tabOrder.length === 1;
	const others = group.tabOrder.some((id) => id !== tab.id && !ws.tabs[id]?.pinned);
	const closeKeys = actionShortcut("tab.close");
	return [
		...(alone
			? []
			: [
					...SPLITS.map(([side, label]): MenuEntry => ({ id: `split-${side}`, label, icon: side === "left" || side === "right" ? "split-right" : "split-down", run: () => actions.split(tab.id, group.id, side) })),
					"separator" as const,
				]),
		{ id: "pin", label: tab.pinned ? "Unpin" : "Pin", icon: "pin", run: () => actions.setPinned(tab.id, !tab.pinned) },
		...(tab.kind !== "terminal" ? [{ id: "copy-path", label: "Copy Path", icon: "copy" as const, run: () => void copyText(tab.path) }] : []),
		"separator",
		{ id: "close", label: "Close", icon: "close", run: () => actions.close(tab.id), ...(closeKeys ? { shortcut: closeKeys } : {}) },
		...(others ? [{ id: "close-others", label: "Close Others", run: () => actions.closeOthers(tab.id) }] : []),
	];
}
