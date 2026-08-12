import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatWorkerElapsed, HerderWidget, workerFleetTreeLines, type HerderWidgetModel } from "../../../adapters/worker-fleet.ts";
import type { PiNestedAgentSnapshot, PiWorkerSnapshot } from "../../../adapters/worker-engine.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function nested(overrides: Partial<PiNestedAgentSnapshot> = {}): PiNestedAgentSnapshot {
	return {
		agentId: "nested-1",
		displayName: "Recon",
		type: "recon",
		description: "inspect code",
		status: "running",
		model: "gpt-5.6-sol",
		effort: "xhigh",
		startedAt: 6_000,
		turns: 1,
		toolUses: 2,
		lifetimeTokens: 2_500,
		contextPercent: 34.4,
		compactionCount: 1,
		activeTools: ["read"],
		...overrides,
	};
}

function worker(overrides: Partial<PiWorkerSnapshot> = {}): PiWorkerSnapshot {
	return {
		handle: "pi-worker:one",
		actionId: "action-1",
		planId: "018",
		round: 2,
		role: "plan-reviewer",
		model: "gpt-5.6-sol",
		effort: "xhigh",
		status: "running",
		startedAt: 1_000,
		turns: 2,
		toolUses: 3,
		lifetimeTokens: 12_400,
		contextPercent: 72.2,
		compactionCount: 2,
		activeTools: ["bash"],
		children: [],
		...overrides,
	};
}

function model(workers: PiWorkerSnapshot[]): HerderWidgetModel {
	return {
		status: "running",
		profile: "eclipse",
		maxParallel: 5,
		planName: "herder-plans",
		summaryLine: "1/3 done · 2 in progress · 0 rejected",
		dashboardUrl: "http://127.0.0.1:4312/",
		workers,
	};
}

test("Pi worker fleet flattens Plan and Role and renders direct child stats on one line", () => {
	const child = nested();
	const lines = workerFleetTreeLines(model([
		worker({ children: [child] }),
		worker({
			handle: "pi-worker:two",
			actionId: "action-2",
			planId: "019",
			role: "plan-implementer",
			activeTools: [],
			activity: "edit",
			children: [],
		}),
	]), theme, 160, 66_000, 0);

	assert.equal(lines[0], " Herder  RUNNING ·  Dashboard http://127.0.0.1:4312/ ·  eclipse ·  max 5 ·  herder-plans ·  Progress 1/3 done · 2 in progress · 0 rejected");
	assert.match(lines[1]!, /^├─ Plan 018 · ⠋ Reviewer  running command…\s+r2 · ↻2 · 3 tools · 12\.4k \(72% · ⇊2\) · 1m 05s$/);
	assert.match(lines[2]!, /^│ {13}└─ ⠋ Recon  reading…\s+↻1 · 2 tools · 2\.5k \(34% · ⇊1\) · 1m 00s$/);
	assert.match(lines[3]!, /^└─ Plan 019 · ⠋ Implementer  editing…\s+r2 · ↻2 · 3 tools · 12\.4k \(72% · ⇊2\) · 1m 05s$/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 160));
});

test("nested connector alignment retains the outer plan sibling stem", () => {
	const lines = workerFleetTreeLines(model([
		worker({ children: [nested()] }),
		worker({ handle: "pi-worker:two", actionId: "action-2", planId: "019" }),
	]), theme, 100, 66_000, 0);
	assert.equal(lines[1]!.indexOf("⠋"), lines[2]!.indexOf("└─"));
	assert.equal(lines[2]![0], "│");
	assert.equal(lines[3]![0], "└");
});

test("aborted nested agents render as failures", () => {
	const lines = workerFleetTreeLines(model([
		worker({ children: [nested({ status: "aborted", activeTools: [], activity: "aborted" })] }),
	]), theme, 120, 66_000, 0);
	assert.match(lines[2]!, /✗ Recon  aborted\s+↻1/);
});

test("worker fleet overflow counts direct nested rows and respects narrow widths", () => {
	const workers = [worker({ children: [nested(), nested({ agentId: "nested-2" })] }), worker({ handle: "pi-worker:two", actionId: "action-2", planId: "019" })];
	const overflow = workerFleetTreeLines(model(workers), theme, 80, 66_000, 0, 2);
	assert.equal(overflow.length, 4);
	assert.equal(overflow[3], "└─ +2 more agents");
	assert.ok(overflow.every((line) => visibleWidth(line) <= 80));

	for (const width of [1, 4, 12, 24]) {
		const narrow = workerFleetTreeLines(model(workers), theme, width, 66_000, 0);
		assert.ok(narrow.length > 1);
		assert.ok(narrow.every((line) => visibleWidth(line) <= width));
	}
});

test("paused worker fleet renders the manager reason instead of a dispatch wait", () => {
	const paused = { ...model([]), status: "paused" as const, idleDetail: "Waiting for the main Pi session to submit a replacement verification manifest." };
	const lines = workerFleetTreeLines(paused, theme, 160);
	assert.equal(lines[1], "└─ Waiting for the main Pi session to submit a replacement verification manifest.");
});

test("worker elapsed time uses compact whole-second formatting", () => {
	assert.equal(formatWorkerElapsed(1_000, 1_050), "0s");
	assert.equal(formatWorkerElapsed(1_000, 2_250), "1s");
	assert.equal(formatWorkerElapsed(1_000, 66_250), "1m 05s");
	assert.equal(formatWorkerElapsed(1_000, 582_000), "9m 41s");
	assert.equal(formatWorkerElapsed(1_000, 3_667_250), "1h 01m 06s");
});

test("live widget registers once and requests lightweight rerenders", () => {
	let setWidgetCalls = 0;
	let requestRenderCalls = 0;
	let factory: ((tui: TUI, theme: Theme) => Component) | undefined;
	const ui = {
		theme,
		setWidget: (_key: string, content: string[] | ((tui: TUI, theme: Theme) => Component) | undefined) => {
			setWidgetCalls += 1;
			factory = typeof content === "function" ? content : undefined;
		},
	} as unknown as ExtensionContext["ui"];
	const ctx = { mode: "tui", ui } as unknown as ExtensionContext;
	const widget = new HerderWidget();
	const current = model([worker({ startedAt: Date.now(), round: 1, role: "plan-implementer", turns: 0, toolUses: 0, lifetimeTokens: 0, contextPercent: null, compactionCount: 0, activeTools: [] })]);

	widget.update(ctx, current);
	assert.equal(setWidgetCalls, 1);
	const component = factory!({ requestRender: () => { requestRenderCalls += 1; } } as unknown as TUI, theme);
	assert.ok(component.render(100).length > 0);
	widget.update(ctx, current);
	assert.equal(setWidgetCalls, 1);
	assert.equal(requestRenderCalls, 1);
	widget.dispose();
});
