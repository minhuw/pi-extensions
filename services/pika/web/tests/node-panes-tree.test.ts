import { describe, expect, it } from "vitest";
import {
    clampRatio,
    closeLeaf,
    depth,
    focusNext,
    focusPrevious,
    focusSuccessorOnClose,
    leaf,
    leaves,
    MAX_DEPTH,
    MAX_LEAVES,
    moveLeaf,
    nodeAt,
    parse,
    PaneTreeError,
    replaceLeaf,
    sameTree,
    serialize,
    setRatio,
    splitLeaf,
    type PaneTree,
} from "../src/nodes/panes/pane-tree";

const split = (direction: "row" | "column", first: PaneTree, second: PaneTree, ratio = 0.5): PaneTree => ({ type: "split", direction, ratio, first, second });
const L = leaf;

/**
 *  ┌───┬───┐
 *  │ a │ b │
 *  │   ├───┤
 *  │   │ c │
 *  └───┴───┘
 */
const abc = split("row", L("a"), split("column", L("b"), L("c")));

describe("splitting", () => {
    it("puts the new pane after (right or below) or before (left or above) the leaf, halving it", () => {
        expect(splitLeaf(L("a"), "a", "row", "b", "after")).toEqual(split("row", L("a"), L("b")));
        expect(splitLeaf(L("a"), "a", "column", "b", "before")).toEqual(split("column", L("b"), L("a")));
        const tree = splitLeaf(abc, "c", "row", "d", "after");
        expect(leaves(tree)).toEqual(["a", "b", "c", "d"]);
        expect(nodeAt(tree, ["second", "second"])).toEqual(split("row", L("c"), L("d")));
        // The rest of the tree is untouched, ratios included.
        expect(nodeAt(setRatio(abc, [], 0.3), [])).toMatchObject({ ratio: 0.3 });
        expect(splitLeaf(setRatio(abc, [], 0.3), "a", "column", "d", "after")).toMatchObject({ ratio: 0.3 });
    });

    it("refuses an unknown leaf, a terminal that already has a pane, and growing past the limits", () => {
        expect(() => splitLeaf(abc, "x", "row", "d", "after")).toThrow(PaneTreeError);
        expect(() => splitLeaf(abc, "a", "row", "b", "after")).toThrow(/already has a pane/);
        let deep: PaneTree = L("t0");
        for (let i = 1; i <= MAX_DEPTH; i++) deep = splitLeaf(deep, `t${i - 1}`, "row", `t${i}`, "after");
        expect(depth(deep)).toBe(MAX_DEPTH);
        expect(() => splitLeaf(deep, `t${MAX_DEPTH}`, "row", "deeper", "after")).toThrow(/deep/);
        let wide: PaneTree = L("w0");
        // Split breadth first, so the tree stays well under the depth limit.
        const queue = ["w0"];
        for (let i = 1; i < MAX_LEAVES; i++) {
            const at = queue.shift()!;
            wide = splitLeaf(wide, at, i % 2 ? "row" : "column", `w${i}`, "after");
            queue.push(at, `w${i}`);
        }
        expect(leaves(wide)).toHaveLength(MAX_LEAVES);
        expect(() => splitLeaf(wide, "w0", "row", "one-more", "after")).toThrow(/at most 64/);
    });
});

describe("closing", () => {
    it("gives the parent's place, and its share, to the sibling", () => {
        const tree = split("row", L("a"), split("column", L("b"), L("c"), 0.25), 0.7);
        expect(closeLeaf(tree, "b")).toEqual(split("row", L("a"), L("c"), 0.7));
        expect(closeLeaf(tree, "a")).toEqual(split("column", L("b"), L("c"), 0.25));
        expect(closeLeaf(L("a"), "a")).toBeNull();
    });

    it("leaves the tree as it is (the same object) for a terminal without a pane", () => {
        expect(closeLeaf(abc, "x")).toBe(abc);
        expect(closeLeaf(L("a"), "x")).toEqual(L("a"));
    });
});

describe("replacing", () => {
    it("swaps the terminal in place and refuses unknown or duplicate ids", () => {
        expect(replaceLeaf(abc, "b", "z")).toEqual(split("row", L("a"), split("column", L("z"), L("c"))));
        expect(() => replaceLeaf(abc, "x", "z")).toThrow(PaneTreeError);
        expect(() => replaceLeaf(abc, "b", "c")).toThrow(/already has a pane/);
    });
});

describe("focus order", () => {
    it("moves in reading order and wraps", () => {
        expect(focusNext(abc, "a")).toBe("b");
        expect(focusNext(abc, "c")).toBe("a");
        expect(focusPrevious(abc, "a")).toBe("c");
        expect(focusPrevious(abc, "b")).toBe("a");
        expect(focusNext(L("a"), "a")).toBe("a");
    });

    it("starts at the first (next) or last (previous) pane from none", () => {
        expect(focusNext(abc, undefined)).toBe("a");
        expect(focusNext(abc, "gone")).toBe("a");
        expect(focusPrevious(abc, "gone")).toBe("c");
    });
});

describe("focus after a close", () => {
    it("goes to the sibling leaf", () => {
        expect(focusSuccessorOnClose(split("row", L("a"), L("b")), "a")).toBe("b");
        expect(focusSuccessorOnClose(split("row", L("a"), L("b")), "b")).toBe("a");
    });

    it("goes to the pane touching the freed edge on the same axis", () => {
        // a | (b | c): closing a frees b's left edge; (a | b) | c: closing c frees b's right edge.
        expect(focusSuccessorOnClose(split("row", L("a"), split("row", L("b"), L("c"))), "a")).toBe("b");
        expect(focusSuccessorOnClose(split("row", split("row", L("a"), L("b")), L("c")), "c")).toBe("b");
        // Stacked the same way.
        expect(focusSuccessorOnClose(split("column", split("column", L("a"), L("b")), L("c")), "c")).toBe("b");
    });

    it("goes to the first in reading order across a split on the other axis", () => {
        // a | (b / c): closing a, both b and c touch the freed edge; b reads first.
        expect(focusSuccessorOnClose(abc, "a")).toBe("b");
        // (b / c) | a: closing a likewise.
        expect(focusSuccessorOnClose(split("row", split("column", L("b"), L("c")), L("a")), "a")).toBe("b");
        // Nested deeper: a | ((b | c) / d) closing a: the first child on the other axis, then the near edge (b).
        expect(focusSuccessorOnClose(split("row", L("a"), split("column", split("row", L("b"), L("c")), L("d"))), "a")).toBe("b");
        // ((b / c) | d) | a closing a: the near edge is d, the second child of the same-axis split.
        expect(focusSuccessorOnClose(split("row", split("row", split("column", L("b"), L("c")), L("d")), L("a")), "a")).toBe("d");
    });

    it("falls back to the first pane, or none when the last one closes", () => {
        expect(focusSuccessorOnClose(abc, "gone")).toBe("a");
        expect(focusSuccessorOnClose(L("a"), "a")).toBeUndefined();
    });
});

describe("ratios", () => {
    it("keep each side at least 50 px of a measured size", () => {
        expect(clampRatio(0.01, 1000)).toBe(0.05);
        expect(clampRatio(0.99, 1000)).toBe(0.95);
        expect(clampRatio(0.3, 1000)).toBe(0.3);
        // Too small for two minimums: held at the middle.
        expect(clampRatio(0.1, 80)).toBe(0.5);
        expect(clampRatio(0.9, 80)).toBe(0.5);
    });

    it("stay within 0.1–0.9 without a size", () => {
        expect(clampRatio(0.01)).toBe(0.1);
        expect(clampRatio(0.99)).toBe(0.9);
        expect(clampRatio(0.4)).toBe(0.4);
        expect(() => clampRatio(Number.NaN)).toThrow(PaneTreeError);
    });

    it("are set on the split at the path, and a path that misses a split throws", () => {
        const tree = setRatio(abc, ["second"], 0.02, 1000);
        expect(nodeAt(tree, ["second"])).toMatchObject({ ratio: 0.05 });
        expect(nodeAt(tree, [])).toMatchObject({ ratio: 0.5 });
        expect(setRatio(abc, [], 0.75)).toMatchObject({ ratio: 0.75 });
        expect(() => setRatio(abc, ["first"], 0.5)).toThrow(/No split/);
        expect(() => setRatio(L("a"), [], 0.5)).toThrow(/No split/);
    });
});

describe("moving", () => {
    it("puts the source on the target's edge and closes its old place", () => {
        expect(moveLeaf(abc, "a", "c", "right")).toEqual(split("column", L("b"), split("row", L("c"), L("a"))));
        expect(moveLeaf(abc, "c", "a", "top")).toEqual(split("row", split("column", L("c"), L("a")), L("b")));
        expect(() => moveLeaf(abc, "a", "a", "left")).toThrow(PaneTreeError);
        expect(() => moveLeaf(abc, "x", "a", "left")).toThrow(PaneTreeError);
    });

    it("can be a no-op, which sameTree tells", () => {
        const pair = split("row", L("a"), L("b"));
        expect(sameTree(moveLeaf(pair, "a", "b", "left"), pair)).toBe(true);
        expect(sameTree(moveLeaf(pair, "a", "b", "right"), pair)).toBe(false);
    });
});

describe("storage", () => {
    it("round-trips", () => {
        const tree = setRatio(abc, ["second"], 0.3);
        expect(JSON.parse(serialize(tree))).toEqual({ version: 1, tree });
        expect(parse(serialize(tree))).toEqual(tree);
        expect(parse(JSON.parse(serialize(tree)))).toEqual(tree);
    });

    const refused: [string, unknown][] = [
        ["not JSON", "{"],
        ["not an object", "[]"],
        ["no version", { tree: L("a") }],
        ["another version", { version: 2, tree: L("a") }],
        ["an extra key", { version: 1, tree: L("a"), focused: "a" }],
        ["an unknown node type", { version: 1, tree: { type: "tab", terminalId: "a" } }],
        ["a leaf without an id", { version: 1, tree: { type: "leaf" } }],
        ["an empty id", { version: 1, tree: { type: "leaf", terminalId: "" } }],
        ["a leaf with extra keys", { version: 1, tree: { type: "leaf", terminalId: "a", ratio: 1 } }],
        ["Orca's direction names", { version: 1, tree: { type: "split", direction: "vertical", ratio: 0.5, first: L("a"), second: L("b") } }],
        ["a missing ratio", { version: 1, tree: { type: "split", direction: "row", first: L("a"), second: L("b") } }],
        ["a ratio of 0", { version: 1, tree: split("row", L("a"), L("b"), 0) }],
        ["a ratio of 1", { version: 1, tree: split("row", L("a"), L("b"), 1) }],
        ["a missing child", { version: 1, tree: { type: "split", direction: "row", ratio: 0.5, first: L("a") } }],
        ["a terminal twice", { version: 1, tree: split("row", L("a"), L("a")) }],
    ];
    it.each(refused)("refuses %s", (_, input) => {
        expect(() => parse(typeof input === "string" ? input : JSON.stringify(input))).toThrow(PaneTreeError);
    });

    it("refuses more than 16 splits deep and more than 64 panes", () => {
        let deep: PaneTree = L("t0");
        for (let i = 1; i <= MAX_DEPTH + 1; i++) deep = split("row", deep, L(`t${i}`));
        expect(depth(deep)).toBe(MAX_DEPTH + 1);
        expect(() => parse({ version: 1, tree: deep })).toThrow(/deep/);
        expect(() => parse({ version: 1, tree: (deep as Extract<PaneTree, { type: "split" }>).first })).not.toThrow();

        const balanced = (from: number, count: number): PaneTree =>
            count === 1 ? L(`w${from}`) : split("row", balanced(from, Math.floor(count / 2)), balanced(from + Math.floor(count / 2), count - Math.floor(count / 2)));
        expect(() => parse({ version: 1, tree: balanced(0, MAX_LEAVES) })).not.toThrow();
        expect(() => parse({ version: 1, tree: balanced(0, MAX_LEAVES + 1) })).toThrow(/at most 64/);
    });
});
