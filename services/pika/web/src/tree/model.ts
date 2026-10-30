import { totalTokens } from "../lib/format";
import type { SessionTree, TreeNode } from "../lib/types";
import { isLive } from "../lib/liveness";

/** Above this many sessions the tree starts folded down to the path to the current session. */
export const EXPAND_ALL_LIMIT = 200;

export interface FamilyNode {
	session: TreeNode;
	id: string;
	/** Hops below the root, as the stack rebuilt it: never more than one below the parent. */
	depth: number;
	parentId?: string;
	/** The listed children, in the server's order. */
	children: string[];
	descendants: number;
	/** Self plus every listed descendant. */
	subtreeCost: number;
	subtreeTokens: number;
	/** Epoch milliseconds of the first and last activity; a live session's end moves on as the tree refetches. */
	start?: number;
	end?: number;
	live: boolean;
}

export interface FamilyTree {
	rootId: string;
	/** Depth-first, in pre-order, each session once. */
	nodes: FamilyNode[];
	byId: Map<string, FamilyNode>;
	/** The whole family's time span, if any session has a time. */
	span?: { start: number; end: number };
	maxDepth: number;
	truncated: boolean;
}

function time(value: string | undefined): number | undefined {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Rebuilds the tree from the server's pre-order list using only `depth`: a node is a child of the
 * nearest earlier node one level up. Public summaries may lack `parentSessionId`, so it is not used.
 * A depth that jumps more than one level down is clamped, and a repeated id keeps its first place.
 */
export function buildFamily(tree: SessionTree, now: number = Date.now()): FamilyTree {
	const nodes: FamilyNode[] = [];
	const byId = new Map<string, FamilyNode>();
	const stack: FamilyNode[] = [];
	for (const session of Array.isArray(tree.nodes) ? tree.nodes : []) {
		if (!session || typeof session.id !== "string" || byId.has(session.id)) continue;
		const wanted = Number.isFinite(session.depth) ? Math.max(0, Math.floor(session.depth)) : 0;
		while (stack.length > wanted) stack.pop();
		const parent = stack[stack.length - 1];
		const live = isLive(session.lastAt, now);
		let start = time(session.startedAt);
		let end = time(session.lastAt);
		if (start === undefined) start = end;
		if (end === undefined && start !== undefined) end = start + Math.max(0, finite(session.durationMs));
		const node: FamilyNode = {
			session,
			id: session.id,
			depth: stack.length,
			parentId: parent?.id,
			children: [],
			descendants: 0,
			subtreeCost: finite(session.cost),
			subtreeTokens: totalTokens(session.tokens),
			start,
			end: end !== undefined && start !== undefined ? Math.max(start, end) : end,
			live,
		};
		parent?.children.push(node.id);
		nodes.push(node);
		byId.set(node.id, node);
		stack.push(node);
	}
	// Children follow their parents, so a reverse walk sees every subtree complete.
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i];
		const parent = node.parentId ? byId.get(node.parentId) : undefined;
		if (!parent) continue;
		parent.descendants += node.descendants + 1;
		parent.subtreeCost += node.subtreeCost;
		parent.subtreeTokens += node.subtreeTokens;
	}
	let span: FamilyTree["span"];
	let maxDepth = 0;
	for (const node of nodes) {
		maxDepth = Math.max(maxDepth, node.depth);
		if (node.start === undefined || node.end === undefined) continue;
		span = span ? { start: Math.min(span.start, node.start), end: Math.max(span.end, node.end) } : { start: node.start, end: node.end };
	}
	const rootId = byId.has(tree.rootId) ? tree.rootId : (nodes[0]?.id ?? tree.rootId);
	return { rootId, nodes, byId, span, maxDepth, truncated: tree.truncated === true };
}

/**
 * For each level from the root's children down to `node`, whether a later sibling still follows at that level: what
 * `tree` draws as `│` (or `├`, at the node's own level) rather than a blank (or `└`).
 */
export function continuesAt(family: FamilyTree, node: FamilyNode): boolean[] {
	const levels: boolean[] = [];
	for (let at: FamilyNode | undefined = node; at && levels.length < node.depth; ) {
		const parent: FamilyNode | undefined = at.parentId ? family.byId.get(at.parentId) : undefined;
		if (!parent) break;
		levels.unshift(parent.children[parent.children.length - 1] !== at.id);
		at = parent;
	}
	return levels;
}

/** The ids above `id`, the root first; empty for a session outside the tree. */
export function ancestorsOf(family: FamilyTree, id: string): string[] {
	const path: string[] = [];
	const seen = new Set<string>([id]);
	let parentId = family.byId.get(id)?.parentId;
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		path.unshift(parentId);
		parentId = family.byId.get(parentId)?.parentId;
	}
	return path;
}

/** Every session with children while the family is small; otherwise the roots and the path to `currentId`. */
export function defaultExpanded(family: FamilyTree, currentId: string, limit = EXPAND_ALL_LIMIT): Set<string> {
	if (family.nodes.length <= limit) return expandAll(family);
	const open = new Set<string>(family.nodes.filter((node) => node.depth === 0).map((node) => node.id));
	for (const id of ancestorsOf(family, currentId)) open.add(id);
	if (family.byId.has(currentId)) open.add(currentId);
	return open;
}

export function expandAll(family: FamilyTree): Set<string> {
	return new Set(family.nodes.filter((node) => node.children.length > 0).map((node) => node.id));
}

/** The rows shown when only the sessions in `expanded` show their children. */
export function visibleRows(family: FamilyTree, expanded: ReadonlySet<string>): FamilyNode[] {
	const rows: FamilyNode[] = [];
	// While set, rows deeper than this sit under a collapsed session.
	let hiddenBelow: number | undefined;
	for (const node of family.nodes) {
		if (hiddenBelow !== undefined) {
			if (node.depth > hiddenBelow) continue;
			hiddenBelow = undefined;
		}
		rows.push(node);
		if (node.children.length > 0 && !expanded.has(node.id)) hiddenBelow = node.depth;
	}
	return rows;
}

/** The family's totals: sessions, levels, cost, and tokens. */
export function familyTotals(family: FamilyTree): { sessions: number; levels: number; cost: number; tokens: number } {
	let cost = 0;
	let tokens = 0;
	for (const node of family.nodes) {
		if (node.parentId) continue;
		cost += node.subtreeCost;
		tokens += node.subtreeTokens;
	}
	return { sessions: family.nodes.length, levels: family.nodes.length ? family.maxDepth + 1 : 0, cost, tokens };
}
