import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSession, Entry, SessionTrace } from "../src/lib/types";
import { foldGaps, hitTest, layoutOverview, makeScale, overviewLanes, traceIntervals, type OverviewItem } from "../src/trace/axis";
import { buildHitIndex, hitTestIndex, Overview } from "../src/trace/Overview";
import { assistantMessage, entry, header, iso, summary, toolCall, toolResultMessage, turn, userMessage } from "./support/fixtures";
import { firstRender, mockLayout, renderApp } from "./support/render";
import { createFakeServer, traceOf, type FakeSession } from "./support/server";
import { rows, session } from "./support/trajectory";

const renderCounts = vi.hoisted(() => ({
	ledger: 0,
	timeBreakdown: 0,
	inspector: 0,
}));

vi.mock("../src/trace/Ledger", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/trace/Ledger")>();
	const React = await import("react");
	const OrigLedger = mod.Ledger;
	const TrackedLedger = React.memo(
		React.forwardRef<import("../src/trace/Ledger").LedgerHandle, import("../src/trace/Ledger").LedgerProps>((props, ref) => {
			renderCounts.ledger++;
			return React.createElement(OrigLedger, { ...props, ref });
		}),
	);
	return { ...mod, Ledger: TrackedLedger };
});

vi.mock("../src/trace/TimeBreakdown", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/trace/TimeBreakdown")>();
	const React = await import("react");
	const OrigTimeBreakdown = mod.TimeBreakdown;
	return {
		...mod,
		TimeBreakdown: (props: Parameters<typeof OrigTimeBreakdown>[0]) => {
			renderCounts.timeBreakdown++;
			return React.createElement(OrigTimeBreakdown, props);
		},
	};
});

vi.mock("../src/trace/Inspector", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/trace/Inspector")>();
	const React = await import("react");
	const OrigInspector = mod.Inspector;
	const TrackedInspector = React.forwardRef<HTMLDivElement, Parameters<typeof OrigInspector>[0]>((props, ref) => {
		renderCounts.inspector++;
		return React.createElement(OrigInspector, { ...props, ref });
	});
	return { ...mod, Inspector: TrackedInspector };
});

interface FakeCanvasContext {
	strokeColors: string[];
	strokeRectCalls: number;
	clearRectCalls: number;
	ctx: CanvasRenderingContext2D;
}

function createFakeContext2D(): FakeCanvasContext {
	const record: FakeCanvasContext = {
		strokeColors: [],
		strokeRectCalls: 0,
		clearRectCalls: 0,
		ctx: null as unknown as CanvasRenderingContext2D,
	};
	let strokeStyle = "#000000";
	const noop = () => {};
	const ctx = {
		get strokeStyle() {
			return strokeStyle;
		},
		set strokeStyle(val: string) {
			strokeStyle = val;
		},
		fillStyle: "#000000",
		font: "",
		lineWidth: 1,
		lineCap: "butt",
		lineJoin: "miter",
		globalAlpha: 1,
		textAlign: "left",
		textBaseline: "alphabetic",
		setTransform: noop,
		clearRect: () => {
			record.clearRectCalls++;
		},
		fillRect: noop,
		strokeRect: () => {
			record.strokeRectCalls++;
			record.strokeColors.push(strokeStyle);
		},
		beginPath: noop,
		closePath: noop,
		moveTo: noop,
		lineTo: noop,
		quadraticCurveTo: noop,
		arc: noop,
		rect: noop,
		fill: noop,
		stroke: noop,
		clip: noop,
		save: noop,
		restore: noop,
		setLineDash: noop,
		fillText: noop,
		measureText: (text: string) => ({ width: text.length * 6 }),
	};
	record.ctx = ctx as unknown as CanvasRenderingContext2D;
	return record;
}

function multiLaneTrace(): SessionTrace {
	const c1: ChildSession = {
		...summary("c1", { parentSessionId: "p1", startedAt: iso(3000), lastAt: iso(9000), title: "Worker A" }),
		parentToolCallId: "call_a1",
		link: { kind: "subagent", parentSessionId: "p1", parentToolCallId: "call_a1", agentType: "worker", description: "Worker A" },
	};
	const c2: ChildSession = {
		...summary("c2", { parentSessionId: "p1", startedAt: iso(4000), lastAt: iso(8500), title: "Worker B" }),
		parentToolCallId: "call_a2",
		link: { kind: "subagent", parentSessionId: "p1", parentToolCallId: "call_a2", agentType: "recon", description: "Worker B" },
	};
	const entries: Entry[] = [
		entry(0, header("p1")),
		entry(1, userMessage("Run parallel tools", 1000)),
		entry(
			2,
			assistantMessage(
				[
					toolCall("call_t1", "bash", { command: "echo 1" }),
					toolCall("call_t2", "read", { path: "a.ts" }),
					toolCall("call_t3", "grep", { pattern: "foo" }),
					toolCall("call_a1", "Agent", { subagent_type: "worker" }),
					toolCall("call_a2", "Agent", { subagent_type: "recon" }),
				],
				2000,
				{ durationMs: 1000 },
			),
		),
		entry(3, toolResultMessage("call_t1", "bash", "1", { at: 4500 })),
		entry(4, toolResultMessage("call_t2", "read", "ok", { at: 5000 })),
		entry(5, toolResultMessage("call_t3", "grep", "hit", { at: 5500 })),
		entry(6, toolResultMessage("call_a1", "Agent", "done", { at: 9000 })),
		entry(7, toolResultMessage("call_a2", "Agent", "done", { at: 8500 })),
		entry(8, assistantMessage([{ type: "text", text: "Finished." }], 10_000, { durationMs: 1200 })),
	];
	const fake: FakeSession = {
		detail: summary("p1", { childCount: 2, children: [c1, c2], entryCount: entries.length }),
		entries,
		turns: [turn(0, 1, 8, { at: iso(1000), durationMs: 10_200, modelCalls: 2, toolCalls: 5 })],
	};
	const trace = traceOf(fake);
	const firstLlm = trace.records.find((r) => r.kind === "llm");
	if (firstLlm && firstLlm.kind === "llm" && firstLlm.start !== undefined) {
		Object.assign(firstLlm, { sentAt: firstLlm.start + 10, responseAt: firstLlm.start + 100, firstTokenAt: firstLlm.start + 300 });
	}
	return trace;
}

function installManualRaf() {
	let nextId = 1;
	const callbacks = new Map<number, FrameRequestCallback>();
	const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
		const id = nextId++;
		callbacks.set(id, cb);
		return id;
	});
	const cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
		callbacks.delete(id);
	});
	const flushOneFrame = () => {
		const pending = [...callbacks.entries()];
		callbacks.clear();
		act(() => {
			for (const [, cb] of pending) cb(performance.now());
		});
	};
	return {
		rafSpy,
		cafSpy,
		pendingCount: () => callbacks.size,
		flushOneFrame,
		restore: () => {
			rafSpy.mockRestore();
			cafSpy.mockRestore();
		},
	};
}

let restoreLayout: () => void;

beforeEach(() => {
	restoreLayout = mockLayout({ viewport: 20_000, rowHeight: 80 });
	renderCounts.ledger = 0;
	renderCounts.timeBreakdown = 0;
	renderCounts.inspector = 0;
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.className = "";
});

afterEach(() => {
	restoreLayout();
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.className = "";
	vi.restoreAllMocks();
});

describe("Overview hover and redraw performance", () => {
	it("caches the resolved theme palette across hover redraws and refreshes when theme attributes change", async () => {
		const raf = installManualRaf();
		const uaSpy = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/130.0.0.0");
		const contexts = new Map<HTMLCanvasElement, FakeCanvasContext>();
		const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, id: string) {
			if (id !== "2d") return null;
			let entry = contexts.get(this);
			if (!entry) {
				entry = createFakeContext2D();
				contexts.set(this, entry);
			}
			return entry.ctx;
		} as HTMLCanvasElement["getContext"]);

		const realGetComputedStyle = window.getComputedStyle.bind(window);
		const computedStyleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
			const base = realGetComputedStyle(el, pseudo);
			const isDark = document.documentElement.getAttribute("data-theme") === "dark";
			const isHighContrast = document.documentElement.classList.contains("high-contrast");
			const ink = isHighContrast ? "#225588" : isDark ? "#eeeeee" : "#111111";
			return new Proxy(base, {
				get(target, prop) {
					if (prop === "getPropertyValue") {
						return (name: string) => (name === "--color-ink" ? ink : target.getPropertyValue(name));
					}
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		});

		try {
			const trace = traceOf(session());
			const { container } = render(<Overview trace={trace} />);
			const plot = container.querySelector<HTMLElement>("[data-overview-plot]")!;
			const canvases = [...plot.querySelectorAll("canvas")];
			expect(canvases).toHaveLength(2);
			const overlayRecord = contexts.get(canvases[1])!;
			expect(overlayRecord).toBeDefined();

			const callsAfterMount = computedStyleSpy.mock.calls.length;
			expect(callsAfterMount).toBe(1);

			const items = layoutOverview(trace, makeScale(foldGaps(traceIntervals(trace)), 800), overviewLanes());
			const targets = items.filter((item) => item.lane !== "turns").slice(0, 4);
			expect(targets.length).toBeGreaterThanOrEqual(4);

			const strokeRectsBefore = overlayRecord.strokeRectCalls;
			for (const target of targets) {
				fireEvent.pointerMove(plot, { clientX: (target.x0 + target.x1) / 2, clientY: (target.y0 + target.y1) / 2 });
				raf.flushOneFrame();
			}

			// Each hover move redrew the overlay canvas with the cached palette without re-reading CSS custom properties.
			expect(overlayRecord.strokeRectCalls).toBeGreaterThanOrEqual(strokeRectsBefore + targets.length);
			expect(overlayRecord.strokeColors.at(-1)).toBe("#111111");
			expect(computedStyleSpy.mock.calls.length).toBe(callsAfterMount);

			// Switching `data-theme` invalidates the cached palette once and repaints with the new color.
			act(() => {
				document.documentElement.setAttribute("data-theme", "dark");
			});
			await waitFor(() => expect(computedStyleSpy.mock.calls.length).toBe(callsAfterMount + 1));
			expect(overlayRecord.strokeColors.at(-1)).toBe("#eeeeee");

			// Mutating `class` on `document.documentElement` also refreshes the cached palette.
			act(() => {
				document.documentElement.classList.add("high-contrast");
			});
			await waitFor(() => expect(computedStyleSpy.mock.calls.length).toBe(callsAfterMount + 2));
			expect(overlayRecord.strokeColors.at(-1)).toBe("#225588");
		} finally {
			computedStyleSpy.mockRestore();
			getContextSpy.mockRestore();
			uaSpy.mockRestore();
			raf.restore();
		}
	});

	it("matches linear hitTest across all lanes, sub-rows, boundaries, and overlapping long/short spans", () => {
		const trace = multiLaneTrace();
		const lanes = overviewLanes(true, 2);
		const scale = makeScale(foldGaps(traceIntervals(trace)), 800);
		const items = layoutOverview(trace, scale, lanes);

		// Mix in a long spanning item and many narrow items on the same band to stress subtree pruning.
		const synthetic: OverviewItem[] = [
			...items,
			{
				key: "span-all",
				lane: "agents",
				family: "agent",
				error: false,
				x0: 0,
				x1: 800,
				y0: lanes[4].y0,
				y1: lanes[4].y0 + 16,
				start: 0,
				end: 1000,
			},
			...Array.from({ length: 120 }, (_, i) => ({
				key: `micro:${i}`,
				lane: "llm" as const,
				family: "llm" as const,
				error: false,
				x0: i * 6.5,
				x1: i * 6.5 + 2,
				y0: lanes[2].y0,
				y1: lanes[2].y1,
				start: i * 10,
				end: i * 10 + 5,
			})),
		];
		const index = buildHitIndex(synthetic);

		// Verify every item's center hits the exact same item as linear hitTest.
		for (const item of synthetic) {
			const cx = (item.x0 + item.x1) / 2;
			const cy = (item.y0 + item.y1) / 2;
			expect(hitTestIndex(index, cx, cy)).toBe(hitTest(synthetic, cx, cy));
		}

		// Verify a grid spanning every lane, inter-lane 1 px boundaries, and empty regions.
		const maxY = lanes[lanes.length - 1].y1 + 4;
		for (let y = 0; y <= maxY; y += 2) {
			for (let x = -2; x <= 802; x += 11) {
				expect(hitTestIndex(index, x, y)).toBe(hitTest(synthetic, x, y));
			}
		}
	});

	it("throttles rapid pointer moves via rAF, cancels on leave, and keeps clicks immediate", () => {
		const raf = installManualRaf();
		try {
			const trace = traceOf(session());
			const onHover = vi.fn();
			const onSelect = vi.fn();
			const { container } = render(<Overview trace={trace} onHover={onHover} onSelect={onSelect} />);
			const plot = container.querySelector<HTMLElement>("[data-overview-plot]")!;
			const items = layoutOverview(trace, makeScale(foldGaps(traceIntervals(trace)), 800), overviewLanes());
			const records = items.filter((item) => item.lane !== "turns");
			expect(records.length).toBeGreaterThanOrEqual(5);

			const centerOf = (item: OverviewItem) => ({
				clientX: (item.x0 + item.x1) / 2,
				clientY: (item.y0 + item.y1) / 2,
			});

			// Leading pointer move processes immediately; subsequent rapid moves in the same frame coalesce.
			fireEvent.pointerMove(plot, centerOf(records[0]));
			expect(onHover).toHaveBeenCalledTimes(1);
			expect(onHover).toHaveBeenLastCalledWith(records[0].key);
			expect(within(container).getByRole("tooltip")).toBeTruthy();

			for (let i = 1; i < 5; i++) {
				fireEvent.pointerMove(plot, centerOf(records[i]));
			}
			// Still capped to the leading edge before the animation frame runs.
			expect(onHover).toHaveBeenCalledTimes(1);

			// Flushing the frame evaluates only the latest pointer coordinates (skipping intermediate moves).
			raf.flushOneFrame();
			expect(onHover).toHaveBeenCalledTimes(2);
			expect(onHover).toHaveBeenLastCalledWith(records[4].key);

			// Queue another move during cooldown, then leave: pending rAF is cancelled and hover clears.
			fireEvent.pointerMove(plot, centerOf(records[1]));
			expect(raf.pendingCount()).toBeGreaterThan(0);
			fireEvent.pointerLeave(plot);
			expect(raf.cafSpy).toHaveBeenCalled();
			expect(raf.pendingCount()).toBe(0);
			expect(within(container).queryByRole("tooltip")).toBeNull();
			expect(onHover).toHaveBeenLastCalledWith(undefined);

			// Clicking hit-tests immediately via the index without needing an animation frame.
			const target = records[2];
			fireEvent.pointerDown(plot, { ...centerOf(target), button: 0 });
			fireEvent.pointerUp(plot, { ...centerOf(target), button: 0 });
			expect(onSelect).toHaveBeenCalledTimes(1);
			expect(onSelect).toHaveBeenCalledWith(target);
		} finally {
			raf.restore();
		}
	});

	it("isolates hover state so moving across Overview never re-renders Trajectory or sibling components", async () => {
		const raf = installManualRaf();
		try {
			const fixture = session();
			renderApp("/s/t1", createFakeServer({ sessions: [fixture] }).fetch);
			await waitFor(() => expect(rows()).toHaveLength(9), firstRender);
			const overview = document.querySelector<HTMLElement>("[data-overview]")!;
			const plot = overview.querySelector<HTMLElement>("[data-overview-plot]")!;

			const trace = traceOf(fixture);
			const items = layoutOverview(trace, makeScale(foldGaps(traceIntervals(trace)), 800), overviewLanes());
			const targets: [OverviewItem, string][] = [
				[items.find((item) => item.key === "t:t1:c_bash")!, "BASH"],
				[items.find((item) => item.key === "t:t1:c_read")!, "READ"],
				[items.find((item) => item.key === "t:t1:c_edit")!, "EDIT"],
				[items.find((item) => item.key === "l:t1:11")!, "LLM"],
			];
			expect(targets.every(([item]) => Boolean(item))).toBe(true);

			// Reset counters after initial mount has settled.
			renderCounts.ledger = 0;
			renderCounts.timeBreakdown = 0;
			renderCounts.inspector = 0;

			for (const [target, expectedBadge] of targets) {
				fireEvent.pointerMove(plot, { clientX: (target.x0 + target.x1) / 2, clientY: (target.y0 + target.y1) / 2 });
				raf.flushOneFrame();
				expect(within(overview).getByRole("tooltip").textContent).toContain(expectedBadge);
			}

			fireEvent.pointerLeave(plot);
			expect(within(overview).queryByRole("tooltip")).toBeNull();

			// Hovering rows in the Ledger also uses the ref-backed channel and never re-renders Trajectory siblings.
			const ledgerRows = rows();
			fireEvent.mouseEnter(ledgerRows[0].parentElement!);
			fireEvent.mouseEnter(ledgerRows[1].parentElement!);
			fireEvent.mouseLeave(document.querySelector<HTMLElement>("[data-ledger] [data-scroll-pane]")!);

			expect(renderCounts).toEqual({ ledger: 0, timeBreakdown: 0, inspector: 0 });
		} finally {
			raf.restore();
		}
	});
});
