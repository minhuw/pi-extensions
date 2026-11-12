/**
 * Where a file opened from somewhere in the workspace goes, so the place it was opened from stays on screen: the
 * group that already has it; the source group itself when it shows an editor (or nothing); an adjacent group that
 * shows an editor, else any adjacent group (right, left, below, above, then top to bottom); else another group;
 * else a new group split to the right of the source.
 *
 * Ported from Orca's `src/renderer/src/lib/links/placement/adjacent-link-open-group.ts` (MIT, Copyright (c) 2026
 * Lovecast Inc.; see ORCA-LICENSE). Changes: a source group showing an editor takes the file itself, as the
 * explorer, quick open, and Changes open from wherever focus is.
 */

import { projectLeaves, type Rect } from "./layout-tree";
import { activeTab, type Workspace } from "./model";

export type Placement = { groupId: string } | { splitRightOf: string };

type NeighbourSide = "right" | "left" | "below" | "above";
const SIDE_ORDER: Record<NeighbourSide, number> = { right: 0, left: 1, below: 2, above: 3 };
const EPSILON = 1e-9;

const overlaps = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > EPSILON;
const touches = (a: number, b: number) => Math.abs(a - b) <= EPSILON;

/** The side of `source` that `target` shares an edge with (a corner is not enough), and where along it. */
export function neighbour(source: Rect, target: Rect): { side: NeighbourSide; position: number } | undefined {
	const vertical = overlaps(source.top, source.bottom, target.top, target.bottom);
	const horizontal = overlaps(source.left, source.right, target.left, target.right);
	if (vertical && touches(source.right, target.left)) return { side: "right", position: target.top };
	if (vertical && touches(source.left, target.right)) return { side: "left", position: target.top };
	if (horizontal && touches(source.bottom, target.top)) return { side: "below", position: target.left };
	if (horizontal && touches(source.top, target.bottom)) return { side: "above", position: target.left };
	return undefined;
}

/** Whether rank `a` sorts before `b`, compared item by item. */
function before(a: readonly number[], b: readonly number[]): boolean {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
	return false;
}

/** Where tab `tabId` (a file or a diff) opens when opened from `sourceGroupId`. */
export function placeOpen(ws: Workspace, sourceGroupId: string, tabId: string): Placement {
	for (const group of Object.values(ws.groups)) if (group.tabOrder.includes(tabId)) return { groupId: group.id };
	const source = ws.groups[sourceGroupId] ? sourceGroupId : ws.activeGroupId;
	const shown = activeTab(ws, source);
	if (!shown || shown.kind !== "terminal") return { groupId: source };
	const placed = projectLeaves(ws.root);
	const from = placed.find((item) => item.groupId === source);
	if (!from || placed.length === 1) return { splitRightOf: source };
	let best: { groupId: string; rank: readonly number[] } | undefined;
	for (const item of placed) {
		if (item.groupId === source) continue;
		const side = neighbour(from.rect, item.rect);
		if (!side) continue;
		const editor = activeTab(ws, item.groupId);
		const rank = [editor && editor.kind !== "terminal" ? 0 : 1, SIDE_ORDER[side.side], side.position, item.order] as const;
		if (!best || before(rank, best.rank)) best = { groupId: item.groupId, rank };
	}
	return { groupId: best?.groupId ?? placed.find((item) => item.groupId !== source)!.groupId };
}
