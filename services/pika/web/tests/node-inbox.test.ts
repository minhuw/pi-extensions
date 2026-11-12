import { describe, expect, it } from "vitest";
import type { NodeView } from "../src/nodes/client";
import type { PaneView, TerminalInfo } from "../src/nodes/contract";
import {
	attentionText,
	childActivities,
	elapsed,
	flatLayout,
	holdLayout,
	inboxBadge,
	InboxTracker,
	layoutInbox,
	nextNeeding,
	nodeLinkState,
	rawSection,
	shortAgo,
	STALE_MS,
	stepKey,
	WORKING_EXIT_GRACE_MS,
	type InboxEntry,
} from "../src/nodes/workspace/inbox";

const terminal = (id: string, status?: Partial<PaneView>, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
	terminalId: id,
	title: id,
	cwd: "/home/me",
	cols: 80,
	rows: 24,
	pid: 1,
	createdAt: 0,
	argv: ["pi"],
	...(status ? { status: { state: "idle", bridgeConnected: false, unread: false, ...status } } : {}),
	...extra,
});

const entry = (info: TerminalInfo, node = "n1"): InboxEntry => ({ key: `${node}\n${info.terminalId}`, terminal: info });

describe("rawSection", () => {
	it("sorts by what the user has to do", () => {
		expect(rawSection(terminal("a", { state: "waiting" }))).toBe("needs");
		expect(rawSection(terminal("a", { state: "waiting", program: { state: "blocked", app: "pi", kind: "permission", at: 1 } }))).toBe("needs");
		expect(rawSection(terminal("a", { state: "idle", unread: true, program: { state: "error", app: "pi", at: 1 } }))).toBe("failed");
		expect(rawSection(terminal("a", {}, { exited: { code: 2, signal: null } }))).toBe("failed");
		expect(rawSection(terminal("a", { state: "busy" }))).toBe("working");
		expect(rawSection(terminal("a", { state: "idle", unread: true }))).toBe("done");
		expect(rawSection(terminal("a", { state: "idle" }))).toBe("quiet");
		expect(rawSection(terminal("a"))).toBe("quiet");
	});

	it("puts a terminal that ended by itself or by a signal in quiet", () => {
		expect(rawSection(terminal("a", undefined, { exited: { code: 0, signal: null } }))).toBe("quiet");
		expect(rawSection(terminal("a", undefined, { exited: { code: null, signal: "SIGHUP" } }))).toBe("quiet");
	});
});

describe("InboxTracker", () => {
	it("keeps an agent that stops working in Working for the 2 s grace, then returns it to the user", () => {
		const tracker = new InboxTracker();
		tracker.observe([entry(terminal("a", { state: "busy" }))], 1_000);
		const during = tracker.observe([entry(terminal("a", { state: "idle", unread: true }))], 2_000);
		expect(during.placements.get("n1\na")).toMatchObject({ section: "working", held: true });
		expect(during.nextAt).toBe(2_000 + WORKING_EXIT_GRACE_MS);
		// A new turn inside the grace: it never left, so its working time still counts from the first sight (createdAt).
		const back = tracker.observe([entry(terminal("a", { state: "busy" }))], 3_000);
		expect(back.placements.get("n1\na")).toMatchObject({ section: "working", held: false, since: 0 });
		tracker.observe([entry(terminal("a", { state: "idle", unread: true }))], 4_000);
		const after = tracker.observe([entry(terminal("a", { state: "idle", unread: true }))], 4_000 + WORKING_EXIT_GRACE_MS);
		expect(after.placements.get("n1\na")).toMatchObject({ section: "done", held: false, since: 4_000 + WORKING_EXIT_GRACE_MS });
		expect(after.nextAt).toBeUndefined();
	});

	it("shows needing the user, a failure, and an exit at once, with no grace", () => {
		const tracker = new InboxTracker();
		tracker.observe([entry(terminal("a", { state: "busy" })), entry(terminal("b", { state: "busy" })), entry(terminal("c", { state: "busy" }))], 0);
		const next = tracker.observe(
			[
				entry(terminal("a", { state: "waiting" })),
				entry(terminal("b", { state: "idle", unread: true, program: { state: "error", app: "pi", at: 1 } })),
				entry(terminal("c", { state: "idle" }, { exited: { code: 0, signal: null } })),
			],
			500,
		);
		expect(next.placements.get("n1\na")?.section).toBe("needs");
		expect(next.placements.get("n1\nb")?.section).toBe("failed");
		expect(next.placements.get("n1\nc")?.section).toBe("quiet");
		expect(next.nextAt).toBeUndefined();
	});

	it("keeps a seen done agent in Done while it is selected, and lets it go when the user moves away", () => {
		const tracker = new InboxTracker();
		tracker.observe([entry(terminal("a", { state: "idle", unread: true }))], 0, "n1\na");
		const seen = tracker.observe([entry(terminal("a", { state: "idle" }))], 100, "n1\na");
		expect(seen.placements.get("n1\na")).toMatchObject({ section: "done", held: true, since: 0 });
		const away = tracker.observe([entry(terminal("a", { state: "idle" }))], 200, "n1\nb");
		expect(away.placements.get("n1\na")).toMatchObject({ section: "quiet", held: false, since: 200 });
	});

	it("does not hold an agent that was not in Done when it was opened", () => {
		const tracker = new InboxTracker();
		tracker.observe([entry(terminal("a", { state: "idle" }))], 0, "n1\na");
		expect(tracker.observe([entry(terminal("a", { state: "idle" }))], 10, "n1\na").placements.get("n1\na")?.section).toBe("quiet");
	});

	it("dates a first sight from the status's own time, never later than now", () => {
		const tracker = new InboxTracker();
		const placed = tracker.observe(
			[
				entry(terminal("a", { state: "waiting", program: { state: "blocked", app: "pi", at: 5_000 } })),
				entry(terminal("b", { state: "idle" }, { createdAt: 3_000 })),
				entry(terminal("c", { state: "waiting", program: { state: "blocked", app: "pi", at: 99_000 } })),
			],
			10_000,
		);
		expect(placed.placements.get("n1\na")?.since).toBe(5_000);
		expect(placed.placements.get("n1\nb")?.since).toBe(3_000);
		expect(placed.placements.get("n1\nc")?.since).toBe(10_000);
	});

	it("marks a working agent stale after 30 minutes without a change", () => {
		const tracker = new InboxTracker();
		const busy = terminal("a", { state: "busy", program: { state: "working", app: "pi", at: 0 } });
		expect(tracker.observe([entry(busy)], 1_000).placements.get("n1\na")?.stale).toBe(false);
		expect(tracker.observe([entry(busy)], STALE_MS).placements.get("n1\na")?.stale).toBe(true);
		// A change (a new program status) freshens it.
		const fresh = terminal("a", { state: "busy", program: { state: "working", app: "pi", at: STALE_MS } });
		expect(tracker.observe([entry(fresh)], STALE_MS + 1).placements.get("n1\na")?.stale).toBe(false);
	});

	it("forgets agents that are gone", () => {
		const tracker = new InboxTracker();
		tracker.observe([entry(terminal("a", { state: "busy" }))], 0);
		tracker.observe([], 10);
		// Seen again: a first sight, so no grace from the old working.
		expect(tracker.observe([entry(terminal("a", { state: "idle", unread: true }))], 20).placements.get("n1\na")?.section).toBe("done");
	});
});

describe("layoutInbox", () => {
	it("orders returns newest first and working by creation", () => {
		const tracker = new InboxTracker();
		const entries = [
			entry(terminal("w2", { state: "busy" }, { createdAt: 20 })),
			entry(terminal("w1", { state: "busy" }, { createdAt: 10 })),
			entry(terminal("d1", { state: "idle", unread: true, program: { state: "done", app: "pi", at: 100 } })),
			entry(terminal("d2", { state: "idle", unread: true, program: { state: "done", app: "pi", at: 300 } })),
			entry(terminal("n1", { state: "waiting", program: { state: "blocked", app: "pi", at: 50 } }), "n2"),
		];
		const { placements } = tracker.observe(entries, 1_000);
		const layout = layoutInbox(entries, placements);
		expect(layout).toEqual({ needs: ["n2\nn1"], failed: [], done: ["n1\nd2", "n1\nd1"], working: ["n1\nw1", "n1\nw2"], quiet: [] });
		expect(flatLayout(layout)).toEqual(["n2\nn1", "n1\nd2", "n1\nd1", "n1\nw1", "n1\nw2"]);
	});
});

describe("holdLayout", () => {
	it("keeps placed rows where they were and adds new ones at the end of their section", () => {
		const previous = { needs: ["a"], failed: [], done: ["b", "c"], working: ["d"], quiet: [] };
		const next = { needs: ["d", "a"], failed: [], done: ["e", "c"], working: [], quiet: ["b"] };
		expect(holdLayout(previous, next)).toEqual({ needs: ["a"], failed: [], done: ["b", "c", "e"], working: ["d"], quiet: [] });
	});

	it("drops rows that are gone", () => {
		expect(holdLayout({ needs: ["a", "b"], failed: [], done: [], working: [], quiet: [] }, { needs: ["b"], failed: [], done: [], working: [], quiet: [] }).needs).toEqual(["b"]);
	});
});

describe("moving between agents", () => {
	const layout = { needs: ["a", "c"], failed: ["f"], done: [], working: ["w"], quiet: ["q"] };

	it("steps in the rail's order, wrapping", () => {
		const order = flatLayout(layout);
		expect(stepKey(order, "q", 1)).toBe("a");
		expect(stepKey(order, "a", -1)).toBe("q");
		expect(stepKey(order, undefined, 1)).toBe("a");
		expect(stepKey(order, undefined, -1)).toBe("q");
		expect(stepKey([], undefined, 1)).toBeUndefined();
	});

	it("finds the next agent needing the user", () => {
		expect(nextNeeding(layout, undefined)).toBe("a");
		expect(nextNeeding(layout, "a")).toBe("c");
		expect(nextNeeding(layout, "c")).toBe("a");
		expect(nextNeeding(layout, "w")).toBe("a");
		expect(nextNeeding({ ...layout, needs: ["a"] }, "a")).toBeUndefined();
	});
});

describe("time", () => {
	it("says ages compactly", () => {
		expect(shortAgo(0, 59_000)).toBe("now");
		expect(shortAgo(0, 5 * 60_000)).toBe("5m");
		expect(shortAgo(0, 3 * 3_600_000 + 1)).toBe("3h");
		expect(shortAgo(0, 50 * 3_600_000)).toBe("2d");
	});

	it("ticks durations", () => {
		expect(elapsed(0, 14_000)).toBe("14s");
		expect(elapsed(0, 134_000)).toBe("2m14s");
		expect(elapsed(0, 3_900_000)).toBe("1h05m");
		expect(elapsed(0, 27 * 3_600_000)).toBe("1d3h");
		expect(elapsed(10, 0)).toBe("0s");
	});
});

describe("what a row says", () => {
	const placed = (section: "needs" | "failed" | "working", stale = false) => ({ section, since: 0, changedAt: 0, held: false, stale });

	it("names a waiting dialog's message or the activity that waits", () => {
		const dialog = terminal("a", { state: "waiting", program: { state: "blocked", app: "pi", kind: "permission", message: "Import session?", at: 1 } });
		expect(attentionText(dialog, placed("needs"), 0)).toBe("Import session?");
		const activity = terminal("a", {
			state: "waiting",
			bridgeConnected: true,
			bridge: { state: "busy", activities: [{ source: "subagents", id: "s1", label: "reviewer", state: "waiting" }], activityCount: 1, updatedAt: 1 },
		});
		expect(attentionText(activity, placed("needs"), 0)).toBe("reviewer is waiting");
	});

	it("says why an agent failed and when a working one went silent", () => {
		expect(attentionText(terminal("a", undefined, { exited: { code: 3, signal: null } }), placed("failed"), 0)).toBe("Exited with code 3");
		expect(attentionText(terminal("a", { state: "busy" }), placed("working", true), 34 * 60_000)).toBe("No update in 34m");
		expect(attentionText(terminal("a", { state: "busy" }), placed("working"), 0)).toBeUndefined();
	});

	it("lists a live bridge's activities, waiting first, and none from a closed bridge", () => {
		const bridge = {
			state: "busy" as const,
			activities: [
				{ source: "s", id: "1", label: "one" },
				{ source: "s", id: "2", label: "two", state: "waiting" as const },
			],
			activityCount: 2,
			updatedAt: 1,
		};
		expect(childActivities(terminal("a", { state: "busy", bridgeConnected: true, bridge })).map((item) => item.id)).toEqual(["2", "1"]);
		expect(childActivities(terminal("a", { state: "busy", bridgeConnected: false, bridge }))).toEqual([]);
	});
});

describe("nodes and the badge", () => {
	const view = (link: NodeView["link"], online = true, pin = true): NodeView => ({
		info: { id: "n", name: "n", online },
		...(pin ? { pin: { node: "n", fingerprint: "f", publicKey: "k", name: "n", pinnedAt: 0 } } : {}),
		link,
		terminals: [],
		listed: false,
		epoch: 0,
	});

	it("marks a node by its link", () => {
		expect(nodeLinkState(view({ kind: "opening" }))).toBe("connecting");
		expect(nodeLinkState(view({ kind: "idle" }, false))).toBe("offline");
		expect(nodeLinkState(view({ kind: "idle" }, true, false))).toBe("unpaired");
		expect(nodeLinkState(view({ kind: "closed", code: "node_key_changed" }))).toBe("error");
		expect(nodeLinkState(view({ kind: "closed", code: "disconnected" }))).toBe("connecting");
	});

	it("counts what needs the user, else what works", () => {
		expect(inboxBadge({ needs: ["a"], failed: ["b"], done: ["c"], working: ["d"], quiet: [] })).toEqual({ kind: "attention", count: 2 });
		expect(inboxBadge({ needs: [], failed: [], done: [], working: ["d", "e"], quiet: [] })).toEqual({ kind: "working", count: 2 });
		expect(inboxBadge({ needs: [], failed: [], done: ["c"], working: [], quiet: ["q"] })).toBeUndefined();
	});
});
