import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeView } from "../src/nodes/client";
import type { PaneView, TerminalInfo } from "../src/nodes/contract";
import { DK_TOKENS } from "../src/nodes/deck/tokens";
import { AgentRail, loadRailPrefs, RAIL_KEY, railAgents, useInbox } from "../src/nodes/workspace/AgentRail";
import { OTHER } from "../src/nodes/workspace/store";

const pane = (id: string, status?: Partial<PaneView>, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
	terminalId: id,
	title: id,
	cwd: "/home/me/repo",
	cols: 80,
	rows: 24,
	pid: 1,
	createdAt: 1,
	argv: ["pi"],
	...(status ? { status: { state: "idle", bridgeConnected: false, unread: false, ...status } } : {}),
	...extra,
});

const node = (id: string, terminals: TerminalInfo[], ready = true): NodeView =>
	({
		info: { id, name: id, online: ready },
		pin: { node: id, fingerprint: "f", publicKey: "k", name: id, pinnedAt: 0 },
		link: ready ? { kind: "ready", welcome: { home: "/home/me" } } : { kind: "idle" },
		terminals,
		listed: ready,
		epoch: 1,
	}) as unknown as NodeView;

interface Calls {
	agent: string[];
	kill: string[];
	close: string[];
}

function Harness({ nodes, calls, selected }: { nodes: NodeView[]; calls: Calls; selected?: string }) {
	const [hovering, setHovering] = useState(false);
	const agents = useMemo(() => railAgents(nodes, () => "/home/me/repo"), [nodes]);
	const map = useMemo(() => new Map(agents.map((agent) => [agent.key, agent])), [agents]);
	const inbox = useInbox(agents, selected, hovering);
	return (
		<div data-deck="">
			<AgentRail
				nodes={nodes}
				agents={map}
				inbox={inbox}
				{...(selected ? { selected } : {})}
				projectsOf={() => [{ name: "repo", path: "/home/me/repo" }]}
				homeOf={() => "/home/me"}
				onHover={setHovering}
				onAgent={(key) => calls.agent.push(key)}
				onNode={() => {}}
				onProject={() => {}}
				canClosePane={(key) => key.endsWith("busy")}
				onClosePane={(key) => calls.close.push(key)}
				onKill={(key) => calls.kill.push(key)}
				header={<h1>Nodes</h1>}
			/>
		</div>
	);
}

const sectionKeys = (container: HTMLElement, section: string) =>
	[...container.querySelectorAll(`[data-rail-section='${section}'] [data-agent-row]`)].map((row) => row.getAttribute("data-agent-row"));

describe("the agent rail", () => {
	let calls: Calls;
	beforeEach(() => {
		localStorage.clear();
		// jsdom lays nothing out.
		Element.prototype.scrollIntoView = () => {};
		calls = { agent: [], kill: [], close: [] };
	});
	afterEach(() => vi.useRealTimers());

	it("sorts every node's agents into sections, needing the user on top, Quiet folded with its count", () => {
		const nodes = [
			node("mac", [
				pane("ask", { state: "waiting", program: { state: "blocked", app: "pi", kind: "permission", message: "Import session?", at: 1 } }),
				pane("busy", { state: "busy" }),
				pane("idle", { state: "idle" }),
			]),
			node("node01", [pane("crash", undefined, { exited: { code: 1, signal: null } }), pane("fin", { state: "idle", unread: true })]),
		];
		const { container } = render(<Harness nodes={nodes} calls={calls} />);
		expect([...container.querySelectorAll("[data-rail-section]")].map((item) => item.getAttribute("data-rail-section"))).toEqual(["needs", "failed", "done", "working", "quiet"]);
		expect(sectionKeys(container, "needs")).toEqual(["ask"]);
		expect(sectionKeys(container, "failed")).toEqual(["crash"]);
		expect(sectionKeys(container, "done")).toEqual(["fin"]);
		expect(sectionKeys(container, "working")).toEqual(["busy"]);
		// Quiet starts folded: its header and count only.
		expect(sectionKeys(container, "quiet")).toEqual([]);
		const quiet = container.querySelector<HTMLElement>("[data-section-toggle='quiet']")!;
		expect(quiet.getAttribute("aria-expanded")).toBe("false");
		expect(quiet.textContent).toBe("Quiet1");
		fireEvent.click(quiet);
		expect(sectionKeys(container, "quiet")).toEqual(["idle"]);
		expect(JSON.parse(localStorage.getItem(RAIL_KEY)!).collapsed).toEqual([]);

		const ask = container.querySelector<HTMLElement>("[data-terminal='ask']")!;
		expect(within(ask).getByText("Permission")).toBeTruthy();
		expect(ask.querySelector("[data-attention]")!.textContent).toBe("Import session?");
		expect(ask.textContent).toContain("repo · mac");
		expect(container.querySelector("[data-terminal='crash'] [data-attention]")!.textContent).toBe("Exited with code 1");
		expect(container.querySelector("[data-terminal='fin'] [aria-label='Unread']")).not.toBeNull();
	});

	it("says calmly that nothing needs the user, and hides other empty sections", () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("busy", { state: "busy" })])]} calls={calls} />);
		expect(container.querySelector("[data-nothing-needs-you]")!.textContent).toBe("Nothing needs you");
		expect(container.querySelector("[data-rail-section='failed']")).toBeNull();
		expect(container.querySelector("[data-rail-section='done']")).toBeNull();
	});

	it("keeps rows in place while the pointer is over the list, and sorts them when it leaves", () => {
		const first = [node("mac", [pane("a", { state: "busy" }), pane("b", { state: "idle", unread: true })])];
		const { container, rerender } = render(<Harness nodes={first} calls={calls} />);
		const list = container.querySelector<HTMLElement>("[data-rail-list]")!;
		fireEvent.pointerEnter(list);
		rerender(<Harness nodes={[node("mac", [pane("a", { state: "waiting" }), pane("b", { state: "idle", unread: true })])]} calls={calls} />);
		// Its glyph says it needs the user at once; its place does not change under the pointer.
		expect(sectionKeys(container, "working")).toEqual(["a"]);
		expect(container.querySelector("[data-terminal='a']")!.getAttribute("data-pane-state")).toBe("waiting");
		fireEvent.pointerLeave(list);
		expect(sectionKeys(container, "needs")).toEqual(["a"]);
		expect(sectionKeys(container, "working")).toEqual([]);
	});

	it("keeps an agent that stopped working in Working for two seconds", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
		const { container, rerender } = render(<Harness nodes={[node("mac", [pane("a", { state: "busy" })])]} calls={calls} />);
		rerender(<Harness nodes={[node("mac", [pane("a", { state: "idle", unread: true })])]} calls={calls} />);
		expect(sectionKeys(container, "working")).toEqual(["a"]);
		act(() => vi.advanceTimersByTime(2_100));
		expect(sectionKeys(container, "working")).toEqual([]);
		expect(sectionKeys(container, "done")).toEqual(["a"]);
	});

	it("ticks a working agent's time from a shared clock", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
		vi.setSystemTime(100_000);
		const { container } = render(<Harness nodes={[node("mac", [pane("a", { state: "busy", program: { state: "working", app: "pi", at: 100_000 } })])]} calls={calls} />);
		const slot = () => container.querySelector("[data-terminal='a'] [data-status-slot]")!.textContent;
		expect(slot()).toBe("0s");
		act(() => vi.advanceTimersByTime(134_000));
		expect(slot()).toBe("2m14s");
	});

	it("opens an agent on click, and offers closing its pane and killing it without moving the row", () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("busy", { state: "busy" }), pane("gone", { state: "idle" }, { exited: { code: 0, signal: null } })])]} calls={calls} />);
		fireEvent.click(container.querySelector<HTMLElement>("[data-agent-row='busy']")!);
		expect(calls.agent).toEqual(["mac\nbusy"]);
		const busy = container.querySelector<HTMLElement>("[data-terminal='busy']")!;
		fireEvent.click(within(busy).getByRole("button", { name: "Close busy's pane" }));
		fireEvent.click(within(busy).getByRole("button", { name: "Kill busy" }));
		expect(calls.close).toEqual(["mac\nbusy"]);
		expect(calls.kill).toEqual(["mac\nbusy"]);
		fireEvent.click(container.querySelector<HTMLElement>("[data-section-toggle='quiet']")!);
		const gone = container.querySelector<HTMLElement>("[data-terminal='gone']")!;
		expect(within(gone).queryByRole("button", { name: /Close/ })).toBeNull();
		expect(within(gone).getByRole("button", { name: "Remove gone" })).toBeTruthy();
		expect(gone.querySelector("[data-status-slot]")!.textContent).toBe("Exited");
	});

	it("dims a disconnected node's agents and marks the node on the row", () => {
		const { container } = render(<Harness nodes={[node("node01", [pane("w", { state: "busy" })], false)]} calls={calls} />);
		const row = container.querySelector<HTMLElement>("[data-terminal='w']")!;
		expect(row.querySelector("[data-agent-row]")!.className).toContain("opacity-60");
		expect(row.querySelector("[data-row-node-state='offline']")).not.toBeNull();
		expect(container.querySelector("[data-node-strip] [data-node='node01']")!.getAttribute("data-node-state")).toBe("offline");
	});

	it("lists a live bridge's background activities under their agent, each opening it", () => {
		const bridge = {
			state: "busy" as const,
			activities: [
				{ source: "subagents", id: "s1", label: "reviewer", state: "running" as const, progress: { completed: 2, total: 5 } },
				{ source: "herder", id: "h1", label: "step 3", state: "waiting" as const },
			],
			activityCount: 2,
			updatedAt: 1,
		};
		const { container } = render(<Harness nodes={[node("mac", [pane("p", { state: "waiting", bridgeConnected: true, bridge })])]} calls={calls} />);
		const rows = [...container.querySelectorAll<HTMLElement>("[data-terminal='p'] [data-activities] [data-activity-row]")];
		expect(rows.map((row) => row.getAttribute("data-activity-row"))).toEqual(["h1", "s1"]);
		expect(rows[1]!.textContent).toContain("2/5");
		fireEvent.click(rows[0]!);
		expect(calls.agent).toEqual(["mac\np"]);
	});

	it("moves focus between rows with the arrow keys and folds sections with left and right", () => {
		const { container } = render(<Harness nodes={[node("mac", [pane("a", { state: "waiting" }), pane("b", { state: "busy" })])]} calls={calls} />);
		const a = container.querySelector<HTMLElement>("[data-agent-row='a']")!;
		a.focus();
		fireEvent.keyDown(a, { key: "ArrowDown" });
		expect(document.activeElement?.getAttribute("data-section-toggle")).toBe("working");
		fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
		expect(sectionKeys(container, "working")).toEqual([]);
		fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
		expect(sectionKeys(container, "working")).toEqual(["b"]);
		fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
		expect(document.activeElement?.getAttribute("data-agent-row")).toBe("b");
		fireEvent.keyDown(document.activeElement!, { key: "Home" });
		expect(document.activeElement?.getAttribute("data-section-toggle")).toBe("needs");
	});

	it("groups by node and project in the Projects view, a folded card showing its strongest state and count", () => {
		const nodes = [node("mac", [pane("a", { state: "waiting" }), pane("b", { state: "busy" })])];
		const { container } = render(<Harness nodes={nodes} calls={calls} />);
		fireEvent.click(screen.getByRole("button", { name: "Projects" }));
		expect(loadRailPrefs().view).toBe("projects");
		const card = container.querySelector<HTMLElement>("[data-project-card='/home/me/repo']")!;
		expect([...card.querySelectorAll("[data-agent-row]")].map((row) => row.getAttribute("data-agent-row"))).toEqual(["a", "b"]);
		fireEvent.click(within(card).getByRole("button", { name: "Fold repo" }));
		expect(card.querySelectorAll("[data-agent-row]")).toHaveLength(0);
		expect(card.querySelector("[data-pane-mark='waiting']")).not.toBeNull();
		expect(card.textContent).toContain("2");
		expect(OTHER).toBeTruthy();
	});
});

describe("the Deck tokens", () => {
	it("gives the terminal and Monaco the values deck.css sets", () => {
		const css = readFileSync("src/nodes/deck/deck.css", "utf8");
		const light = css.slice(css.indexOf("[data-deck] {"), css.indexOf('[data-theme="dark"] [data-deck]'));
		const dark = css.slice(css.indexOf('[data-theme="dark"] [data-deck]'), css.indexOf("@theme inline"));
		const value = (block: string, name: string) => block.match(new RegExp(`--dk-${name}: (#[0-9a-f]{6});`))?.[1];
		const names = { ground: "ground", chrome: "chrome", line: "line", ink: "ink", ink2: "ink-2", accent: "accent" } as const;
		for (const [key, name] of Object.entries(names)) {
			expect(value(light, name), name).toBe(DK_TOKENS.light[key as keyof typeof names]);
			expect(value(dark, name), name).toBe(DK_TOKENS.dark[key as keyof typeof names]);
		}
	});
});
