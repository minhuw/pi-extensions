import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeChannel } from "../src/nodes/channel";
import type { TerminalInfo } from "../src/nodes/contract";
import { EditorStore } from "../src/nodes/editor";
import { WebglRenderer, type Renderer } from "../src/nodes/renderer";
import { addTab, createWorkspace, moveTab, splitTab, terminalTab, type Workspace } from "../src/nodes/workspace/model";
import { SlotRegistry } from "../src/nodes/workspace/slots";
import { setupOutcome } from "../src/nodes/workspace/SetupFooter";
import { paneMark, strongestMark } from "../src/nodes/workspace/status";
import { TerminalLayer, type LayerTerminal } from "../src/nodes/workspace/TerminalLayer";
import { WorkspaceView, type WorkspaceActions } from "../src/nodes/workspace/WorkspaceView";

/** Each terminal view's constructions and the `visible` it was last given. */
const built = new Map<string, number>();
const shown = new Map<string, boolean>();

// The real view needs a browser's canvas; this one counts what the layer does to it.
vi.mock("../src/nodes/TerminalView", () => ({
	TerminalView: ({ terminal, visible }: { terminal: TerminalInfo; visible?: boolean }) => {
		useEffect(() => {
			built.set(terminal.terminalId, (built.get(terminal.terminalId) ?? 0) + 1);
		}, [terminal.terminalId]);
		shown.set(terminal.terminalId, visible !== false);
		return <div data-stub-terminal={terminal.terminalId} />;
	},
}));

class StubResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

const info = (terminalId: string): TerminalInfo => ({ terminalId, title: "", cwd: "/p", cols: 80, rows: 24, pid: 1, createdAt: 1, argv: ["bash"] });

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

/** The page's arrangement in small: the project's workspace on screen, and one layer drawing every placed terminal. */
function Page({ ws, registry, terminals }: { ws: Workspace | undefined; registry: SlotRegistry; terminals: string[] }) {
	const entries: LayerTerminal[] = terminals.map((id) => ({ node: "n1", epoch: 1, channel: {} as NodeChannel, terminal: info(id), home: "/home/me" }));
	return (
		<div>
			{ws && (
				<WorkspaceView
					node="n1"
					nodeName="node01"
					home="/home/me"
					ws={ws}
					terminals={new Map(terminals.map((id) => [id, info(id)]))}
					editors={new EditorStore()}
					editorSnapshot={{ tabs: [] }}
					editorKeys={[]}
					slots={registry.forNode("n1")}
					theme="light"
					diffInline={false}
					onDiffInline={() => {}}
					actions={actions()}
					onLayout={() => registry.layoutChanged()}
				/>
			)}
			<TerminalLayer registry={registry} terminals={entries} theme="light" onFocus={() => {}} onKill={() => {}} onOpenFile={() => {}} onSeen={() => {}} onSetupAction={async () => {}} />
		</div>
	);
}

/** Lets the registry's deferred slot releases run. */
const flush = () => act(async () => {});

beforeEach(() => {
	built.clear();
	shown.clear();
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	// Slots on the page have a box; everything else measures as nothing, as hidden elements do.
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const size = this.hasAttribute("data-pane-slot") && this.isConnected ? { width: 400, height: 300 } : { width: 0, height: 0 };
		return { left: 0, top: 0, x: 0, y: 0, right: size.width, bottom: size.height, ...size, toJSON: () => ({}) } as DOMRect;
	});
});

describe("the terminal layer", () => {
	it("builds each terminal once across moves, splits, tab switches, and project switches", async () => {
		const registry = new SlotRegistry();
		let ws = createWorkspace("g1");
		ws = addTab(ws, terminalTab("a", "term:a"));
		ws = addTab(ws, terminalTab("b", "term:b"));
		const view = render(<Page ws={ws} registry={registry} terminals={["a", "b"]} />);
		await flush();
		expect(built).toEqual(new Map([["a", 1], ["b", 1]]));
		// b is the active tab: a has no slot on screen and hides.
		expect(shown.get("b")).toBe(true);
		expect(shown.get("a")).toBe(false);

		// Split b into a group of its own: both show, neither is built again.
		ws = splitTab(ws, "term:b", "g1", "right", "g2");
		view.rerender(<Page ws={ws} registry={registry} terminals={["a", "b"]} />);
		await flush();
		expect(shown.get("a")).toBe(true);
		expect(shown.get("b")).toBe(true);

		// Move a into b's group, behind b; then the other way.
		ws = moveTab(ws, "term:a", "g2");
		view.rerender(<Page ws={ws} registry={registry} terminals={["a", "b"]} />);
		await flush();
		expect(shown.get("a")).toBe(true);
		expect(shown.get("b")).toBe(false);
		ws = moveTab(ws, "term:b", "g2", 0);
		view.rerender(<Page ws={ws} registry={registry} terminals={["a", "b"]} />);
		await flush();
		expect(shown.get("b")).toBe(true);

		// Another project on screen: both hide; back again: both draw where they were.
		view.rerender(<Page ws={createWorkspace("other")} registry={registry} terminals={["a", "b"]} />);
		await flush();
		expect(shown.get("a")).toBe(false);
		expect(shown.get("b")).toBe(false);
		view.rerender(<Page ws={ws} registry={registry} terminals={["a", "b"]} />);
		await flush();
		expect(shown.get("b")).toBe(true);

		expect(built).toEqual(new Map([["a", 1], ["b", 1]]));
		expect(view.container.querySelectorAll("[data-stub-terminal]")).toHaveLength(2);
		// The layer's boxes sit outside the workspace: the workspace draws slots only.
		expect(view.container.querySelector("[data-workspace] [data-stub-terminal]")).toBeNull();
	});
});

/** A WebGL addon double that records whether it is still held. */
class FakeAddon {
	disposed = false;
	lose: (() => void) | undefined;
	onContextLoss(listener: () => void) {
		this.lose = listener;
	}
	dispose() {
		this.disposed = true;
	}
}

describe("the WebGL renderer", () => {
	it("holds a context only while the terminal shows, and takes one again after a loss", () => {
		const made: FakeAddon[] = [];
		const loaded: FakeAddon[] = [];
		const states: Renderer[] = [];
		const renderer = new WebglRenderer<FakeAddon>({ loadAddon: (addon) => loaded.push(addon) }, () => (made.push(new FakeAddon()), made.at(-1)!), (state) => states.push(state), true);
		expect(renderer.loaded).toBe(false);
		renderer.show();
		renderer.show();
		expect(loaded).toHaveLength(1);
		expect(renderer.state).toBe("webgl");
		renderer.hide();
		expect(made[0]!.disposed).toBe(true);
		expect(renderer.loaded).toBe(false);
		expect(renderer.state).toBe("hidden");
		renderer.show();
		expect(loaded).toHaveLength(2);
		made[1]!.lose!();
		expect(made[1]!.disposed).toBe(true);
		expect(renderer.state).toBe("context-lost");
		renderer.show();
		expect(renderer.state).toBe("webgl");
		renderer.dispose();
		expect(made.every((addon) => addon.disposed)).toBe(true);
		expect(states).toEqual(["hidden", "webgl", "hidden", "webgl", "context-lost", "webgl"]);
	});

	it("never loads without WebGL2, and stays on the DOM renderer after a failed start", () => {
		const host = { loadAddon: vi.fn() };
		const none = new WebglRenderer(host, () => new FakeAddon(), () => {}, false);
		none.show();
		expect(host.loadAddon).not.toHaveBeenCalled();
		expect(none.state).toBe("no-webgl");
		const failing = new WebglRenderer(host, () => {
			throw new Error("no context");
		}, () => {}, true);
		failing.show();
		failing.show();
		expect(failing.state).toBe("webgl-failed");
		expect(host.loadAddon).not.toHaveBeenCalled();
	});
});

describe("pane marks", () => {
	const pane = (more: Partial<TerminalInfo>): TerminalInfo => ({ ...info("t"), ...more });
	it("say waiting, working, done, an error exit, or a plain exit; a tab shows its loudest pane", () => {
		expect(paneMark(pane({ status: { state: "waiting", bridgeConnected: false, unread: false } }))).toBe("waiting");
		expect(paneMark(pane({ status: { state: "busy", bridgeConnected: false, unread: false } }))).toBe("working");
		expect(paneMark(pane({ status: { state: "idle", bridgeConnected: false, unread: true } }))).toBe("done");
		expect(paneMark(pane({ exited: { code: 2, signal: null } }))).toBe("error");
		expect(paneMark(pane({ exited: { code: null, signal: "SIGHUP" } }))).toBe("exited");
		expect(paneMark(pane({ exited: { code: 0, signal: null } }))).toBe("exited");
		expect(strongestMark(["idle", "done", "waiting", "working"])).toBe("waiting");
		expect(strongestMark(["idle", "working"])).toBe("working");
	});
});

describe("the setup footer", () => {
	it("says a script finished, failed with its code, or was stopped by a signal", () => {
		expect(setupOutcome({ code: 0, signal: null })).toEqual({ mark: "done", text: "Setup finished" });
		expect(setupOutcome({ code: 127, signal: null })).toEqual({ mark: "error", text: "Setup failed (exit 127)" });
		expect(setupOutcome({ code: null, signal: "SIGHUP" })).toEqual({ mark: "exited", text: "Setup stopped (SIGHUP)" });
	});
});
