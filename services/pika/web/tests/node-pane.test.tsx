import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { homePath, paneLabel, paneSession } from "../src/nodes/client";
import type { BridgeStatus, PaneView, TerminalInfo } from "../src/nodes/contract";
import { PaneHeading } from "../src/pages/Deck";

const shell: TerminalInfo = { terminalId: "t1", title: "", cwd: "/home/me", cols: 80, rows: 24, pid: 7, createdAt: 1, argv: [] };

const bridge = (overrides: Partial<BridgeStatus> = {}): BridgeStatus => ({
	state: "idle",
	activities: [],
	activityCount: 0,
	session: { id: "s1", name: "fix the parser", cwd: "/home/me/code/pika" },
	model: "magpie/claude-opus-5-5",
	updatedAt: 1,
	...overrides,
});

const pane = (status: Partial<PaneView> & { bridge?: BridgeStatus }, info: Partial<TerminalInfo> = {}): TerminalInfo => ({
	...shell,
	...info,
	status: { state: "idle", bridgeConnected: true, unread: false, ...status },
});

describe("paneLabel", () => {
	it("prefers the pi session's name, then the terminal title, then argv[0], then Shell", () => {
		const titled = { title: "π - pika", argv: ["/bin/bash", "-l"] };
		expect(paneLabel(pane({ bridge: bridge() }, titled))).toBe("fix the parser");
		expect(paneLabel(pane({ bridge: bridge({ session: { id: "s1", cwd: "/home/me" } }) }, titled))).toBe("π - pika");
		expect(paneLabel({ ...shell, ...titled })).toBe("π - pika");
		expect(paneLabel({ ...shell, argv: ["/bin/bash", "-l"] })).toBe("/bin/bash");
		expect(paneLabel(shell)).toBe("Shell");
	});

	it("keeps a closed bridge's session name, and cleans it", () => {
		expect(paneLabel(pane({ bridge: bridge(), bridgeConnected: false }, { title: "bash" }))).toBe("fix the parser");
		const sneaky = bridge({ session: { id: "s1", name: "\x1b]0;evil\x07\x1b[31m", cwd: "/home/me" } });
		expect(paneLabel(pane({ bridge: sneaky }, { title: "bash" }))).toBe("bash");
	});
});

describe("homePath", () => {
	it("writes the node's home as ~, only on a path boundary", () => {
		expect(homePath("/home/me", "/home/me")).toBe("~");
		expect(homePath("/home/me/code/pika", "/home/me")).toBe("~/code/pika");
		expect(homePath("/home/merge", "/home/me")).toBe("/home/merge");
		expect(homePath("/srv/data", "/home/me")).toBe("/srv/data");
		expect(homePath("/etc", "/")).toBe("/etc");
		expect(homePath("/home/me", undefined)).toBe("/home/me");
	});
});

describe("paneSession", () => {
	it("shows the session's cwd and the model while the bridge is open", () => {
		expect(paneSession(pane({ bridge: bridge() }))).toEqual({
			name: "fix the parser",
			cwd: "/home/me/code/pika",
			model: "magpie/claude-opus-5-5",
			disconnected: false,
		});
	});

	it("keeps a closed bridge's session, marked disconnected, without its model", () => {
		expect(paneSession(pane({ bridge: bridge(), bridgeConnected: false }))).toEqual({
			name: "fix the parser",
			cwd: "/home/me/code/pika",
			disconnected: true,
		});
	});

	it("falls back to the terminal's cwd, and marks nothing, without a bridge or once the terminal exited", () => {
		expect(paneSession(shell)).toEqual({ cwd: "/home/me", disconnected: false });
		expect(paneSession(pane({ program: { state: "idle", app: "pi", at: 1 }, bridgeConnected: false }))).toEqual({ cwd: "/home/me", disconnected: false });
		const exited = pane({ bridge: bridge(), bridgeConnected: false }, { exited: { code: 0, signal: null } });
		expect(paneSession(exited).disconnected).toBe(false);
	});
});

describe("PaneHeading", () => {
	const heading = (terminal?: TerminalInfo) => render(<PaneHeading node="node01" terminal={terminal} home="/home/me" />).container;

	it("shows the session name, cwd under ~, and the bare model", () => {
		const container = heading(pane({ bridge: bridge() }));
		expect(container.querySelector("[data-session-name]")?.textContent).toBe("fix the parser");
		expect(container.querySelector("[data-pane-cwd]")?.textContent).toBe("~/code/pika");
		expect(container.querySelector("[data-pane-cwd]")?.getAttribute("data-tip")).toBe("/home/me/code/pika");
		expect(container.querySelector("[data-pane-model]")?.textContent).toBe("claude-opus-5-5");
		expect(container.querySelector("[data-bridge-disconnected]")).toBeNull();
	});

	it("marks a closed bridge and keeps its session, but not its model", () => {
		const container = heading(pane({ bridge: bridge(), bridgeConnected: false }));
		expect(screen.getByText("Bridge disconnected")).toBeTruthy();
		expect(container.querySelector("[data-session-name]")?.textContent).toBe("fix the parser");
		expect(container.querySelector("[data-pane-cwd]")?.textContent).toBe("~/code/pika");
		expect(container.querySelector("[data-pane-model]")).toBeNull();
	});

	it("is the node and the terminal's cwd for a plain shell, and the node alone without a terminal", () => {
		const container = heading(shell);
		expect(container.querySelector("[data-session-name]")).toBeNull();
		expect(container.querySelector("[data-pane-cwd]")?.textContent).toBe("~");
		expect(container.querySelector("[data-bridge-disconnected]")).toBeNull();
		expect(heading().textContent).toBe("node01");
	});
});
