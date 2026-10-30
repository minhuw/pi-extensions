import { describe, expect, it } from "vitest";
import type { SessionTree, TreeNode } from "../src/lib/types";
import { ancestorsOf, buildFamily, continuesAt, defaultExpanded, expandAll, familyTotals, visibleRows } from "../src/tree/model";
import { iso, summary } from "./support/fixtures";

function node(id: string, depth: number, extra: Partial<TreeNode> = {}): TreeNode {
	const { children: _children, ...rest } = summary(id, { cost: 1, tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } });
	return { ...rest, depth, ...extra };
}

function tree(nodes: TreeNode[], extra: Partial<SessionTree> = {}): SessionTree {
	return { rootId: nodes[0]?.id ?? "", nodes, ...extra };
}

// r ─┬─ a ─┬─ a1
//    │     └─ a2 ── a2x
//    └─ b
const FAMILY = [node("r", 0), node("a", 1), node("a1", 2), node("a2", 2), node("a2x", 3), node("b", 1)];
const NOW = Date.parse(iso(10_000_000));

describe("the agent tree model", () => {
	it("rebuilds parents, children, counts, and subtree totals from the pre-order depths", () => {
		const family = buildFamily(tree(FAMILY), NOW);
		expect(family.nodes.map((n) => [n.id, n.depth, n.parentId])).toEqual([
			["r", 0, undefined],
			["a", 1, "r"],
			["a1", 2, "a"],
			["a2", 2, "a"],
			["a2x", 3, "a2"],
			["b", 1, "r"],
		]);
		expect(family.byId.get("r")?.children).toEqual(["a", "b"]);
		expect(family.byId.get("r")?.descendants).toBe(5);
		expect(family.byId.get("a")?.descendants).toBe(3);
		expect(family.byId.get("a")?.subtreeCost).toBe(4);
		expect(family.byId.get("a")?.subtreeTokens).toBe(40);
		expect(family.byId.get("b")?.subtreeCost).toBe(1);
		expect(family.maxDepth).toBe(3);
		expect(familyTotals(family)).toEqual({ sessions: 6, levels: 4, cost: 6, tokens: 60 });
		expect(ancestorsOf(family, "a2x")).toEqual(["r", "a", "a2"]);
		expect(ancestorsOf(family, "r")).toEqual([]);
		expect(ancestorsOf(family, "missing")).toEqual([]);
	});

	it("ignores parentSessionId, which the public view strips", () => {
		const nodes = FAMILY.map((n) => ({ ...n, parentSessionId: "elsewhere" }));
		expect(buildFamily(tree(nodes), NOW).byId.get("a2x")?.parentId).toBe("a2");
	});

	it("clamps depth jumps, treats bad depths as roots, and keeps the first of duplicate ids", () => {
		const family = buildFamily(
			tree([node("r", 0), node("deep", 5), node("deeper", 9), node("dup", 1), node("deep", 1), node("odd", Number.NaN), node("x", 1)]),
			NOW,
		);
		expect(family.nodes.map((n) => [n.id, n.depth, n.parentId])).toEqual([
			["r", 0, undefined],
			["deep", 1, "r"],
			["deeper", 2, "deep"],
			["dup", 1, "r"],
			["odd", 0, undefined],
			["x", 1, "odd"],
		]);
		// A list that starts below the root still has a root.
		expect(buildFamily(tree([node("c", 3), node("d", 4)]), NOW).nodes.map((n) => n.depth)).toEqual([0, 1]);
		expect(buildFamily({ rootId: "r", nodes: [] }, NOW)).toMatchObject({ nodes: [], maxDepth: 0, span: undefined });
	});

	it("falls back on whichever time a session has, and ends a live session at its last activity", () => {
		const live = node("live", 1, { startedAt: iso(1000), lastAt: new Date(NOW - 5000).toISOString() });
		const family = buildFamily(
			tree([
				node("r", 0, { startedAt: iso(0), lastAt: iso(60_000) }),
				node("noStart", 1, { startedAt: "", lastAt: iso(30_000) }),
				node("noEnd", 1, { startedAt: iso(20_000), lastAt: "", durationMs: 5000 }),
				node("none", 1, { startedAt: "", lastAt: "" }),
				live,
			]),
			NOW,
		);
		expect(family.byId.get("noStart")).toMatchObject({ start: Date.parse(iso(30_000)), end: Date.parse(iso(30_000)) });
		expect(family.byId.get("noEnd")).toMatchObject({ start: Date.parse(iso(20_000)), end: Date.parse(iso(25_000)) });
		expect(family.byId.get("none")).toMatchObject({ start: undefined, end: undefined });
		// Not now: a session that just finished would otherwise run on for the whole live window.
		expect(family.byId.get("live")).toMatchObject({ live: true, end: NOW - 5000 });
		expect(family.span).toEqual({ start: Date.parse(iso(0)), end: NOW - 5000 });
	});

	it("says at each level whether a later sibling follows, as tree draws its lines", () => {
		// r
		// ├─ a
		// │  ├─ a1
		// │  ╰─ a2
		// │     ╰─ a2x
		// ╰─ b
		const family = buildFamily(tree(FAMILY), NOW);
		const lines = Object.fromEntries(family.nodes.map((n) => [n.id, continuesAt(family, n)]));
		expect(lines).toEqual({ r: [], a: [true], a1: [true, true], a2: [true, false], a2x: [true, false, false], b: [false] });
	});

	it("shows only what the expansion set opens", () => {
		const family = buildFamily(tree(FAMILY), NOW);
		expect(visibleRows(family, expandAll(family)).map((n) => n.id)).toEqual(["r", "a", "a1", "a2", "a2x", "b"]);
		expect(visibleRows(family, new Set(["r"])).map((n) => n.id)).toEqual(["r", "a", "b"]);
		expect(visibleRows(family, new Set(["r", "a"])).map((n) => n.id)).toEqual(["r", "a", "a1", "a2", "b"]);
		expect(visibleRows(family, new Set()).map((n) => n.id)).toEqual(["r"]);
	});

	it("opens everything in a small family and only the path to the current session in a large one", () => {
		const small = buildFamily(tree(FAMILY), NOW);
		expect([...defaultExpanded(small, "b")].sort()).toEqual(["a", "a2", "r"]);
		const many = [node("r", 0), node("a", 1), node("a1", 2), node("a1x", 3), node("a1xy", 4)];
		for (let i = 0; i < 210; i++) many.push(node(`w${i}`, 1), node(`w${i}c`, 2));
		const large = buildFamily(tree(many), NOW);
		const open = defaultExpanded(large, "a1x");
		expect([...open].sort()).toEqual(["a", "a1", "a1x", "r"]);
		expect(visibleRows(large, open).slice(0, 6).map((n) => n.id)).toEqual(["r", "a", "a1", "a1x", "a1xy", "w0"]);
		expect(visibleRows(large, open).some((n) => n.id === "w0c")).toBe(false);
	});
});
