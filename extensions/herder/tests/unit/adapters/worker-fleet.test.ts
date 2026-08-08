import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatWorkerElapsed, HerderWidget, workerFleetTreeLines } from "../../../adapters/worker-fleet.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("Pi worker fleet renders a plan and worker hierarchy", () => {
	const lines = workerFleetTreeLines({
		status: "running",
		profile: "eclipse",
		maxParallel: 5,
		planName: "herder-plans",
		summaryLine: "1/3 done · 2 in progress · 0 rejected",
		dashboardUrl: "http://127.0.0.1:4312/",
		workers: [{
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
			tokens: 12_400,
			activity: "bash",
		}],
	}, theme, 160, 66_000, 0);

	assert.equal(lines[0], " Herder  RUNNING ·  Dashboard http://127.0.0.1:4312/ ·  eclipse ·  max 5 ·  herder-plans ·  Progress 1/3 done · 2 in progress · 0 rejected");
	assert.equal(lines[1], "└─ Plan 018");
	assert.match(lines[2]!, /^   └─ ⠋ Reviewer  running command…\s+r2 · ↻2 · 3 tools · 12\.4k · 1m 05s$/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 160));
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
	const model = {
		status: "running" as const,
		profile: "eclipse",
		maxParallel: 5,
		planName: "herder-plans",
		workers: [{
			handle: "pi-worker:one",
			actionId: "action-1",
			planId: "018",
			round: 1,
			role: "plan-implementer" as const,
			model: "gpt-5.6-sol",
			effort: "xhigh",
			status: "running" as const,
			startedAt: Date.now(),
			turns: 0,
			toolUses: 0,
			tokens: 0,
		}],
	};

	widget.update(ctx, model);
	assert.equal(setWidgetCalls, 1);
	const component = factory!({ requestRender: () => { requestRenderCalls += 1; } } as unknown as TUI, theme);
	assert.ok(component.render(100).length > 0);
	widget.update(ctx, model);
	assert.equal(setWidgetCalls, 1);
	assert.equal(requestRenderCalls, 1);
	widget.dispose();
});
