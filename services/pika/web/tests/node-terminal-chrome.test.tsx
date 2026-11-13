import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeChannel } from "../src/nodes/channel";
import type { NodeEvent, TerminalInfo } from "../src/nodes/contract";
import { menuItems, type MenuEntry } from "../src/nodes/deck/Menu";
import { EditorStore } from "../src/nodes/editor";
import type { TerminalCommand, TerminalHandle, TerminalSlots } from "../src/nodes/panes/slot-contract";
import { SIZE_HINT_MS, TerminalView } from "../src/nodes/TerminalView";
import { activate, addTab, createWorkspace, fileTab, terminalTab, type Workspace } from "../src/nodes/workspace/model";
import { SlotRegistry } from "../src/nodes/workspace/slots";
import { tabMenuItems, WorkspaceView, type WorkspaceActions } from "../src/nodes/workspace/WorkspaceView";

const info = (terminalId: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ terminalId, title: "", cwd: "/p", cols: 80, rows: 24, pid: 1, createdAt: 1, argv: ["bash"], ...extra });

class StubResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

/** A node channel that answers `term.attach` with an empty screen and lets the test send events. */
function fakeChannel(size = { cols: 80, rows: 24 }) {
	const listeners = new Set<(event: NodeEvent) => void>();
	const notices: Record<string, unknown>[] = [];
	const channel = {
		request: vi.fn((type: string, params: { terminalId: string }) =>
			type === "term.attach"
				? Promise.resolve({ terminal: info(params.terminalId, size), snapshot: { data: "", ...size, outputSequence: 0 } })
				: Promise.resolve({}),
		),
		notify: vi.fn((message: Record<string, unknown>) => {
			notices.push(message);
			return Promise.resolve();
		}),
		onEvent: (listener: (event: NodeEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const emit = (event: NodeEvent) => act(() => listeners.forEach((listener) => listener(event)));
	return { channel: channel as unknown as NodeChannel, notices, emit };
}

/** The terminal's host measures as `fit` cells, so the view has a fitting size to report. */
function measuresAs(fit: { cols: number; rows: number }) {
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
	vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue(fit);
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	// jsdom has no canvas: the view draws with the DOM renderer.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("the terminal view's chrome", () => {
	async function mount(fit = { cols: 80, rows: 24 }, size = { cols: 80, rows: 24 }) {
		measuresAs(fit);
		const fake = fakeChannel(size);
		const handle = createRef<TerminalHandle>();
		const onKill = vi.fn();
		const view = render(<TerminalView ref={handle} channel={fake.channel} terminal={info("t1", size)} theme="dark" home="/home/me" onKill={onKill} onOpenFile={() => {}} />);
		await waitFor(() => expect(view.container.querySelector("[data-terminal-attaching]")).toBeNull());
		return { ...fake, view, handle, onKill };
	}

	it("has no toolbar: the whole box is the terminal, with no buttons while nothing needs one", async () => {
		const { view } = await mount();
		const root = view.container.querySelector("[data-terminal-view]")!;
		expect(root.querySelectorAll("button")).toHaveLength(0);
		for (const gone of ["[data-find-open]", "[data-upload-pick]", "[data-kill-terminal]", "[data-renderer]", "[data-size-owner]", "[data-terminal-size]"]) {
			expect(root.querySelector(gone), gone).toBeNull();
		}
		// The host is the box's only child in the flow (beside the hidden file input): nothing above it takes height.
		const box = root.querySelector("[data-terminal-host]")!.parentElement!;
		expect([...root.children].filter((child) => !(child instanceof HTMLInputElement))).toEqual([box]);
	});

	it("opens a find widget floating over the grid, which finds next and previous and closes with Escape", async () => {
		const next = vi.spyOn(SearchAddon.prototype, "findNext").mockReturnValue(true);
		const previous = vi.spyOn(SearchAddon.prototype, "findPrevious").mockReturnValue(true);
		const clear = vi.spyOn(SearchAddon.prototype, "clearDecorations");
		const { view, handle } = await mount();
		act(() => handle.current!.find());
		const widget = view.container.querySelector<HTMLElement>("[data-terminal-search]")!;
		// Over the grid, not above it: a sibling of the host in its positioned box, so the fit never changes.
		expect(widget.parentElement).toBe(view.container.querySelector("[data-terminal-host]")!.parentElement);
		expect(widget.className).toMatch(/\babsolute\b/);
		expect(widget.className).toMatch(/\btop-2\b/);
		expect(widget.className).toMatch(/\bright-4\b/);
		const input = within(widget).getByRole("textbox", { name: "Find in the terminal" });
		expect(document.activeElement).toBe(input);
		expect(widget.querySelector<HTMLButtonElement>("[data-find-next]")!.disabled).toBe(true);

		fireEvent.change(input, { target: { value: "error" } });
		expect(next).toHaveBeenLastCalledWith("error", expect.objectContaining({ incremental: true }));
		fireEvent.keyDown(input, { key: "Enter" });
		expect(next).toHaveBeenLastCalledWith("error", expect.objectContaining({ incremental: false }));
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(previous).toHaveBeenCalledTimes(1);
		fireEvent.click(within(widget).getByRole("button", { name: "Next match" }));
		expect(next).toHaveBeenCalledTimes(3);
		fireEvent.click(within(widget).getByRole("button", { name: "Previous match" }));
		expect(previous).toHaveBeenCalledTimes(2);

		fireEvent.keyDown(input, { key: "Escape" });
		expect(view.container.querySelector("[data-terminal-search]")).toBeNull();
		expect(clear).toHaveBeenCalled();

		// The close button closes it too.
		act(() => handle.current!.find());
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(view.container.querySelector("[data-terminal-search]")).toBeNull();
	});

	it("offers Fit here only to a window that does not own the size, and only while its fit differs", async () => {
		const { view, emit, notices } = await mount({ cols: 100, rows: 30 });
		const banner = () => view.container.querySelector("[data-size-owner]");
		// Until the node says who owns the size, nothing shows.
		expect(banner()).toBeNull();
		await emit({ type: "term.resized", terminalId: "t1", cols: 80, rows: 24, owned: false });
		expect(banner()!.textContent).toContain("Sized by another window · 80×24");
		fireEvent.click(view.container.querySelector("[data-fit-here]")!);
		expect(notices.at(-1)).toMatchObject({ type: "term.resize", terminalId: "t1", cols: 100, rows: 30, claim: true });
		// Now this window owns it: no banner.
		await emit({ type: "term.resized", terminalId: "t1", cols: 100, rows: 30, owned: true });
		expect(banner()).toBeNull();
		// The owner never sees it, whatever size the grid has.
		await emit({ type: "term.resized", terminalId: "t1", cols: 90, rows: 28, owned: true });
		expect(banner()).toBeNull();
		// Another window takes the size again, at the size that fits here anyway: nothing to offer.
		await emit({ type: "term.resized", terminalId: "t1", cols: 100, rows: 30, owned: false });
		expect(banner()).toBeNull();
	});

	it("shows the grid's new size for a moment when this window resizes it", async () => {
		const { view, emit } = await mount();
		await emit({ type: "term.resized", terminalId: "t1", cols: 80, rows: 24, owned: true });
		expect(view.container.querySelector("[data-terminal-size]")).toBeNull();
		await emit({ type: "term.resized", terminalId: "t1", cols: 120, rows: 40, owned: true });
		expect(view.container.querySelector("[data-terminal-size]")!.textContent).toBe("120×40");
		await waitFor(() => expect(view.container.querySelector("[data-terminal-size]")).toBeNull(), { timeout: SIZE_HINT_MS + 1_000 });
	});

	it("runs the tab strip's commands: find, upload (opens the file picker), and kill", async () => {
		const { view, handle, onKill } = await mount();
		const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
		act(() => handle.current!.upload());
		expect(picker).toHaveBeenCalledTimes(1);
		expect(picker.mock.contexts[0]).toBe(view.container.querySelector("[data-upload-input]"));
		act(() => handle.current!.kill());
		expect(onKill).toHaveBeenCalledTimes(1);
	});

	it("offers Remove in an exited terminal's notice, and no upload", async () => {
		measuresAs({ cols: 80, rows: 24 });
		const fake = fakeChannel();
		const handle = createRef<TerminalHandle>();
		const onKill = vi.fn();
		const view = render(
			<TerminalView ref={handle} channel={fake.channel} terminal={info("t1", { exited: { code: 1, signal: null } })} theme="dark" home="/home/me" onKill={onKill} onOpenFile={() => {}} />,
		);
		expect(view.container.querySelector("[data-terminal-exited]")!.textContent).toContain("Exited with code 1");
		fireEvent.click(view.container.querySelector("[data-kill-terminal]")!);
		expect(onKill).toHaveBeenCalledTimes(1);
		expect(view.container.querySelector("[data-upload-input]")).toBeNull();
	});
});

describe("the registry between terminals and chrome", () => {
	it("passes commands to the drawn terminal, and keeps a newer drawing's when an older one leaves", () => {
		const registry = new SlotRegistry();
		const slots = registry.forNode("n1");
		expect(slots.command("t1", "find")).toBe(false);
		const first = { find: vi.fn(), upload: vi.fn(), kill: vi.fn() };
		const second = { find: vi.fn(), upload: vi.fn(), kill: vi.fn() };
		registry.setHandle("n1", "t1", first);
		expect(slots.command("t1", "find")).toBe(true);
		expect(first.find).toHaveBeenCalledTimes(1);
		registry.setHandle("n1", "t1", second);
		registry.dropHandle("n1", "t1", first);
		slots.command("t1", "upload");
		expect(second.upload).toHaveBeenCalledTimes(1);
		expect(registry.forNode("n2").command("t1", "find")).toBe(false);
		registry.dropHandle("n1", "t1", second);
		expect(slots.command("t1", "kill")).toBe(false);
	});

	it("says why a shown terminal draws with the DOM renderer, page-wide reasons first", () => {
		const registry = new SlotRegistry();
		const heard = vi.fn();
		registry.subscribeRenderers(heard);
		registry.setRenderer("n1", "a", "webgl");
		expect(registry.fallback()).toBeUndefined();
		expect(heard).not.toHaveBeenCalled();
		registry.setRenderer("n1", "b", "context-lost");
		expect(registry.fallback()).toBe("context-lost");
		registry.setRenderer("n1", "c", "no-webgl");
		expect(registry.fallback()).toBe("no-webgl");
		registry.setRenderer("n1", "c", undefined);
		expect(registry.fallback()).toBe("context-lost");
		registry.setRenderer("n1", "b", undefined);
		expect(registry.fallback()).toBeUndefined();
		// Once per change of the answer, not per report.
		registry.setRenderer("n1", "a", "webgl");
		expect(heard).toHaveBeenCalledTimes(4);
	});
});

describe("the tab strip's terminal actions", () => {
	const actions = (): WorkspaceActions => ({
		activate: vi.fn(),
		focusGroup: vi.fn(),
		close: vi.fn(),
		closeOthers: vi.fn(),
		setPinned: vi.fn(),
		move: vi.fn(),
		split: vi.fn(),
		setRatio: vi.fn(),
		setPanes: vi.fn(),
		focusPane: vi.fn(),
		splitPane: vi.fn(),
		closePane: vi.fn(),
		newTerminal: vi.fn(),
		promote: vi.fn(),
		resizeEnd: vi.fn(),
	});

	function fakeSlots() {
		const commands: [string, TerminalCommand][] = [];
		const slots: TerminalSlots = {
			attach: () => {},
			resizeEnd: () => {},
			command: (terminalId, command) => {
				commands.push([terminalId, command]);
				return true;
			},
		};
		return { slots, commands };
	}

	function view(ws: Workspace, terminals: TerminalInfo[], slots: TerminalSlots, run: WorkspaceActions) {
		return (
			<WorkspaceView
				node="n1"
				nodeName="node01"
				home="/home/me"
				ws={ws}
				terminals={new Map(terminals.map((item) => [item.terminalId, item]))}
				editors={new EditorStore()}
				editorSnapshot={{ tabs: [] }}
				editorKeys={[]}
				slots={slots}
				theme="light"
				diffInline={false}
				onDiffInline={() => {}}
				actions={run}
				onLayout={() => {}}
			/>
		);
	}

	const base = () => {
		let ws = createWorkspace("g1");
		ws = addTab(ws, fileTab("/p/a.ts"));
		ws = addTab(ws, terminalTab("t1", "term:1"));
		return ws;
	};
	const strip = () => document.querySelector<HTMLElement>("[data-tab-strip='g1']")!;
	const action = (id: string) => strip().querySelector<HTMLElement>(`[data-terminal-action='${id}']`);

	it("shows Find, Upload, and the splits for an active terminal tab, and nothing for a file tab", () => {
		const { slots, commands } = fakeSlots();
		const run = actions();
		const ws = base();
		const page = render(view(ws, [info("t1")], slots, run));
		expect(strip().querySelector("[data-terminal-actions='term:1']")).not.toBeNull();
		expect([...strip().querySelectorAll("[data-terminal-action]")].map((item) => item.getAttribute("data-terminal-action"))).toEqual(["find", "upload", "split-right", "split-down"]);
		// Icon buttons named for assistive technology, with tooltips that carry their shortcuts.
		expect(action("find")!.getAttribute("aria-label")).toBe("Find");
		expect(action("find")!.getAttribute("data-tip-keys")).toBeTruthy();
		expect(action("split-right")!.getAttribute("data-tip-keys")).toBeTruthy();
		expect(action("upload")!.getAttribute("data-tip")).toBe("Upload files");

		fireEvent.click(action("find")!);
		fireEvent.click(action("upload")!);
		expect(commands).toEqual([
			["t1", "find"],
			["t1", "upload"],
		]);
		fireEvent.click(action("split-right")!);
		fireEvent.click(action("split-down")!);
		expect(run.splitPane).toHaveBeenNthCalledWith(1, "term:1", "row");
		expect(run.splitPane).toHaveBeenNthCalledWith(2, "term:1", "column");

		page.rerender(view(activate(ws, "file:/p/a.ts"), [info("t1")], slots, run));
		expect(strip().querySelector("[data-terminal-actions]")).toBeNull();
		// The group's "+" stays either way.
		expect(strip().querySelector("[data-group-new-terminal='g1']")).not.toBeNull();
	});

	it("leaves Upload out for an exited terminal", () => {
		const { slots } = fakeSlots();
		render(view(base(), [info("t1", { exited: { code: 0, signal: null } })], slots, actions()));
		expect(action("find")).not.toBeNull();
		expect(action("upload")).toBeNull();
	});

	it("puts the terminal's actions and Kill in a terminal tab's menu, and none of them in a file tab's", () => {
		const ids = (entries: MenuEntry[]) => entries.map((entry) => (entry === "separator" ? "|" : "id" in entry ? entry.id : "?"));
		const ws = base();
		const commands: TerminalCommand[] = [];
		const run = actions();
		const live = tabMenuItems(ws, "term:1", run, { exited: false, run: (command) => commands.push(command) });
		expect(ids(live)).toEqual([
			"find",
			"upload",
			"split-pane-right",
			"split-pane-down",
			"|",
			"split-right",
			"split-left",
			"split-down",
			"split-up",
			"|",
			"pin",
			"|",
			"close",
			"close-others",
			"|",
			"kill",
		]);
		const items = menuItems(live);
		expect(items.find((item) => item.id === "kill")).toMatchObject({ label: "Kill Terminal…", danger: true });
		for (const id of ["find", "upload", "kill"]) items.find((item) => item.id === id)!.run!();
		expect(commands).toEqual(["find", "upload", "kill"]);
		items.find((item) => item.id === "split-pane-down")!.run!();
		expect(run.splitPane).toHaveBeenCalledWith("term:1", "column");

		const exited = tabMenuItems(ws, "term:1", run, { exited: true, run: () => {} });
		expect(ids(exited)).not.toContain("upload");
		expect(menuItems(exited).find((item) => item.id === "kill")).toMatchObject({ label: "Remove Terminal…", danger: true });

		const file = ids(tabMenuItems(ws, "file:/p/a.ts", run));
		for (const id of ["find", "upload", "split-pane-right", "split-pane-down", "kill"]) expect(file).not.toContain(id);
	});

	it("opens the menu with the terminal's actions from the tab itself", () => {
		const { slots, commands } = fakeSlots();
		render(view(base(), [info("t1")], slots, actions()));
		fireEvent.contextMenu(strip().querySelector("[data-tab-id='term:1']")!);
		const menu = document.querySelector<HTMLElement>("[data-tab-menu='term:1']")!;
		fireEvent.click(within(menu).getByRole("menuitem", { name: /Find/ }));
		expect(commands).toEqual([["t1", "find"]]);
	});
});
