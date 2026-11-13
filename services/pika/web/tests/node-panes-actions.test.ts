import { describe, expect, it } from "vitest";
import { NodeRequestError } from "../src/nodes/channel";
import type { NodeEvent, Requests, RequestType, Results, TerminalInfo } from "../src/nodes/contract";
import { ClosedPanes, closePane, keepsPaneOnExit, paneEvent, prunePanes, removePane, rerunPane, shellPane, splitPane, splitSize, type PaneHost, type PaneTab } from "../src/nodes/panes/actions";
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

/**
 * A node with terminals, answering `term.cwd`, `term.create`, `term.kill`, and `term.restart` the way the daemon does:
 * `term.kill` on a terminal that has exited (`exit`) removes it, and `term.restart` replaces one.
 */
function fakeNode(terminals: TerminalInfo[], live: Record<string, string> = {}) {
    const calls: Call[] = [];
    let next = 1;
    const gates: (() => void)[] = [];
    let hold: RequestType | undefined;
    const known = new Map(terminals.map((item) => [item.terminalId, item]));
    const exited = new Set<string>();
    const request = async <K extends RequestType>(type: K, params: Requests[K]): Promise<Results[K]> => {
        calls.push({ type, params });
        // The daemon acts on the request, and the reply comes later.
        const acted = type === "term.kill" ? kill((params as Requests["term.kill"]).terminalId) : undefined;
        if (hold === type) await new Promise<void>((resolve) => gates.push(resolve));
        if (acted) throw acted;
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
            case "term.kill":
                return {} as Results[K];
            case "term.restart": {
                const { terminalId } = params as Requests["term.restart"];
                const old = known.get(terminalId);
                if (!old) throw new NodeRequestError({ code: "not_found", message: `no terminal ${terminalId}` });
                if (!exited.has(terminalId)) throw new NodeRequestError({ code: "busy", message: "the terminal is still running" });
                const { exited: _gone, ...rest } = old;
                const terminal = { ...rest, terminalId: `new${next++}` };
                known.delete(terminalId);
                known.set(terminal.terminalId, terminal);
                return { terminal } as Results[K];
            }
            default:
                throw new Error(`unexpected ${type}`);
        }
    };
    function kill(terminalId: string): NodeRequestError | undefined {
        if (!known.has(terminalId)) return new NodeRequestError({ code: "not_found", message: `no terminal ${terminalId}` });
        if (exited.has(terminalId)) known.delete(terminalId);
        return undefined;
    }
    return {
        calls,
        channel: { request },
        /** Holds the replies to `type` (default `term.create`) until `release`. */
        hold: (type: RequestType = "term.create") => (hold = type),
        release: () => {
            hold = undefined;
            for (const gate of gates.splice(0)) gate();
        },
        forget: (terminalId: string) => known.delete(terminalId),
        /** The terminal's process ends: it stays listed, exited. */
        exit: (terminalId: string) => exited.add(terminalId),
        listed: (terminalId: string) => known.has(terminalId),
    };
}

function host(node: ReturnType<typeof fakeNode>, tab: PaneTab | undefined, terminals: TerminalInfo[], connected = true) {
    const state = { tab, closed: 0, errors: [] as unknown[] };
    const byId = new Map(terminals.map((item) => [item.terminalId, item]));
    const client = { channel: (id: string) => (connected && id === "n1" ? node.channel : undefined) };
    const value: PaneHost = {
        client,
        node: "n1",
        closed: new ClosedPanes(client, (error) => state.errors.push(error)),
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

describe("setup terminals", () => {
    const setup = (terminalId: string, more: Partial<TerminalInfo> = {}) =>
        info(terminalId, { argv: ["sh", "-c", "npm ci"], cwd: "/w/app-fix", worktreePath: "/w/app-fix", checkoutId: "c".repeat(32), role: "setup", cols: 100, rows: 30, ...more });

    it("keep their pane when they exit; other terminals still lose theirs", () => {
        expect(keepsPaneOnExit(setup("s"))).toBe(true);
        expect(keepsPaneOnExit(info("a"))).toBe(false);
        expect(keepsPaneOnExit(info("a", { role: "later" }))).toBe(false);
        expect(keepsPaneOnExit(undefined)).toBe(false);
        const node = fakeNode([]);
        const { host: h, state } = host(node, { tree: split("row", leaf("s"), leaf("a")), focused: "s" }, [setup("s"), info("a")]);
        paneEvent(h, { type: "term.exit", terminalId: "s", code: 1, signal: null });
        expect(state.tab).toEqual({ tree: split("row", leaf("s"), leaf("a")), focused: "s" });
        paneEvent(h, { type: "term.exit", terminalId: "a", code: 0, signal: null });
        expect(state.tab).toEqual({ tree: leaf("s"), focused: "s" });
        // Removed from the node (Close, Remove, another browser), the pane goes all the same.
        paneEvent(h, { type: "term.removed", terminalId: "s" });
        expect(state.closed).toBe(1);
    });

    it("hand their pane to the terminal that replaced them, without taking focus", () => {
        const node = fakeNode([]);
        const { host: h, state } = host(node, { tree: split("row", leaf("s"), leaf("a")), focused: "a" }, [setup("s"), info("a")]);
        paneEvent(h, { type: "term.removed", terminalId: "s", replacedBy: "s2" });
        expect(state.tab).toEqual({ tree: split("row", leaf("s2"), leaf("a")), focused: "a" });
        // A focused pane keeps focus on its successor.
        const focused = host(node, { tree: leaf("s"), focused: "s" }, [setup("s")]);
        paneEvent(focused.host, { type: "term.removed", terminalId: "s", replacedBy: "s2" });
        expect(focused.state.tab).toEqual({ tree: leaf("s2"), focused: "s2" });
        // A tab that already shows the successor just loses the old pane.
        const both = host(node, { tree: split("row", leaf("s"), leaf("s2")), focused: "s" }, []);
        paneEvent(both.host, { type: "term.removed", terminalId: "s", replacedBy: "s2" });
        expect(both.state.tab).toEqual({ tree: leaf("s2"), focused: "s2" });
    });

    it("rerun in their pane through term.restart, with focus", async () => {
        const s = setup("s", { exited: { code: 1, signal: null } });
        const node = fakeNode([s, info("a")]);
        node.exit("s");
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("s")), focused: "a" }, [s, info("a")]);
        const created = await rerunPane(h, "s");
        expect(created).toMatchObject({ terminalId: "new1", role: "setup", argv: ["sh", "-c", "npm ci"], cwd: "/w/app-fix" });
        expect(node.calls).toEqual([{ type: "term.restart", params: { terminalId: "s" } }]);
        expect(state.tab).toEqual({ tree: split("row", leaf("a"), leaf("new1")), focused: "new1" });
        expect(node.listed("s")).toBe(false);
        // The node's term.removed { replacedBy } that follows changes nothing more.
        paneEvent(h, { type: "term.removed", terminalId: "s", replacedBy: "new1" });
        expect(state.tab).toEqual({ tree: split("row", leaf("a"), leaf("new1")), focused: "new1" });
        // A live terminal is refused, and its pane stays.
        await expect(rerunPane(h, "a")).rejects.toMatchObject({ code: "busy" });
        expect(state.tab).toEqual({ tree: split("row", leaf("a"), leaf("new1")), focused: "new1" });
    });

    it("open a shell in their worktree in their pane, then leave the node's list", async () => {
        const s = setup("s", { exited: { code: 1, signal: null } });
        const node = fakeNode([s]);
        node.exit("s");
        const { host: h, state } = host(node, { tree: split("column", leaf("s"), leaf("a")), focused: "a" }, [s]);
        const created = await shellPane(h, "s");
        expect(created?.terminalId).toBe("new1");
        expect(node.calls).toEqual([
            { type: "term.create", params: { cols: 100, rows: 30, cwd: "/w/app-fix" } },
            { type: "term.kill", params: { terminalId: "s" } },
        ]);
        expect(state.tab).toEqual({ tree: split("column", leaf("new1"), leaf("a")), focused: "new1" });
        expect(node.listed("s")).toBe(false);
    });

    it("keep the exited terminal and hang the shell up when the tab closed while it started", async () => {
        const s = setup("s", { exited: { code: 1, signal: null } });
        const node = fakeNode([s]);
        node.exit("s");
        const { host: h, state } = host(node, { tree: leaf("s"), focused: "s" }, [s]);
        node.hold();
        const pending = shellPane(h, "s");
        state.tab = undefined;
        node.release();
        expect(await pending).toBeUndefined();
        expect(node.calls.at(-1)).toEqual({ type: "term.kill", params: { terminalId: "new1", signal: "SIGHUP" } });
        expect(node.listed("s")).toBe(true);
    });

    it("close their pane and leave the node's list", async () => {
        const s = setup("s", { exited: { code: 0, signal: null } });
        const node = fakeNode([s, info("a")]);
        node.exit("s");
        const { host: h, state } = host(node, { tree: split("row", leaf("s"), leaf("a")), focused: "s" }, [s, info("a")]);
        await closePane(h, "s");
        expect(state.tab).toEqual({ tree: leaf("a"), focused: "a" });
        expect(node.listed("s")).toBe(false);
    });
});

describe("a closed pane's terminal", () => {
    /** What the page does with each node event: `ClosedPanes` first, then the tab's panes. */
    const feed = (h: PaneHost, event: NodeEvent) => {
        h.closed.event("n1", event);
        paneEvent(h, event);
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const exit = (terminalId: string): NodeEvent => ({ type: "term.exit", terminalId, code: null, signal: "SIGHUP" });

    it("leaves the node's list once it exits after the hang-up", async () => {
        const node = fakeNode([info("a"), info("b")]);
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, []);
        await closePane(h, "a");
        expect(node.listed("a")).toBe(true);
        node.exit("a");
        feed(h, exit("a"));
        await settle();
        expect(node.calls).toEqual([
            { type: "term.kill", params: { terminalId: "a", signal: "SIGHUP" } },
            { type: "term.kill", params: { terminalId: "a" } },
        ]);
        expect(node.listed("a")).toBe(false);
        expect(state.tab).toEqual({ tree: leaf("b"), focused: "b" });
        expect(state.errors).toEqual([]);
        // Once: a second exit or the removal sends nothing more.
        feed(h, exit("a"));
        feed(h, { type: "term.removed", terminalId: "a" });
        await settle();
        expect(node.calls).toHaveLength(2);
    });

    it("leaves the list when its exit arrives before the hang-up's reply", async () => {
        const node = fakeNode([info("a"), info("b")]);
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, []);
        node.hold("term.kill");
        const closing = closePane(h, "a");
        node.exit("a");
        feed(h, exit("a"));
        await settle();
        expect(node.calls.map((call) => call.params)).toEqual([{ terminalId: "a", signal: "SIGHUP" }, { terminalId: "a" }]);
        expect(node.listed("a")).toBe(false);
        node.release();
        await closing;
        expect(state.tab).toEqual({ tree: leaf("b"), focused: "b" });
        expect(state.errors).toEqual([]);
    });

    it("leaves the list when it had exited before the hang-up reached it", async () => {
        const node = fakeNode([info("a"), info("b")]);
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, []);
        // The exit event is still on its way when the user closes the pane: the hang-up itself removes the terminal.
        node.exit("a");
        await closePane(h, "a");
        expect(node.listed("a")).toBe(false);
        feed(h, exit("a"));
        await settle();
        expect(node.calls).toHaveLength(2);
        expect(state.errors).toEqual([]);
    });

    it("stays listed, exited, when it ends on its own", async () => {
        const node = fakeNode([info("a"), info("b")]);
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, []);
        node.exit("b");
        feed(h, { type: "term.exit", terminalId: "b", code: 0, signal: null });
        await settle();
        expect(node.calls).toEqual([]);
        expect(node.listed("b")).toBe(true);
        expect(state.tab).toEqual({ tree: leaf("a"), focused: "a" });
    });

    it("is not marked when the hang-up failed", async () => {
        const node = fakeNode([info("a"), info("b")]);
        node.forget("b");
        const { host: h } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, []);
        await closePane(h, "b");
        feed(h, exit("b"));
        await settle();
        expect(node.calls).toEqual([{ type: "term.kill", params: { terminalId: "b", signal: "SIGHUP" } }]);
    });

    it("reports a removal that fails", async () => {
        const node = fakeNode([info("a"), info("b")]);
        const { host: h, state } = host(node, { tree: split("row", leaf("a"), leaf("b")), focused: "a" }, []);
        await closePane(h, "a");
        const failing = new ClosedPanes({ channel: () => ({ request: async () => Promise.reject(new Error("boom")) }) }, (error) => state.errors.push(error));
        failing.mark("n1", "a");
        failing.event("n1", exit("a"));
        await settle();
        expect(state.errors.map((error) => (error as Error).message)).toEqual(["boom"]);
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
