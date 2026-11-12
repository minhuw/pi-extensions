import { describe, expect, it } from "vitest";
import { NodeRequestError } from "../src/nodes/channel";
import type { NodeEvent, Requests, RequestType, Results, TerminalInfo } from "../src/nodes/contract";
import { closePane, paneEvent, prunePanes, removePane, splitPane, splitSize, type PaneHost, type PaneTab } from "../src/nodes/panes/actions";
import { leaf, leaves, type PaneTree } from "../src/nodes/panes/pane-tree";

const info = (terminalId: string, more: Partial<TerminalInfo> = {}): TerminalInfo => ({
    terminalId,
    title: "bash",
    cwd: "/home/me",
    cols: 120,
    rows: 40,
    pid: 7,
    createdAt: 1,
    argv: ["/bin/bash", "-l"],
    ...more,
});

const split = (direction: "row" | "column", first: PaneTree, second: PaneTree): PaneTree => ({ type: "split", direction, ratio: 0.5, first, second });

interface Call {
    type: RequestType;
    params: unknown;
}

/** A node with terminals, answering `term.cwd`, `term.create`, and `term.kill` the way the daemon does. */
function fakeNode(terminals: TerminalInfo[], live: Record<string, string> = {}) {
    const calls: Call[] = [];
    let next = 1;
    const gates: (() => void)[] = [];
    let hold = false;
    const known = new Map(terminals.map((item) => [item.terminalId, item]));
    const request = async <K extends RequestType>(type: K, params: Requests[K]): Promise<Results[K]> => {
        calls.push({ type, params });
        if (hold && type === "term.create") await new Promise<void>((resolve) => gates.push(resolve));
        switch (type) {
            case "term.cwd": {
                const { terminalId } = params as Requests["term.cwd"];
                if (!(terminalId in live)) throw new NodeRequestError({ code: "exited", message: "the terminal has exited" });
                return { cwd: live[terminalId] } as Results[K];
            }
            case "term.create": {
                const { cwd, cols, rows } = params as Requests["term.create"];
                const terminal = info(`new${next++}`, { cwd: cwd ?? "/home/me", cols, rows });
                known.set(terminal.terminalId, terminal);
                return { terminal } as Results[K];
            }
            case "term.kill": {
                const { terminalId } = params as Requests["term.kill"];
                if (!known.has(terminalId)) throw new NodeRequestError({ code: "not_found", message: `no terminal ${terminalId}` });
                return {} as Results[K];
            }
            default:
                throw new Error(`unexpected ${type}`);
        }
    };
    return {
        calls,
        channel: { request },
        /** Holds `term.create` replies until `release`. */
        hold: () => (hold = true),
        release: () => {
            hold = false;
            for (const gate of gates.splice(0)) gate();
        },
        forget: (terminalId: string) => known.delete(terminalId),
    };
}

function host(node: ReturnType<typeof fakeNode>, tab: PaneTab | undefined, terminals: TerminalInfo[], connected = true) {
    const state = { tab, closed: 0 };
    const byId = new Map(terminals.map((item) => [item.terminalId, item]));
    const value: PaneHost = {
        client: { channel: (id) => (connected && id === "n1" ? node.channel : undefined) },
        node: "n1",
        read: () => state.tab,
        write: (next) => {
            state.tab = next;
        },
        closeTab: () => {
            state.tab = undefined;
            state.closed++;
        },
        terminal: (id) => byId.get(id),
    };
    return { host: value, state };
}

describe("splitting a pane", () => {
    it("starts the new terminal where the focused pane's shell is now, beside it, with focus", async () => {
        const a = info("a", { cwd: "/home/me" });
        const live: Record<string, string> = { a: "/home/me/src/pika" };
        const node = fakeNode([a], live);
        const { host: h, state } = host(node, { tree: leaf("a"), focused: "a" }, [a]);
        const created = await splitPane(h, "row");
        expect(created?.terminalId).toBe("new1");
        expect(node.calls.map((call) => call.type)).toEqual(["term.cwd", "term.create"]);
        expect(node.calls[1]!.params).toEqual({ cols: 59, rows: 40, cwd: "/home/me/src/pika" });
        expect(state.tab).toEqual({ tree: split("row", leaf("a"), leaf("new1")), focused: "new1" });

        // The new pane is focused before the page lists its terminal: its cwd still comes from the node, at a default size.
        live.new1 = "/tmp/work";
        await splitPane(h, "column");
        expect(node.calls.at(-1)!.params).toEqual({ cols: 80, rows: 24, cwd: "/tmp/work" });
        expect(state.tab).toEqual({ tree: split("row", leaf("a"), split("column", leaf("new1"), leaf("new2"))), focused: "new2" });
    });

    it("falls back to where the terminal started when term.cwd has no answer", async () => {
        const a = info("a", { cwd: "/srv/start" });
        const node = fakeNode([a], {});
        const { host: h, state } = host(node, { tree: leaf("a"), focused: "a" }, [a]);
        await splitPane(h, "column", "before");
        expect(node.calls[1]!.params).toMatchObject({ cwd: "/srv/start" });
        expect(state.tab).toEqual({ tree: split("column", leaf("new1"), leaf("a")), focused: "new1" });
    });

    it("goes next to the pane focused now when the source closed while the terminal started", async () => {
        const a = info("a");
        const b = info("b");
        const node = fakeNode([a, b], { a: "/x" });
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, [a, b]);
        node.hold();
        const pending = splitPane(h, "column");
        await Promise.resolve();
        await Promise.resolve();
        removePane(h, "a");
        expect(state.tab).toEqual({ tree: leaf("b"), focused: "b" });
        node.release();
        await pending;
        expect(state.tab).toEqual({ tree: split("column", leaf("b"), leaf("new1")), focused: "new1" });
    });

    it("kills the new terminal when the tab closed while it started", async () => {
        const a = info("a");
        const node = fakeNode([a], { a: "/x" });
        const { host: h, state } = host(node, { tree: leaf("a"), focused: "a" }, [a]);
        node.hold();
        const pending = splitPane(h, "row");
        await Promise.resolve();
        await Promise.resolve();
        state.tab = undefined;
        node.release();
        expect(await pending).toBeUndefined();
        expect(node.calls.at(-1)).toEqual({ type: "term.kill", params: { terminalId: "new1", signal: "SIGHUP" } });
    });

    it("throws without a connection", async () => {
        const a = info("a");
        const { host: h } = host(fakeNode([a]), { tree: leaf("a"), focused: "a" }, [a], false);
        await expect(splitPane(h, "row")).rejects.toThrow(/not connected/);
    });

    it("sizes the new terminal at about half the source along the split", () => {
        expect(splitSize(info("a", { cols: 120, rows: 40 }), "row")).toEqual({ cols: 59, rows: 40 });
        expect(splitSize(info("a", { cols: 120, rows: 40 }), "column")).toEqual({ cols: 120, rows: 19 });
        expect(splitSize(info("a", { cols: 30, rows: 8 }), "row")).toEqual({ cols: 20, rows: 8 });
        expect(splitSize(undefined, "row")).toEqual({ cols: 80, rows: 24 });
    });
});

describe("closing a pane", () => {
    it("hangs up the terminal, then removes the leaf and focuses the pane on the freed edge", async () => {
        const ids = ["a", "b", "c"];
        const node = fakeNode(ids.map((id) => info(id)));
        const tree = split("row", leaf("a"), split("column", leaf("b"), leaf("c")));
        const { host: h, state } = host(node, { tree, focused: "a" }, []);
        await closePane(h, "a");
        expect(node.calls).toEqual([{ type: "term.kill", params: { terminalId: "a", signal: "SIGHUP" } }]);
        expect(state.tab).toEqual({ tree: split("column", leaf("b"), leaf("c")), focused: "b" });
    });

    it("keeps focus where it is when another pane closes", async () => {
        const node = fakeNode([info("a"), info("b"), info("c")]);
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), split("column", leaf("b"), leaf("c"))), focused: "c" }, []);
        await closePane(h, "a");
        expect(state.tab?.focused).toBe("c");
    });

    it("asks the caller to close the tab when its last pane closes", async () => {
        const node = fakeNode([info("a")]);
        const { host: h, state } = host(node, { tree: leaf("a"), focused: "a" }, []);
        await closePane(h, "a");
        expect(state.closed).toBe(1);
        expect(state.tab).toBeUndefined();
    });

    it("removes the pane of a terminal the node no longer has, and keeps it on any other failure", async () => {
        const node = fakeNode([info("a"), info("b")]);
        node.forget("b");
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "b" }, []);
        await closePane(h, "b");
        expect(state.tab).toEqual({ tree: leaf("a"), focused: "a" });

        const offline = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, [], false);
        await expect(closePane(offline.host, "b")).rejects.toThrow(/not connected/);
        expect(leaves(offline.state.tab!.tree)).toEqual(["a", "b"]);
    });
});

describe("node events", () => {
    it("remove the pane of a terminal that exits on its own, or is removed", () => {
        const node = fakeNode([]);
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), split("column", leaf("b"), leaf("c"))), focused: "b" }, []);
        paneEvent(h, { type: "term.exit", terminalId: "b", code: 0, signal: null });
        expect(state.tab).toEqual({ tree: split("row", leaf("a"), leaf("c")), focused: "c" });
        paneEvent(h, { type: "term.removed", terminalId: "a" });
        expect(state.tab).toEqual({ tree: leaf("c"), focused: "c" });
        // Other events and other terminals change nothing.
        paneEvent(h, { type: "term.title", terminalId: "c", title: "vim" } as NodeEvent);
        paneEvent(h, { type: "term.exit", terminalId: "elsewhere", code: 0, signal: null });
        expect(state.tab).toEqual({ tree: leaf("c"), focused: "c" });
        paneEvent(h, { type: "term.exit", terminalId: "c", code: 1, signal: null });
        expect(state.closed).toBe(1);
    });

    it("are harmless after a close already removed the pane", async () => {
        const node = fakeNode([info("a"), info("b")]);
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, []);
        await closePane(h, "b");
        paneEvent(h, { type: "term.exit", terminalId: "b", code: null, signal: "SIGHUP" });
        paneEvent(h, { type: "term.removed", terminalId: "b" });
        expect(state.tab).toEqual({ tree: leaf("a"), focused: "a" });
        expect(state.closed).toBe(0);
    });
});

describe("pruning a restored tab", () => {
    it("keeps the panes whose terminals remain, focus moved off the gone ones", () => {
        const tab: PaneTab = { tree: split("row", leaf("a"), split("column", leaf("b"), leaf("c"))), focused: "a" };
        expect(prunePanes(tab, (id) => id !== "a")).toEqual({ tree: split("column", leaf("b"), leaf("c")), focused: "b" });
        expect(prunePanes(tab, () => true)).toBe(tab);
        expect(prunePanes(tab, () => false)).toBeUndefined();
    });
});
