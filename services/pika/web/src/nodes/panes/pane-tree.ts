/**
 * The panes of one terminal tab: a binary split tree whose leaves are daemon terminals. Pure functions only; the view
 * (`TerminalSplitView`) draws it and the actions (`actions.ts`) change it.
 *
 * Ported in part from Orca (MIT, Copyright (c) 2026 Lovecast Inc.): the tree shape from
 * `src/shared/workspace-layout/terminal-tab-types.ts`, the close successor from
 * `src/renderer/src/lib/pane-manager/pane-layout/pane-close-focus-successor.ts`, and the 50 px minimum from
 * `pane-divider-drag.ts` in the same directory. Orca's split directions are named for the divider; here
 * `direction` is the flex direction: "row" puts the panes side by side, "column" stacks them.
 */

export type PaneDirection = "row" | "column";

export type PaneTree =
    | { type: "leaf"; terminalId: string }
    | { type: "split"; direction: PaneDirection; ratio: number; first: PaneTree; second: PaneTree };

/** Where a split node is: the children taken from the root. */
export type PanePath = readonly ("first" | "second")[];

/** Splits nested deeper than this, or more leaves than `MAX_LEAVES`, are refused. */
export const MAX_DEPTH = 16;
export const MAX_LEAVES = 64;
/** The smallest a pane may be along its split, in pixels, when the split's size is known. */
export const MIN_PANE_PX = 50;
/** The ratio's bounds when the split's size is not known. */
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;
export const LAYOUT_VERSION = 1;
const MAX_ID_LENGTH = 256;

export class PaneTreeError extends Error {
    override name = "PaneTreeError";
}

export const leaf = (terminalId: string): PaneTree => ({ type: "leaf", terminalId });

/** The terminals in reading order: first before second, depth first. Focus moves in this order. */
export function leaves(tree: PaneTree): string[] {
    return tree.type === "leaf" ? [tree.terminalId] : [...leaves(tree.first), ...leaves(tree.second)];
}

export const hasLeaf = (tree: PaneTree, terminalId: string): boolean => leaves(tree).includes(terminalId);

/** Split levels on the deepest path: 0 for a single pane. */
export function depth(tree: PaneTree): number {
    return tree.type === "leaf" ? 0 : 1 + Math.max(depth(tree.first), depth(tree.second));
}

/** `tree` with the leaf for `terminalId` replaced by `replace(leaf)`, or undefined when there is no such leaf. */
function mapLeaf(tree: PaneTree, terminalId: string, replace: (node: PaneTree) => PaneTree): PaneTree | undefined {
    if (tree.type === "leaf") return tree.terminalId === terminalId ? replace(tree) : undefined;
    const first = mapLeaf(tree.first, terminalId, replace);
    if (first) return { ...tree, first };
    const second = mapLeaf(tree.second, terminalId, replace);
    return second ? { ...tree, second } : undefined;
}

/**
 * Puts `newId` next to `terminalId` (after it: right or below; before it: left or above), the two sharing the leaf's
 * space evenly. Throws when `terminalId` is not a pane, `newId` already is, or the tree would outgrow its limits.
 */
export function splitLeaf(tree: PaneTree, terminalId: string, direction: PaneDirection, newId: string, place: "after" | "before"): PaneTree {
    if (hasLeaf(tree, newId)) throw new PaneTreeError(`Terminal ${newId} already has a pane in this tab.`);
    if (leaves(tree).length >= MAX_LEAVES) throw new PaneTreeError(`A tab holds at most ${MAX_LEAVES} panes.`);
    const added = leaf(newId);
    const next = mapLeaf(tree, terminalId, (node) => ({
        type: "split",
        direction,
        ratio: 0.5,
        first: place === "after" ? node : added,
        second: place === "after" ? added : node,
    }));
    if (!next) throw new PaneTreeError(`Terminal ${terminalId} has no pane in this tab.`);
    if (depth(next) > MAX_DEPTH) throw new PaneTreeError(`Panes nest at most ${MAX_DEPTH} splits deep.`);
    return next;
}

/**
 * The tree without `terminalId`'s pane: its sibling takes the parent split's place, and with it the parent's share.
 * Null when that was the last pane. A terminal without a pane leaves the tree as it is (the same object), as both a
 * close and the terminal's exit remove the same pane.
 */
export function closeLeaf(tree: PaneTree, terminalId: string): PaneTree | null {
    if (tree.type === "leaf") return tree.terminalId === terminalId ? null : tree;
    if (tree.first.type === "leaf" && tree.first.terminalId === terminalId) return tree.second;
    if (tree.second.type === "leaf" && tree.second.terminalId === terminalId) return tree.first;
    const first = closeLeaf(tree.first, terminalId);
    if (first !== tree.first) return first && { ...tree, first };
    const second = closeLeaf(tree.second, terminalId);
    if (second !== tree.second) return second && { ...tree, second };
    return tree;
}

/** `terminalId`'s pane shows `newId` instead, in the same place. Throws when there is no such pane or `newId` has one. */
export function replaceLeaf(tree: PaneTree, terminalId: string, newId: string): PaneTree {
    if (terminalId !== newId && hasLeaf(tree, newId)) throw new PaneTreeError(`Terminal ${newId} already has a pane in this tab.`);
    const next = mapLeaf(tree, terminalId, () => leaf(newId));
    if (!next) throw new PaneTreeError(`Terminal ${terminalId} has no pane in this tab.`);
    return next;
}

function step(tree: PaneTree, focused: string | undefined, by: 1 | -1): string {
    const order = leaves(tree);
    const at = focused === undefined ? -1 : order.indexOf(focused);
    if (at < 0) return by === 1 ? order[0]! : order[order.length - 1]!;
    return order[(at + by + order.length) % order.length]!;
}

/** The pane after `focused` in reading order, wrapping; from none (or an unknown one), the first. */
export const focusNext = (tree: PaneTree, focused: string | undefined): string => step(tree, focused, 1);
/** The pane before `focused` in reading order, wrapping; from none (or an unknown one), the last. */
export const focusPrevious = (tree: PaneTree, focused: string | undefined): string => step(tree, focused, -1);

/**
 * Which pane takes focus when `closedId`'s closes, read from the tree before the close: the pane in the sibling
 * subtree that touches the freed edge, as it grows into the space (Orca's rule; across a split on the other axis,
 * every child touches the edge and the first in reading order wins). Without a sibling (an unknown pane), the first
 * pane; undefined when no pane remains.
 */
export function focusSuccessorOnClose(tree: PaneTree, closedId: string): string | undefined {
    const parent = parentOf(tree, closedId);
    if (!parent) {
        const rest = closeLeaf(tree, closedId);
        return rest ? leaves(rest)[0] : undefined;
    }
    const closedIsFirst = parent.first.type === "leaf" && parent.first.terminalId === closedId;
    let node = closedIsFirst ? parent.second : parent.first;
    while (node.type === "split") node = node.direction === parent.direction && !closedIsFirst ? node.second : node.first;
    return node.terminalId;
}

/** The split whose child is `terminalId`'s leaf. */
function parentOf(tree: PaneTree, terminalId: string): Extract<PaneTree, { type: "split" }> | undefined {
    if (tree.type === "leaf") return undefined;
    for (const child of [tree.first, tree.second]) if (child.type === "leaf" && child.terminalId === terminalId) return tree;
    return parentOf(tree.first, terminalId) ?? parentOf(tree.second, terminalId);
}

/** The node at `path`; throws when the path leaves the tree. */
export function nodeAt(tree: PaneTree, path: PanePath): PaneTree {
    let node = tree;
    for (const side of path) {
        if (node.type !== "split") throw new PaneTreeError(`No split at ${path.join("/") || "the root"}.`);
        node = node[side];
    }
    return node;
}

/**
 * The share `ratio` would give the split's first child, kept so each side has at least `MIN_PANE_PX` of `size` (the
 * split's length along its direction, dividers excluded) or, unmeasured, within `MIN_RATIO`–`MAX_RATIO`. A split too
 * small for two minimums is held at the middle. Rounded to four places, so stored layouts stay short.
 */
export function clampRatio(ratio: number, size?: number): number {
    if (!Number.isFinite(ratio)) throw new PaneTreeError("A split ratio must be a number.");
    const round = (value: number) => Math.round(value * 1e4) / 1e4;
    if (size === undefined || !Number.isFinite(size) || size <= 0) return round(Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)));
    const min = Math.min(MIN_PANE_PX, size / 2) / size;
    return round(Math.min(1 - min, Math.max(min, ratio)));
}

/** The split at `path` with its first child's share set to `ratio`, clamped (`clampRatio`). Throws when there is no split at `path`. */
export function setRatio(tree: PaneTree, path: PanePath, ratio: number, size?: number): PaneTree {
    const clamped = clampRatio(ratio, size);
    const update = (node: PaneTree, rest: PanePath): PaneTree => {
        if (node.type !== "split") throw new PaneTreeError(`No split at ${path.join("/") || "the root"}.`);
        if (rest.length === 0) return { ...node, ratio: clamped };
        const [side, ...tail] = rest;
        return { ...node, [side!]: update(node[side!], tail) };
    };
    return update(tree, path);
}

export type PaneEdge = "left" | "right" | "top" | "bottom";

/**
 * `sourceId`'s pane moved to `edge` of `targetId`'s pane, taking half of it; the source's old place goes to its
 * sibling. Throws when either is not a pane or they are the same.
 */
export function moveLeaf(tree: PaneTree, sourceId: string, targetId: string, edge: PaneEdge): PaneTree {
    if (sourceId === targetId) throw new PaneTreeError("A pane cannot move next to itself.");
    if (!hasLeaf(tree, sourceId)) throw new PaneTreeError(`Terminal ${sourceId} has no pane in this tab.`);
    const rest = closeLeaf(tree, sourceId);
    if (!rest || !hasLeaf(rest, targetId)) throw new PaneTreeError(`Terminal ${targetId} has no pane in this tab.`);
    return splitLeaf(rest, targetId, edge === "left" || edge === "right" ? "row" : "column", sourceId, edge === "right" || edge === "bottom" ? "after" : "before");
}

export function sameTree(a: PaneTree, b: PaneTree): boolean {
    if (a.type === "leaf") return b.type === "leaf" && a.terminalId === b.terminalId;
    if (b.type === "leaf") return false;
    return a.direction === b.direction && a.ratio === b.ratio && sameTree(a.first, b.first) && sameTree(a.second, b.second);
}

// ---------------------------------------------------------------------------------------------------------------
// Storage

/** The tree as stored: `{"version":1,"tree":…}`. */
export const serialize = (tree: PaneTree): string => JSON.stringify({ version: LAYOUT_VERSION, tree });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new PaneTreeError(`Unexpected "${key}" in ${where}.`);
}

/**
 * A stored tree (`serialize`'s text, or the value it parsed to), checked: the version, every node's shape, ratios
 * strictly between 0 and 1, terminals unique, at most `MAX_DEPTH` splits deep and `MAX_LEAVES` panes. Anything else
 * throws a `PaneTreeError`: a bad layout is refused, never repaired.
 */
export function parse(input: unknown): PaneTree {
    let value = input;
    if (typeof input === "string") {
        try {
            value = JSON.parse(input);
        } catch (error) {
            throw new PaneTreeError(`The layout is not JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!isObject(value)) throw new PaneTreeError("The layout is not an object.");
    onlyKeys(value, ["version", "tree"], "the layout");
    if (value.version !== LAYOUT_VERSION) throw new PaneTreeError(`Unknown layout version ${JSON.stringify(value.version)}.`);
    const seen = new Set<string>();
    const check = (node: unknown, level: number): PaneTree => {
        if (level > MAX_DEPTH) throw new PaneTreeError(`Panes nest at most ${MAX_DEPTH} splits deep.`);
        if (!isObject(node)) throw new PaneTreeError("A pane is not an object.");
        if (node.type === "leaf") {
            onlyKeys(node, ["type", "terminalId"], "a pane");
            const id = node.terminalId;
            if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) throw new PaneTreeError("A pane's terminalId is not a terminal id.");
            if (seen.has(id)) throw new PaneTreeError(`Terminal ${id} has two panes.`);
            seen.add(id);
            if (seen.size > MAX_LEAVES) throw new PaneTreeError(`A tab holds at most ${MAX_LEAVES} panes.`);
            return leaf(id);
        }
        if (node.type === "split") {
            onlyKeys(node, ["type", "direction", "ratio", "first", "second"], "a split");
            if (node.direction !== "row" && node.direction !== "column") throw new PaneTreeError(`Unknown split direction ${JSON.stringify(node.direction)}.`);
            const ratio = node.ratio;
            if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new PaneTreeError("A split's ratio is not between 0 and 1.");
            return { type: "split", direction: node.direction, ratio, first: check(node.first, level + 1), second: check(node.second, level + 1) };
        }
        throw new PaneTreeError(`Unknown pane type ${JSON.stringify(node.type)}.`);
    };
    return check(value.tree, 0);
}
