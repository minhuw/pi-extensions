import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaf, moveLeaf, type PaneTree } from "../src/nodes/panes/pane-tree";
import { TerminalSlotsContext, type TerminalSlots } from "../src/nodes/panes/slot-contract";
import { nearestEdge, TerminalSplitView, type TerminalSplitViewProps } from "../src/nodes/panes/TerminalSplitView";

const split = (direction: "row" | "column", first: PaneTree, second: PaneTree, ratio = 0.5): PaneTree => ({ type: "split", direction, ratio, first, second });

/** A terminal layer that records what the view registers. */
function fakeSlots() {
    const calls: [string, HTMLElement | null][] = [];
    const current = new Map<string, HTMLElement>();
    const slots: TerminalSlots & { calls: typeof calls; current: typeof current; resizeEnd: ReturnType<typeof vi.fn<() => void>> } = {
        calls,
        current,
        attach(terminalId, element) {
            calls.push([terminalId, element]);
            if (element) current.set(terminalId, element);
            else current.delete(terminalId);
        },
        resizeEnd: vi.fn<() => void>(),
    };
    return slots;
}

function props(tree: PaneTree, focused: string, more: Partial<TerminalSplitViewProps> = {}): TerminalSplitViewProps {
    return { tree, focused, onChange: vi.fn(), onFocus: vi.fn(), onSplit: vi.fn(), onClose: vi.fn(), ...more };
}

function view(slots: TerminalSlots, value: TerminalSplitViewProps) {
    return (
        <TerminalSlotsContext.Provider value={slots}>
            <div style={{ width: 1000, height: 600 }}>
                <TerminalSplitView {...value} />
            </div>
        </TerminalSlotsContext.Provider>
    );
}

/** Gives `element` a box on screen (jsdom lays nothing out). */
function place(element: Element, left: number, top: number, width: number, height: number) {
    (element as HTMLElement).getBoundingClientRect = () =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

const pane = (id: string) => document.querySelector(`[data-pane="${id}"]`) as HTMLElement;
const slot = (id: string) => document.querySelector(`[data-pane-slot="${id}"]`) as HTMLElement;
const divider = (path = "") => document.querySelector(`[data-pane-divider="${path}"]`) as HTMLElement;

let frames: FrameRequestCallback[];
beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
        frames[handle - 1] = () => {};
    });
});
afterEach(() => {
    frames = [];
});
const flushFrames = () => {
    const pending = frames.splice(0);
    for (const frame of pending) frame(0);
};

describe("slots", () => {
    it("register each pane's empty slot with the terminal layer, and release them on unmount", () => {
        const slots = fakeSlots();
        const { unmount } = render(view(slots, props(split("row", leaf("a"), split("column", leaf("b"), leaf("c"))), "a")));
        expect([...slots.current.keys()].sort()).toEqual(["a", "b", "c"]);
        for (const id of ["a", "b", "c"]) {
            expect(slots.current.get(id)).toBe(slot(id));
            // The view never draws a terminal itself.
            expect(slot(id).childElementCount).toBe(0);
        }
        unmount();
        expect(slots.current.size).toBe(0);
        expect(slots.calls.filter(([, element]) => element === null).map(([id]) => id).sort()).toEqual(["a", "b", "c"]);
    });

    it("do not register again on a render that changes nothing about the pane", () => {
        const slots = fakeSlots();
        const tree = split("row", leaf("a"), leaf("b"));
        const { rerender } = render(view(slots, props(tree, "a")));
        const before = slots.calls.length;
        rerender(view(slots, props(tree, "b")));
        rerender(view(slots, props(split("row", leaf("a"), leaf("b"), 0.7), "b")));
        expect(slots.calls.length).toBe(before);
    });

    it("follow the panes through a split and a close", () => {
        const slots = fakeSlots();
        const { rerender } = render(view(slots, props(leaf("a"), "a")));
        expect(slots.current.get("a")).toBe(slot("a"));
        rerender(view(slots, props(split("row", leaf("a"), leaf("b")), "b")));
        expect(slots.current.get("a")).toBe(slot("a"));
        expect(slots.current.get("b")).toBe(slot("b"));
        rerender(view(slots, props(leaf("b"), "b")));
        expect([...slots.current.keys()]).toEqual(["b"]);
        expect(slots.current.get("b")).toBe(slot("b"));
    });

    it("need the terminal layer: without a provider the view says so", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => render(<TerminalSplitView {...props(leaf("a"), "a")} />)).toThrow(/TerminalSlotsContext provider/);
    });
});

describe("layout", () => {
    it("nests flex boxes by direction with each side's share, and a lone pane has no chrome", () => {
        const slots = fakeSlots();
        const { rerender } = render(view(slots, props(leaf("a"), "a")));
        expect(document.querySelector("[data-pane-divider]")).toBeNull();
        expect(screen.queryByRole("button")).toBeNull();
        rerender(view(slots, props(split("row", leaf("a"), split("column", leaf("b"), leaf("c"), 0.25), 0.6), "a")));
        const outer = document.querySelector('[data-pane-split=""]') as HTMLElement;
        expect(outer.className).toContain("flex-row");
        expect(pane("a").style.flex).toBe("0.6 1 0%");
        const inner = document.querySelector('[data-pane-split="second"]') as HTMLElement;
        expect(inner.className).toContain("flex-col");
        expect(inner.style.flex).toBe("0.4 1 0%");
        expect(pane("b").style.flex).toBe("0.25 1 0%");
        expect(screen.getAllByRole("separator").map((item) => item.getAttribute("aria-orientation"))).toEqual(["vertical", "horizontal"]);
    });

    it("outlines the focused pane, and a pointer down on a pane focuses it", () => {
        const slots = fakeSlots();
        const onFocus = vi.fn();
        render(view(slots, props(split("row", leaf("a"), leaf("b")), "a", { onFocus })));
        expect(pane("a").hasAttribute("data-focused")).toBe(true);
        expect(pane("a").className).toContain("border-wb-accent");
        expect(pane("b").hasAttribute("data-focused")).toBe(false);
        fireEvent.pointerDown(pane("b"), { pointerId: 1, button: 0 });
        expect(onFocus).toHaveBeenCalledWith("b");
        fireEvent.pointerDown(pane("a"), { pointerId: 1, button: 0 });
        expect(onFocus).toHaveBeenCalledTimes(1);
    });

    it("offers split and close on each pane's header", () => {
        const slots = fakeSlots();
        const value = props(split("row", leaf("a"), leaf("b")), "a", { label: (id) => `shell ${id}` });
        render(view(slots, value));
        fireEvent.click(screen.getAllByRole("button", { name: "Split right" })[0]!);
        expect(value.onSplit).toHaveBeenCalledWith("row");
        fireEvent.click(screen.getAllByRole("button", { name: "Split down" })[1]!);
        expect(value.onSplit).toHaveBeenCalledWith("column");
        fireEvent.click(screen.getByRole("button", { name: "Close shell b" }));
        expect(value.onClose).toHaveBeenCalledWith("b");
    });
});

describe("dragging a divider", () => {
    function setup(tree: PaneTree = split("row", leaf("a"), leaf("b"))) {
        const slots = fakeSlots();
        const value = props(tree, "a");
        render(view(slots, value));
        place(pane("a"), 0, 0, 500, 600);
        place(pane("b"), 505, 0, 500, 600);
        return { slots, value, onChange: value.onChange as ReturnType<typeof vi.fn> };
    }

    it("moves the panes once a frame and commits the ratio once, on release", () => {
        const { slots, onChange } = setup();
        fireEvent.pointerDown(divider(), { pointerId: 1, button: 0, clientX: 502, pointerType: "mouse", isPrimary: true });
        for (const x of [520, 560, 602]) fireEvent.pointerMove(window, { pointerId: 1, clientX: x });
        expect(frames).toHaveLength(1);
        expect(pane("a").style.flex).toBe("0.5 1 0%");
        flushFrames();
        expect(pane("a").style.flex).toBe("600 1 0%");
        expect(pane("b").style.flex).toBe("400 1 0%");
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 652 });
        expect(onChange).not.toHaveBeenCalled();
        expect(slots.resizeEnd).not.toHaveBeenCalled();
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 652 });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0]![0]).toEqual(split("row", leaf("a"), leaf("b"), 0.65));
        expect(slots.resizeEnd).toHaveBeenCalledTimes(1);
        // The drag is over: later pointer events do nothing.
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 700 });
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 700 });
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("keeps each side at least 50 px", () => {
        const { onChange } = setup();
        fireEvent.pointerDown(divider(), { pointerId: 1, button: 0, clientX: 502 });
        fireEvent.pointerMove(window, { pointerId: 1, clientX: -400 });
        fireEvent.pointerUp(window, { pointerId: 1 });
        expect(onChange.mock.calls[0]![0]).toMatchObject({ ratio: 0.05 });
    });

    it("follows the vertical axis for stacked panes and sets the nested split's ratio", () => {
        const slots = fakeSlots();
        const value = props(split("row", leaf("a"), split("column", leaf("b"), leaf("c"))), "a");
        render(view(slots, value));
        place(pane("b"), 505, 0, 500, 300);
        place(pane("c"), 505, 305, 500, 300);
        fireEvent.pointerDown(divider("second"), { pointerId: 2, button: 0, clientY: 302 });
        fireEvent.pointerMove(window, { pointerId: 2, clientY: 242 });
        fireEvent.pointerUp(window, { pointerId: 2 });
        expect(value.onChange).toHaveBeenCalledWith(split("row", leaf("a"), split("column", leaf("b"), leaf("c"), 0.4)));
    });

    it("survives losing the pointer capture and still commits on release", () => {
        const { onChange } = setup();
        fireEvent.pointerDown(divider(), { pointerId: 1, button: 0, clientX: 502 });
        fireEvent(divider(), new Event("lostpointercapture"));
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 552 });
        fireEvent.pointerUp(window, { pointerId: 1 });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0]![0]).toMatchObject({ ratio: 0.55 });
    });

    it.each([
        ["the window losing focus", () => fireEvent.blur(window)],
        ["a pointer cancel", () => fireEvent.pointerCancel(window, { pointerId: 1 })],
        ["Escape", () => fireEvent.keyDown(window, { key: "Escape" })],
    ])("puts the panes back on %s, committing nothing", (_, end) => {
        const { slots, onChange } = setup();
        fireEvent.pointerDown(divider(), { pointerId: 1, button: 0, clientX: 502 });
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 602 });
        flushFrames();
        expect(pane("a").style.flex).toBe("600 1 0%");
        end();
        expect(pane("a").style.flex).toBe("0.5 1 0%");
        expect(pane("b").style.flex).toBe("0.5 1 0%");
        fireEvent.pointerUp(window, { pointerId: 1 });
        expect(onChange).not.toHaveBeenCalled();
        // The layer may have fitted the terminals mid-drag: it hears the drag ended, to put them back.
        expect(slots.resizeEnd).toHaveBeenCalledTimes(1);
    });

    it("commits nothing for a click without movement", () => {
        const { slots, onChange } = setup();
        fireEvent.pointerDown(divider(), { pointerId: 1, button: 0, clientX: 502 });
        fireEvent.pointerUp(window, { pointerId: 1 });
        expect(onChange).not.toHaveBeenCalled();
        expect(slots.resizeEnd).not.toHaveBeenCalled();
    });

    it("ignores another touch pointer, and a split that has no size", () => {
        const { onChange } = setup();
        fireEvent.pointerDown(divider(), { pointerId: 1, button: 0, clientX: 502, pointerType: "touch", isPrimary: true });
        fireEvent.pointerMove(window, { pointerId: 9, clientX: 700, pointerType: "touch", isPrimary: false });
        fireEvent.pointerUp(window, { pointerId: 9 });
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.pointerUp(window, { pointerId: 1 });

        place(pane("a"), 0, 0, 0, 0);
        place(pane("b"), 0, 0, 0, 0);
        fireEvent.pointerDown(divider(), { pointerId: 3, button: 0, clientX: 0 });
        fireEvent.pointerMove(window, { pointerId: 3, clientX: 50 });
        fireEvent.pointerUp(window, { pointerId: 3 });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("moves by arrow keys and evens on a double-click, committing each", () => {
        const { slots, onChange } = setup(split("row", leaf("a"), leaf("b"), 0.3));
        fireEvent.keyDown(divider(), { key: "ArrowRight" });
        expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ ratio: 0.35 });
        fireEvent.keyDown(divider(), { key: "ArrowLeft", shiftKey: true });
        expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ ratio: 0.1 });
        fireEvent.keyDown(divider(), { key: "ArrowDown" });
        expect(onChange).toHaveBeenCalledTimes(2);
        fireEvent.doubleClick(divider());
        expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ ratio: 0.5 });
        expect(slots.resizeEnd).toHaveBeenCalledTimes(3);
    });
});

describe("moving a pane", () => {
    function Controlled({ slots, initial }: { slots: TerminalSlots; initial: PaneTree }) {
        const [tree, setTree] = useState(initial);
        return view(slots, props(tree, "a", { onChange: setTree }));
    }

    function layout() {
        place(document.querySelector("[data-terminal-split]")!, 0, 0, 1000, 600);
        place(pane("a"), 0, 0, 500, 600);
        place(pane("b"), 505, 0, 500, 300);
        place(pane("c"), 505, 305, 500, 300);
    }

    const grip = (id: string) => document.querySelector(`[data-pane-grip="${id}"]`) as HTMLElement;

    it("drops a pane on another pane's nearest edge past the threshold", () => {
        const slots = fakeSlots();
        const initial = split("row", leaf("a"), split("column", leaf("b"), leaf("c")));
        render(<Controlled slots={slots} initial={initial} />);
        layout();
        fireEvent.pointerDown(grip("a"), { pointerId: 4, button: 0, clientX: 10, clientY: 10 });
        fireEvent.pointerMove(window, { pointerId: 4, clientX: 13, clientY: 12 });
        expect(pane("a").className).not.toContain("opacity-50");
        // Into c, nearest its right edge.
        act(() => {
            fireEvent.pointerMove(window, { pointerId: 4, clientX: 980, clientY: 450 });
        });
        expect(pane("a").className).toContain("opacity-50");
        const marker = document.querySelector("[data-pane-drop]") as HTMLElement;
        expect(marker.dataset.paneDrop).toBe("c:right");
        expect([marker.style.left, marker.style.top, marker.style.width, marker.style.height]).toEqual(["755px", "305px", "250px", "300px"]);
        act(() => {
            fireEvent.pointerUp(window, { pointerId: 4, clientX: 980, clientY: 450 });
        });
        expect(document.querySelector("[data-pane-drop]")).toBeNull();
        expect(document.querySelector('[data-pane-split=""]')!.getAttribute("data-direction")).toBe("column");
        expect(slots.current.get("a")).toBe(slot("a"));
        expect(slots.resizeEnd).toHaveBeenCalledTimes(1);
    });

    it("marks nothing over a drop that changes nothing, and Escape cancels", () => {
        const slots = fakeSlots();
        const onChange = vi.fn();
        const tree = split("row", leaf("a"), split("column", leaf("b"), leaf("c")));
        render(view(slots, props(tree, "a", { onChange })));
        layout();
        // b onto c's top edge: b is already above c.
        fireEvent.pointerDown(grip("b"), { pointerId: 5, button: 0, clientX: 600, clientY: 5 });
        act(() => {
            fireEvent.pointerMove(window, { pointerId: 5, clientX: 750, clientY: 310 });
        });
        expect(document.querySelector("[data-pane-drop]")).toBeNull();
        act(() => {
            fireEvent.pointerMove(window, { pointerId: 5, clientX: 10, clientY: 300 });
        });
        expect((document.querySelector("[data-pane-drop]") as HTMLElement).dataset.paneDrop).toBe("a:left");
        act(() => {
            fireEvent.keyDown(window, { key: "Escape" });
        });
        expect(document.querySelector("[data-pane-drop]")).toBeNull();
        fireEvent.pointerUp(window, { pointerId: 5 });
        expect(onChange).not.toHaveBeenCalled();
        expect(slots.resizeEnd).not.toHaveBeenCalled();
    });

    it("commits what the drop showed", () => {
        const slots = fakeSlots();
        const onChange = vi.fn();
        const tree = split("row", leaf("a"), split("column", leaf("b"), leaf("c")));
        render(view(slots, props(tree, "a", { onChange })));
        layout();
        fireEvent.pointerDown(grip("c"), { pointerId: 6, button: 0, clientX: 600, clientY: 310 });
        act(() => {
            fireEvent.pointerMove(window, { pointerId: 6, clientX: 250, clientY: 5 });
        });
        fireEvent.pointerUp(window, { pointerId: 6 });
        expect(onChange).toHaveBeenCalledWith(moveLeaf(tree, "c", "a", "top"));
    });

    it("picks the nearest edge, never a centre", () => {
        const rect = { left: 0, top: 0, width: 100, height: 50 };
        expect(nearestEdge(50, 2, rect)).toBe("top");
        expect(nearestEdge(50, 48, rect)).toBe("bottom");
        expect(nearestEdge(3, 25, rect)).toBe("left");
        expect(nearestEdge(97, 25, rect)).toBe("right");
        expect(nearestEdge(50, 25, rect)).toMatch(/^(top|bottom|left|right)$/);
    });
});
