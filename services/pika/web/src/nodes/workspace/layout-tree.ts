/**
 * A workspace's split tree of tab groups: a leaf is a group, a split puts two subtrees side by side (`row`) or one
 * above the other (`column`) at `ratio`.
 *
 * Ported from Orca's `src/shared/workspace-layout/tab-group-layout-tree.ts` and the leaf projection in
 * `src/renderer/src/lib/links/placement/adjacent-link-open-group.ts` (MIT, Copyright (c) 2026 Lovecast Inc.; see
 * ORCA-LICENSE). Changes: `row`/`column` for Orca's `horizontal`/`vertical`, ratios clamped to `RATIO_BOUNDS` here
 * rather than in the view, and paths of `"first" | "second"` named as such.
 */

export type SplitDirection = "row" | "column";

export type GroupTree =
	| { type: "leaf"; groupId: string }
	| { type: "split"; direction: SplitDirection; ratio: number; first: GroupTree; second: GroupTree };

/** Where a new group goes beside another: its side of the other. */
export type Side = "left" | "right" | "up" | "down";

export type TreePath = readonly ("first" | "second")[];

/** The least and most share of a split the first side may take. */
export const RATIO_BOUNDS = [0.15, 0.85] as const;

export const clampRatio = (ratio: number): number =>
	Number.isFinite(ratio) ? Math.min(RATIO_BOUNDS[1], Math.max(RATIO_BOUNDS[0], ratio)) : 0.5;

export const leaf = (groupId: string): GroupTree => ({ type: "leaf", groupId });

const directionOf = (side: Side): SplitDirection => (side === "left" || side === "right" ? "row" : "column");
const firstOf = (side: Side): boolean => side === "left" || side === "up";

/** A split of `existing` with a new group on `side` of it, half and half. */
export function buildSplit(existingGroupId: string, newGroupId: string, side: Side): GroupTree {
	const existing = leaf(existingGroupId);
	const added = leaf(newGroupId);
	return firstOf(side)
		? { type: "split", direction: directionOf(side), ratio: 0.5, first: added, second: existing }
		: { type: "split", direction: directionOf(side), ratio: 0.5, first: existing, second: added };
}

export function replaceLeaf(root: GroupTree, groupId: string, replacement: GroupTree): GroupTree {
	if (root.type === "leaf") return root.groupId === groupId ? replacement : root;
	return { ...root, first: replaceLeaf(root.first, groupId, replacement), second: replaceLeaf(root.second, groupId, replacement) };
}

/** Sets the split at `path` to `ratio`, clamped; anything else at `path` is left alone. */
export function setRatio(root: GroupTree, path: TreePath, ratio: number): GroupTree {
	if (root.type !== "split") return root;
	if (path.length === 0) return { ...root, ratio: clampRatio(ratio) };
	const [step, ...rest] = path;
	return step === "first" ? { ...root, first: setRatio(root.first, rest, ratio) } : { ...root, second: setRatio(root.second, rest, ratio) };
}

/** The groups in tree order (left to right, top to bottom). */
export function leaves(root: GroupTree): string[] {
	return root.type === "leaf" ? [root.groupId] : [...leaves(root.first), ...leaves(root.second)];
}

export const holds = (root: GroupTree, groupId: string): boolean =>
	root.type === "leaf" ? root.groupId === groupId : holds(root.first, groupId) || holds(root.second, groupId);

const firstLeaf = (root: GroupTree): string => (root.type === "leaf" ? root.groupId : firstLeaf(root.first));

/** The group that takes over when `groupId` goes: its sibling, or the sibling subtree's first group. */
export function siblingOf(root: GroupTree, groupId: string): string | undefined {
	if (root.type === "leaf") return undefined;
	if (root.first.type === "leaf" && root.first.groupId === groupId) return firstLeaf(root.second);
	if (root.second.type === "leaf" && root.second.groupId === groupId) return firstLeaf(root.first);
	return siblingOf(root.first, groupId) ?? siblingOf(root.second, groupId);
}

/** The tree without `groupId`, its sibling promoted into the split's place; null when it was the only group. */
export function removeLeaf(root: GroupTree, groupId: string): GroupTree | null {
	if (root.type === "leaf") return root.groupId === groupId ? null : root;
	if (root.first.type === "leaf" && root.first.groupId === groupId) return root.second;
	if (root.second.type === "leaf" && root.second.groupId === groupId) return root.first;
	const first = removeLeaf(root.first, groupId);
	const second = removeLeaf(root.second, groupId);
	if (first === null) return second;
	if (second === null) return first;
	return { ...root, first, second };
}

/** Puts `groupId` (already in the tree, or new) on `side` of `besideGroupId`. */
export function placeBeside(root: GroupTree, groupId: string, besideGroupId: string, side: Side): GroupTree {
	const rest = removeLeaf(root, groupId) ?? leaf(besideGroupId);
	return replaceLeaf(rest, besideGroupId, buildSplit(besideGroupId, groupId, side));
}

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Each group's place in the unit square, from the ratios: for adjacency, not for drawing. */
export function projectLeaves(root: GroupTree): { groupId: string; rect: Rect; order: number }[] {
	const out: { groupId: string; rect: Rect; order: number }[] = [];
	const visit = (node: GroupTree, rect: Rect) => {
		if (node.type === "leaf") {
			out.push({ groupId: node.groupId, rect, order: out.length });
			return;
		}
		const ratio = clampRatio(node.ratio);
		if (node.direction === "row") {
			const at = rect.left + (rect.right - rect.left) * ratio;
			visit(node.first, { ...rect, right: at });
			visit(node.second, { ...rect, left: at });
		} else {
			const at = rect.top + (rect.bottom - rect.top) * ratio;
			visit(node.first, { ...rect, bottom: at });
			visit(node.second, { ...rect, top: at });
		}
	};
	visit(root, { left: 0, top: 0, right: 1, bottom: 1 });
	return out;
}

/** A tree as stored, checked: every split well formed, every group once. Undefined when it is not one. */
export function parseTree(value: unknown, seen = new Set<string>()): GroupTree | undefined {
	if (!value || typeof value !== "object") return undefined;
	const node = value as Record<string, unknown>;
	if (node.type === "leaf") {
		if (typeof node.groupId !== "string" || !node.groupId || seen.has(node.groupId)) return undefined;
		seen.add(node.groupId);
		return leaf(node.groupId);
	}
	if (node.type !== "split" || (node.direction !== "row" && node.direction !== "column") || typeof node.ratio !== "number") return undefined;
	const first = parseTree(node.first, seen);
	const second = first && parseTree(node.second, seen);
	if (!first || !second) return undefined;
	return { type: "split", direction: node.direction, ratio: clampRatio(node.ratio), first, second };
}
