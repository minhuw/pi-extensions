/**
 * Where a dragged tab lands in a group: the tab strip reorders, the outer 20% band of the body splits towards that
 * edge, and the rest of the body moves the tab into the group.
 *
 * Ported from Orca's `resolvePaneColumnEdgeZone` in `src/renderer/src/components/tab-group/tab-drop-zone.ts` (MIT,
 * Copyright (c) 2026 Lovecast Inc.; see ORCA-LICENSE). Changes: the strip and the centre are zones of their own
 * rather than null, and the left and right bands are measured on the body too, so the strip never splits.
 */

import type { Side } from "./layout-tree";

/** The tab strip's height, `h-9`. */
export const TAB_STRIP_HEIGHT = 36;

/** The share of the body's width (and height) at each edge that splits. */
export const EDGE_BAND = 0.2;

export type DropZone = Side | "center" | "strip";

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The zone of `group` (the whole panel, strip included) that `point` is in; undefined outside it. */
export function dropZone(group: Box, point: { x: number; y: number }, stripHeight = TAB_STRIP_HEIGHT): DropZone | undefined {
	const x = point.x - group.left;
	const y = point.y - group.top;
	if (x < 0 || y < 0 || x > group.width || y > group.height) return undefined;
	if (y < stripHeight) return "strip";
	const bodyHeight = group.height - stripHeight;
	if (bodyHeight <= 0) return "strip";
	const bodyY = y - stripHeight;
	const across = group.width * EDGE_BAND;
	const down = bodyHeight * EDGE_BAND;
	if (x < across) return "left";
	if (x > group.width - across) return "right";
	if (bodyY < down) return "up";
	if (bodyY > bodyHeight - down) return "down";
	return "center";
}

/** The part of the group's body a drop in `zone` would fill, for the drop's preview; relative to the panel. */
export function zonePreview(zone: Exclude<DropZone, "strip">, group: { width: number; height: number }, stripHeight = TAB_STRIP_HEIGHT): Box {
	const body = { left: 0, top: stripHeight, width: group.width, height: Math.max(0, group.height - stripHeight) };
	if (zone === "left") return { ...body, width: body.width / 2 };
	if (zone === "right") return { ...body, left: body.width / 2, width: body.width / 2 };
	if (zone === "up") return { ...body, height: body.height / 2 };
	if (zone === "down") return { ...body, top: body.top + body.height / 2, height: body.height / 2 };
	return body;
}
