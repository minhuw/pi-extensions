/**
 * Splitting and closing the panes of a terminal tab: the daemon side (`term.create`, `term.kill`) and the tree side
 * together. The workspace keeps each tab's `PaneTab` and calls these through a `PaneHost`; nothing here knows React.
 *
 * After Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
 * `src/renderer/src/components/terminal-pane/layout/split/terminal-pane-split-with-inherited-cwd.ts` (a split starts
 * where the source pane's shell is now) and `src/renderer/src/lib/pane-manager/pane-layout/pane-split-close.ts` (the
 * new pane takes focus; a closed pane's focus goes to its successor).
 */
import { NodeRequestError, type NodeChannel } from "../channel";
import { paneCwd } from "../client";
import { SETUP_ROLE, type NodeEvent, type TerminalInfo } from "../contract";
import { closeLeaf, focusSuccessorOnClose, hasLeaf, leaves, replaceLeaf, splitLeaf, type PaneDirection, type PaneTree } from "./pane-tree";

/** A tab's panes and which one has focus (always one of its leaves). */
export interface PaneTab {
    tree: PaneTree;
    focused: string;
}

/** What the actions need of `NodesClient`: its ready channel to a node (`NodesClient.channel`). */
export interface PaneClient {
    channel(node: string): Pick<NodeChannel, "request"> | undefined;
}

export interface PaneHost {
    client: PaneClient;
    /** The node the tab's terminals run on. */
    node: string;
    /** The tab's panes now, read again after every request; undefined once the tab is gone. */
    read(): PaneTab | undefined;
    write(tab: PaneTab): void;
    /** The tab's last pane closed: the caller closes the tab (the actions never do). */
    closeTab(): void;
    /** The node's terminal (`NodeView.terminals`), for where it is and its size. */
    terminal(terminalId: string): TerminalInfo | undefined;
    /** The page's record of the terminals its pane closes hung up, which go from the node's list once they exit. */
    closed: ClosedPanes;
}

/**
 * Terminals this page hung up by closing their pane. Once one exits (`term.exit`), it is removed from the node's list
 * (`term.kill` on an exited terminal; NODE.md "term.kill"), so it leaves the agent list too; a terminal that exits
 * on its own stays listed with its last screen until the user removes it. A terminal is marked before its hang-up
 * is sent, so an exit that arrives before the hang-up's reply is caught all the same. Feed it every node event
 * (`NodesClient.onEvent`), whether or not a tab still shows the terminal.
 */
export class ClosedPanes {
    readonly #client: PaneClient;
    readonly #onError: (error: unknown) => void;
    readonly #marked = new Set<string>();

    constructor(client: PaneClient, onError: (error: unknown) => void) {
        this.#client = client;
        this.#onError = onError;
    }

    /** Marks `terminalId` on `node` as closed by a pane; the returned function takes the mark back. */
    mark(node: string, terminalId: string): () => void {
        const key = keyOf(node, terminalId);
        this.#marked.add(key);
        return () => this.#marked.delete(key);
    }

    event(node: string, event: NodeEvent): void {
        if (event.type !== "term.exit" && event.type !== "term.removed") return;
        const key = keyOf(node, event.terminalId);
        if (!this.#marked.delete(key) || event.type === "term.removed") return;
        const channel = this.#client.channel(node);
        if (!channel) return this.#onError(new Error("The node is not connected: remove the exited terminal by hand."));
        // `not_found`: the hang-up reached a terminal that had already exited, which removed it.
        channel.request("term.kill", { terminalId: event.terminalId }).catch((error: unknown) => {
            if (!(error instanceof NodeRequestError && error.code === "not_found")) this.#onError(error);
        });
    }
}

function keyOf(node: string, terminalId: string): string {
    return `${node}\n${terminalId}`;
}

const DEFAULT_SIZE = { cols: 80, rows: 24 };

function channelOf(host: PaneHost): Pick<NodeChannel, "request"> {
    const channel = host.client.channel(host.node);
    if (!channel) throw new Error("The node is not connected.");
    return channel;
}

/** About half the source terminal along the split: the terminal layer fits the new one to its slot once it shows. */
export function splitSize(source: TerminalInfo | undefined, direction: PaneDirection): { cols: number; rows: number } {
    if (!source) return DEFAULT_SIZE;
    return direction === "row"
        ? { cols: Math.max(20, Math.floor((source.cols - 1) / 2)), rows: source.rows }
        : { cols: source.cols, rows: Math.max(5, Math.floor((source.rows - 1) / 2)) };
}

/** A terminal's directory now, for one the page has not listed yet (a pane split moments ago); undefined without an answer. */
async function liveCwd(channel: Pick<NodeChannel, "request">, terminalId: string): Promise<string | undefined> {
    try {
        const { cwd } = await channel.request("term.cwd", { terminalId });
        return cwd.startsWith("/") ? cwd : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Splits the focused pane: a new terminal on the node, started where the focused pane's shell is now (`term.cwd`,
 * else where it started; `paneCwd`), right of it ("row") or below it ("column"), with focus. Returns the new terminal,
 * or undefined when the tab closed while it started, after killing it: a pane nobody can see is not left running.
 * When the focused pane closed meanwhile, the new pane goes next to the one focused now.
 */
export async function splitPane(host: PaneHost, direction: PaneDirection, place: "after" | "before" = "after"): Promise<TerminalInfo | undefined> {
    const tab = host.read();
    if (!tab) throw new Error("The tab is gone.");
    const channel = channelOf(host);
    const source = host.terminal(tab.focused);
    const cwd = source ? await paneCwd((type, params) => channel.request(type, params), source) : await liveCwd(channel, tab.focused);
    const { terminal } = await channel.request("term.create", { ...splitSize(source, direction), ...(cwd ? { cwd } : {}) });
    const now = host.read();
    if (!now) {
        await channel.request("term.kill", { terminalId: terminal.terminalId, signal: "SIGHUP" }).catch(() => {});
        return undefined;
    }
    const target = hasLeaf(now.tree, tab.focused) ? tab.focused : now.focused;
    host.write({ tree: splitLeaf(now.tree, target, direction, terminal.terminalId, place), focused: terminal.terminalId });
    return terminal;
}

/**
 * Closes a pane: hangs up its terminal (`term.kill` with SIGHUP, as closing a terminal window does; an interactive
 * shell ignores SIGTERM), then removes its leaf (`removePane`). The terminal is marked in `host.closed`, so once it
 * exits it leaves the node's list. A terminal the node no longer has is removed all the same; any other failure
 * throws and the pane stays.
 */
export async function closePane(host: PaneHost, terminalId: string): Promise<void> {
    const channel = channelOf(host);
    const unmark = host.closed.mark(host.node, terminalId);
    try {
        await channel.request("term.kill", { terminalId, signal: "SIGHUP" });
    } catch (error) {
        unmark();
        if (!(error instanceof NodeRequestError && error.code === "not_found")) throw error;
    }
    removePane(host, terminalId);
}

/**
 * Takes `terminalId`'s pane out of the tab without touching the terminal: its sibling takes the space, and focus,
 * if it was there, goes to `focusSuccessorOnClose`. The last pane going asks the caller to close the tab. A terminal
 * without a pane here changes nothing.
 */
export function removePane(host: PaneHost, terminalId: string): void {
    const tab = host.read();
    if (!tab || !hasLeaf(tab.tree, terminalId)) return;
    const next = withoutPane(tab, terminalId);
    if (next) host.write(next);
    else host.closeTab();
}

/**
 * `terminalId`'s pane shows `newId` instead, in the same place; focus goes to it when `focus` says so, or when the old
 * pane had it. False, changing nothing, when the tab is gone, has no such pane, or already shows `newId`.
 */
export function replacePane(host: PaneHost, terminalId: string, newId: string, focus: boolean): boolean {
    const tab = host.read();
    if (!tab || !hasLeaf(tab.tree, terminalId) || hasLeaf(tab.tree, newId)) return false;
    host.write({ tree: replaceLeaf(tab.tree, terminalId, newId), focused: focus || tab.focused === terminalId ? newId : tab.focused });
    return true;
}

/** Whether a terminal keeps its pane once it exits: a setup script's (`role: "setup"`), so its last screen stays. */
export const keepsPaneOnExit = (terminal: TerminalInfo | undefined): boolean => terminal?.role === SETUP_ROLE;

/**
 * Runs an exited terminal again (`term.restart`: the same argv, env, and cwd) in its pane, with focus. The node
 * removes the old terminal once the new one is announced (`term.removed` with `replacedBy`). A tab closed meanwhile
 * leaves the new terminal running, listed in the rail. Returns the new terminal.
 */
export async function rerunPane(host: PaneHost, terminalId: string): Promise<TerminalInfo> {
    const { terminal } = await channelOf(host).request("term.restart", { terminalId });
    replacePane(host, terminalId, terminal.terminalId, true);
    return terminal;
}

/**
 * Replaces an exited terminal's pane with a new login shell in its worktree (else where it started), with focus, then
 * removes the exited terminal from the node's list. When the tab closed while the shell started, the shell is hung up
 * and the exited terminal stays; returns undefined then.
 */
export async function shellPane(host: PaneHost, terminalId: string): Promise<TerminalInfo | undefined> {
    const channel = channelOf(host);
    const old = host.terminal(terminalId);
    const cwd = old?.worktreePath ?? old?.cwd;
    const { terminal } = await channel.request("term.create", { ...(old ? { cols: old.cols, rows: old.rows } : DEFAULT_SIZE), ...(cwd ? { cwd } : {}) });
    if (!replacePane(host, terminalId, terminal.terminalId, true)) {
        await channel.request("term.kill", { terminalId: terminal.terminalId, signal: "SIGHUP" }).catch(() => {});
        return undefined;
    }
    try {
        await channel.request("term.kill", { terminalId });
    } catch (error) {
        if (!(error instanceof NodeRequestError && error.code === "not_found")) throw error;
    }
    return terminal;
}

/** `tab` without `terminalId`'s pane, focus moved if it was there; null when that was the last pane. */
function withoutPane(tab: PaneTab, terminalId: string): PaneTab | null {
    const tree = closeLeaf(tab.tree, terminalId);
    if (!tree) return null;
    return { tree, focused: tab.focused === terminalId ? (focusSuccessorOnClose(tab.tree, terminalId) ?? leaves(tree)[0]!) : tab.focused };
}

/**
 * A tab with only the panes whose terminal `keep` accepts (for a restored layout: those the node still lists and
 * that have not exited), focus moved as `removePane` moves it; undefined when none is left.
 */
export function prunePanes(tab: PaneTab, keep: (terminalId: string) => boolean): PaneTab | undefined {
    let now: PaneTab | null = tab;
    for (const terminalId of leaves(tab.tree)) if (now && !keep(terminalId)) now = withoutPane(now, terminalId);
    return now ?? undefined;
}

/**
 * The node's events that end panes: a terminal that exits on its own (`term.exit`), or one removed from the node
 * (`term.removed`), loses its pane. A setup script's terminal keeps its pane when it exits (`keepsPaneOnExit`), and
 * one replaced by `term.restart` (`replacedBy`) hands its pane to its successor, without moving focus. Feed it every
 * event of the tab's node (`NodesClient.onEvent`).
 */
export function paneEvent(host: PaneHost, event: NodeEvent): void {
    if (event.type === "term.exit") {
        if (!keepsPaneOnExit(host.terminal(event.terminalId))) removePane(host, event.terminalId);
    } else if (event.type === "term.removed") {
        if (!(event.replacedBy && replacePane(host, event.terminalId, event.replacedBy, false))) removePane(host, event.terminalId);
    }
}
