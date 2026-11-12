/**
 * One terminal tab's panes: its split tree as nested flex boxes with dividers between. Each pane is an empty slot the
 * terminal layer draws its terminal over (`TerminalSlots`); this view never draws a terminal itself.
 *
 * - **Dividers:** dragging one moves the flex shares once a frame and, on release only, commits the ratio
 *   (`onChange`) and tells the layer (`resizeEnd`), so the node hears one resize per drag. A cancelled drag (pointer
 *   cancel, the window losing focus, Escape) puts the panes back. Arrow keys move a focused divider; a double-click
 *   evens it.
 * - **Focus:** with more than one pane, the focused one is outlined, and a pointer down on a pane's frame or header
 *   focuses it (the terminal over the slot reports its own focus through the layer).
 * - **Moving panes:** a pane's header grip drags it onto another pane's nearest edge, past a 5 px threshold.
 *
 * After Orca (MIT, Copyright (c) 2026 Lovecast Inc.): `src/renderer/src/lib/pane-manager/pane-layout/pane-divider-drag.ts`
 * (frame-coalesced flex writes, window listeners that outlive a lost pointer capture, the 50 px minimum) and
 * `pane-drag-pointer.ts` (the drag threshold and the nearest-edge drop zone).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { tip } from "../deck/Tooltips";
import { cx } from "../../components/ui";
import { hasLeaf, leaves, MIN_PANE_PX, moveLeaf, sameTree, setRatio, type PaneDirection, type PaneEdge, type PanePath, type PaneTree } from "./pane-tree";
import { useTerminalSlots, type TerminalSlots } from "./slot-contract";

export interface TerminalSplitViewProps {
    tree: PaneTree;
    focused: string;
    onChange(tree: PaneTree): void;
    onFocus(terminalId: string): void;
    /** Split the focused pane: "row" puts the new one on its right, "column" below it. */
    onSplit(direction: PaneDirection): void;
    onClose(terminalId: string): void;
    /** A pane's name for its header and labels; the terminal id without it. */
    label?(terminalId: string): string;
}

/** Pixels a pane's grip must travel before it drags. */
export const DRAG_THRESHOLD = 5;
/** A focused divider's step per arrow key, as a share of the split (Shift: `KEY_STEP_LARGE`). */
const KEY_STEP = 0.05;
const KEY_STEP_LARGE = 0.2;

interface ViewContext {
    tree: () => PaneTree;
    props: () => TerminalSplitViewProps;
    slots: TerminalSlots;
    multi: boolean;
    focused: string;
    panes: Map<string, HTMLElement>;
    startMove(terminalId: string, event: ReactPointerEvent<HTMLElement>): void;
    moving: string | undefined;
    /** This render's `label`: read during render, so not through `props()`, which lags one render. */
    label: (terminalId: string) => string;
}

interface Drop {
    target: string;
    edge: PaneEdge;
    /** The marked half of the target, relative to the view. */
    box: { left: number; top: number; width: number; height: number };
}

export function TerminalSplitView(props: TerminalSplitViewProps) {
    const slots = useTerminalSlots();
    const propsRef = useRef(props);
    useLayoutEffect(() => {
        propsRef.current = props;
    });
    const root = useRef<HTMLDivElement>(null);
    const panes = useRef(new Map<string, HTMLElement>()).current;
    const [moving, setMoving] = useState<string>();
    const [drop, setDrop] = useState<Drop>();
    const endMove = useRef<(() => void) | null>(null);
    useEffect(() => () => endMove.current?.(), []);

    const startMove = useCallback(
        (source: string, event: ReactPointerEvent<HTMLElement>) => {
            if (event.button !== 0) return;
            event.preventDefault();
            endMove.current?.();
            const handle = event.currentTarget;
            const pointerId = event.pointerId;
            const start = { x: event.clientX, y: event.clientY };
            let dragging = false;
            let target: Drop | undefined;
            try {
                handle.setPointerCapture?.(pointerId);
            } catch {
                // Capture is a convenience: the window listeners below track the pointer either way.
            }
            const locate = (x: number, y: number): Drop | undefined => {
                const view = root.current?.getBoundingClientRect();
                const tree = propsRef.current.tree;
                if (!view || !hasLeaf(tree, source)) return undefined;
                for (const [id, element] of panes) {
                    if (id === source) continue;
                    const rect = element.getBoundingClientRect();
                    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom || rect.width <= 0 || rect.height <= 0) continue;
                    const edge = nearestEdge(x, y, rect);
                    if (sameTree(moveLeaf(tree, source, id, edge), tree)) return undefined;
                    const half = { width: rect.width / 2, height: rect.height / 2 };
                    return {
                        target: id,
                        edge,
                        box: {
                            left: rect.left - view.left + (edge === "right" ? half.width : 0),
                            top: rect.top - view.top + (edge === "bottom" ? half.height : 0),
                            width: edge === "left" || edge === "right" ? half.width : rect.width,
                            height: edge === "top" || edge === "bottom" ? half.height : rect.height,
                        },
                    };
                }
                return undefined;
            };
            const move = (e: PointerEvent) => {
                if (e.pointerId !== pointerId) return;
                if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
                if (!dragging) {
                    dragging = true;
                    setMoving(source);
                }
                target = locate(e.clientX, e.clientY);
                setDrop(target);
            };
            const finish = (commit: boolean) => {
                endMove.current = null;
                window.removeEventListener("pointermove", move, true);
                window.removeEventListener("pointerup", up, true);
                window.removeEventListener("pointercancel", cancel, true);
                window.removeEventListener("keydown", escape, true);
                window.removeEventListener("blur", blur);
                handle.removeEventListener("lostpointercapture", lost);
                try {
                    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
                } catch {
                    // Already released.
                }
                setMoving(undefined);
                setDrop(undefined);
                const current = propsRef.current;
                // Either pane may have closed while it dragged.
                if (commit && dragging && target && hasLeaf(current.tree, source) && hasLeaf(current.tree, target.target)) {
                    current.onChange(moveLeaf(current.tree, source, target.target, target.edge));
                    slots.resizeEnd();
                }
            };
            const up = (e: PointerEvent) => {
                if (e.pointerId === pointerId) finish(true);
            };
            const cancel = (e: PointerEvent) => {
                if (e.pointerId === pointerId) finish(false);
            };
            const lost = (e: PointerEvent) => {
                if (e.pointerId === pointerId) finish(false);
            };
            const escape = (e: globalThis.KeyboardEvent) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                finish(false);
            };
            const blur = () => finish(false);
            window.addEventListener("pointermove", move, true);
            window.addEventListener("pointerup", up, true);
            window.addEventListener("pointercancel", cancel, true);
            window.addEventListener("keydown", escape, true);
            // Not capture: a capturing window listener also hears blurs of elements inside the page.
            window.addEventListener("blur", blur);
            handle.addEventListener("lostpointercapture", lost);
            endMove.current = () => finish(false);
        },
        [panes, slots],
    );

    const context: ViewContext = {
        tree: () => propsRef.current.tree,
        props: () => propsRef.current,
        slots,
        multi: props.tree.type === "split",
        focused: props.focused,
        panes,
        startMove,
        moving,
        label: props.label ?? ((terminalId) => terminalId),
    };

    return (
        <div ref={root} className="relative flex h-full min-h-0 w-full min-w-0" data-terminal-split="" data-pane-count={leaves(props.tree).length}>
            <Node node={props.tree} path={[]} context={context} style={{ flex: "1 1 0%" }} />
            {drop && (
                <div
                    className="pointer-events-none absolute z-50 border-2 border-dk-accent bg-dk-accent-soft"
                    style={{ left: drop.box.left, top: drop.box.top, width: drop.box.width, height: drop.box.height }}
                    data-pane-drop={`${drop.target}:${drop.edge}`}
                />
            )}
        </div>
    );
}

/** The edge of `rect` nearest the pointer. There is no centre: a drop always splits. */
export function nearestEdge(x: number, y: number, rect: Pick<DOMRect, "left" | "top" | "width" | "height">): PaneEdge {
    const relX = (x - rect.left) / rect.width;
    const relY = (y - rect.top) / rect.height;
    const distances: [PaneEdge, number][] = [
        ["top", relY],
        ["bottom", 1 - relY],
        ["left", relX],
        ["right", 1 - relX],
    ];
    return distances.reduce((best, item) => (item[1] < best[1] ? item : best))[0];
}

function Node({ node, path, context, style }: { node: PaneTree; path: PanePath; context: ViewContext; style: CSSProperties }) {
    if (node.type === "leaf") return <Pane terminalId={node.terminalId} context={context} style={style} />;
    return (
        <div
            className={cx("flex min-h-0 min-w-0", node.direction === "row" ? "flex-row" : "flex-col")}
            style={style}
            data-pane-split={path.join("/")}
            data-direction={node.direction}
        >
            <Node node={node.first} path={[...path, "first"]} context={context} style={{ flex: `${node.ratio} 1 0%` }} />
            <Divider direction={node.direction} ratio={node.ratio} path={path} context={context} />
            <Node node={node.second} path={[...path, "second"]} context={context} style={{ flex: `${1 - node.ratio} 1 0%` }} />
        </div>
    );
}

function Pane({ terminalId, context, style }: { terminalId: string; context: ViewContext; style: CSSProperties }) {
    const { slots, panes, multi } = context;
    const focused = context.focused === terminalId;
    const name = context.label(terminalId);
    // A stable ref per pane and layer, so a render does not detach and attach the slot again.
    const slotRef = useCallback(
        (element: HTMLDivElement | null) => {
            if (!element) return;
            slots.attach(terminalId, element);
            return () => slots.attach(terminalId, null);
        },
        [slots, terminalId],
    );
    const paneRef = useCallback(
        (element: HTMLDivElement | null) => {
            if (!element) return;
            panes.set(terminalId, element);
            return () => {
                if (panes.get(terminalId) === element) panes.delete(terminalId);
            };
        },
        [panes, terminalId],
    );
    const focus = () => {
        if (context.props().focused !== terminalId) context.props().onFocus(terminalId);
    };

    return (
        <div
            ref={paneRef}
            className={cx(
                "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
                multi && "border",
                multi && (focused ? "border-dk-accent" : "border-line"),
                context.moving === terminalId && "opacity-50",
            )}
            style={style}
            onPointerDown={focus}
            data-pane={terminalId}
            data-focused={focused ? "" : undefined}
        >
            {multi && (
                <div className={cx("flex h-6 shrink-0 items-center gap-1 border-b border-line pl-1 text-[11px]", focused ? "bg-hover text-ink" : "bg-soft text-muted")}>
                    <span
                        className="flex h-5 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm hover:bg-page"
                        onPointerDown={(event) => context.startMove(terminalId, event)}
                        {...tip("Drag to another pane's edge to move this pane")}
                        aria-hidden="true"
                        data-pane-grip={terminalId}
                    >
                        <Glyph name="grip" />
                    </span>
                    <span className="min-w-0 flex-1 truncate" {...tip(name)}>
                        {name}
                    </span>
                    <PaneButton label="Split right" onClick={() => context.props().onSplit("row")} glyph="splitRight" />
                    <PaneButton label="Split down" onClick={() => context.props().onSplit("column")} glyph="splitDown" />
                    <PaneButton label={`Close ${name}`} onClick={() => context.props().onClose(terminalId)} glyph="close" data-pane-close={terminalId} />
                </div>
            )}
            <div ref={slotRef} className="relative min-h-0 min-w-0 flex-1" data-pane-slot={terminalId} />
        </div>
    );
}

function PaneButton({ label, onClick, glyph, ...rest }: { label: string; onClick: () => void; glyph: GlyphName; "data-pane-close"?: string }) {
    return (
        <button type="button" className="flex h-6 w-6 shrink-0 items-center justify-center hover:bg-page hover:text-ink" onClick={onClick} aria-label={label} {...tip(label)} {...rest}>
            <Glyph name={glyph} />
        </button>
    );
}

type GlyphName = "grip" | "splitRight" | "splitDown" | "close";

function Glyph({ name }: { name: GlyphName }) {
    const paths: Record<GlyphName, string> = {
        grip: "M4 3h1v1H4zM7 3h1v1H7zM4 6h1v1H4zM7 6h1v1H7zM4 9h1v1H4zM7 9h1v1H7z",
        splitRight: "M1.5 2.5h9v7h-9zM6 2.5v7",
        splitDown: "M1.5 2.5h9v7h-9zM1.5 6h9",
        close: "M3 3l6 6M9 3l-6 6",
    };
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill={name === "grip" ? "currentColor" : "none"} stroke={name === "grip" ? "none" : "currentColor"} aria-hidden="true">
            <path d={paths[name]} />
        </svg>
    );
}

interface DividerDrag {
    pointerId: number;
    pointerType: string;
    start: number;
    prevSize: number;
    total: number;
    prev: HTMLElement;
    next: HTMLElement;
    prevFlex: string;
    nextFlex: string;
    moved: boolean;
    /** The first pane's size the next frame writes, and the last one written or pending. */
    size: number;
    frame: number | null;
    cleanup: () => void;
}

function Divider({ direction, ratio, path, context }: { direction: PaneDirection; ratio: number; path: PanePath; context: ViewContext }) {
    const self = useRef<HTMLDivElement>(null);
    const drag = useRef<DividerDrag | null>(null);
    const row = direction === "row";
    const { slots } = context;

    const write = (state: DividerDrag) => {
        state.frame = null;
        state.prev.style.flex = `${state.size} 1 0%`;
        state.next.style.flex = `${state.total - state.size} 1 0%`;
    };

    const finish = (commit: boolean) => {
        const state = drag.current;
        if (!state) return;
        drag.current = null;
        state.cleanup();
        if (state.frame !== null) cancelAnimationFrame(state.frame);
        if (!state.moved) return;
        if (commit) {
            write(state);
            context.props().onChange(setRatio(context.tree(), path, state.size / state.total, state.total));
        } else {
            state.prev.style.flex = state.prevFlex;
            state.next.style.flex = state.nextFlex;
        }
        // The layer fitted the terminals while they moved; now it sends their sizes (or, cancelled, puts them back).
        slots.resizeEnd();
    };
    const finishRef = useRef(finish);
    useLayoutEffect(() => {
        finishRef.current = finish;
    });
    // Unmounted mid-drag: drop the listeners, commit nothing.
    useEffect(
        () => () => {
            const state = drag.current;
            drag.current = null;
            if (state) {
                state.cleanup();
                if (state.frame !== null) cancelAnimationFrame(state.frame);
            }
        },
        [],
    );

    /** The two panes beside this divider and their sizes along the split. */
    const measure = () => {
        const element = self.current;
        const prev = element?.previousElementSibling as HTMLElement | null;
        const next = element?.nextElementSibling as HTMLElement | null;
        if (!prev || !next) return undefined;
        const a = prev.getBoundingClientRect();
        const b = next.getBoundingClientRect();
        const prevSize = row ? a.width : a.height;
        const total = prevSize + (row ? b.width : b.height);
        return Number.isFinite(total) && total > 0 ? { prev, next, prevSize, total } : undefined;
    };

    const down = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        finishRef.current(false);
        const box = measure();
        if (!box) return;
        const element = event.currentTarget;
        const pointerId = event.pointerId;
        try {
            element.setPointerCapture?.(pointerId);
        } catch {
            // The window listeners track the pointer without capture too.
        }
        // The pointer this drag follows; a primary mouse or pen may take over (WSLg turns a press into pen motion), touch never mixes with the others.
        const active = (e: PointerEvent) => {
            const state = drag.current;
            return !!state && (e.pointerId === state.pointerId || (e.isPrimary && e.pointerType !== "touch" && state.pointerType !== "touch"));
        };
        const move = (e: PointerEvent) => {
            const state = drag.current;
            if (!state || !active(e)) return;
            state.moved = true;
            const min = Math.min(MIN_PANE_PX, state.total / 2);
            state.size = Math.min(state.total - min, Math.max(min, state.prevSize + (row ? e.clientX : e.clientY) - state.start));
            if (state.frame === null) state.frame = requestAnimationFrame(() => write(state));
        };
        const up = (e: PointerEvent) => {
            if (active(e)) finishRef.current(true);
        };
        const cancel = (e: PointerEvent) => {
            if (active(e)) finishRef.current(false);
        };
        const escape = (e: globalThis.KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            finishRef.current(false);
        };
        const blur = () => finishRef.current(false);
        // Window listeners, not the divider's: Chromium can drop the capture while the button is still down.
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", cancel, true);
        window.addEventListener("keydown", escape, true);
        window.addEventListener("blur", blur);
        drag.current = {
            pointerId,
            pointerType: event.pointerType,
            start: row ? event.clientX : event.clientY,
            prevSize: box.prevSize,
            total: box.total,
            prev: box.prev,
            next: box.next,
            prevFlex: box.prev.style.flex,
            nextFlex: box.next.style.flex,
            moved: false,
            size: box.prevSize,
            frame: null,
            cleanup: () => {
                window.removeEventListener("pointermove", move, true);
                window.removeEventListener("pointerup", up, true);
                window.removeEventListener("pointercancel", cancel, true);
                window.removeEventListener("keydown", escape, true);
                window.removeEventListener("blur", blur);
                try {
                    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
                } catch {
                    // Already released.
                }
            },
        };
    };

    const commitRatio = (next: number) => {
        const total = measure()?.total;
        context.props().onChange(setRatio(context.tree(), path, next, total));
        slots.resizeEnd();
    };

    const key = (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        const [less, more] = row ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
        if (event.key !== less && event.key !== more) return;
        event.preventDefault();
        commitRatio(ratio + (event.key === more ? step : -step));
    };

    return (
        <div
            ref={self}
            role="separator"
            aria-orientation={row ? "vertical" : "horizontal"}
            aria-label={row ? "Resize the panes side by side" : "Resize the stacked panes"}
            aria-valuenow={Math.round(ratio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            onPointerDown={down}
            onKeyDown={key}
            onDoubleClick={() => commitRatio(0.5)}
            className={cx(
                // A real gap, so the terminal layer drawn over the slots never covers the hit area; a 1px rule in it.
                "relative shrink-0 touch-none outline-none before:absolute before:bg-line hover:before:bg-dk-line-strong focus-visible:before:bg-dk-accent",
                row ? "w-[5px] cursor-col-resize before:inset-y-0 before:left-[2px] before:w-px" : "h-[5px] cursor-row-resize before:inset-x-0 before:top-[2px] before:h-px",
            )}
            data-pane-divider={path.join("/")}
        />
    );
}
