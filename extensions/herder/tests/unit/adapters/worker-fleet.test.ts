import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatAgentIdentity, formatWorkerElapsed, HerderWidget, workerFleetTreeLines, type HerderWidgetModel } from "../../../adapters/worker-fleet.ts";
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
		serviceTier: "fast",
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
		serviceTier: "fast",
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
	assert.match(lines[1]!, /^├─ Plan 018 · ⠋ Reviewer · gpt-5\.6-sol · xhigh · fast  running command…\s+r2 · ↻2 · 3 tools · 12\.4k \(72% · ⇊2\) · 1m 05s$/);
	assert.match(lines[2]!, /^│ {13}└─ ⠋ Recon · gpt-5\.6-sol · xhigh · fast  reading…\s+↻1 · 2 tools · 2\.5k \(34% · ⇊1\) · 1m 00s$/);
	assert.match(lines[3]!, /^└─ Plan 019 · ⠋ Implementer · gpt-5\.6-sol · xhigh · fast  editing…\s+r2 · ↻2 · 3 tools · 12\.4k \(72% · ⇊2\) · 1m 05s$/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 160));
});

test("agent identity is model · thinking · service tier and omits missing fields", () => {
	assert.equal(formatAgentIdentity({ model: "gpt-5.6-sol", effort: "xhigh", serviceTier: "fast" }), "gpt-5.6-sol · xhigh · fast");
	assert.equal(formatAgentIdentity({ model: "gpt-5.6-sol", effort: "max" }), "gpt-5.6-sol · max");
	assert.equal(formatAgentIdentity({ model: "gpt-5.6-sol" }), "gpt-5.6-sol");
	assert.equal(formatAgentIdentity({}), undefined);
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
	assert.match(lines[2]!, /✗ Recon · gpt-5\.6-sol · xhigh · fast  aborted\s+↻1/);
});

test("reviewer scouts render beneath their owner and retain timeout evidence", () => {
	const children = [
		nested({ agentId: "review-1", type: "reviewer", displayName: "Reviewer" }),
		nested({ agentId: "scout-1", parentAgentId: "review-1", status: "timed_out", activeTools: [], completedAt: 3_606_000 }),
		nested({ agentId: "review-2", type: "reviewer", displayName: "Reviewer" }),
		nested({ agentId: "scout-2", parentAgentId: "review-2" }),
	];
	const lines = workerFleetTreeLines(model([worker({ children })]), theme, 160, 3_606_000, 0);
	assert.equal(lines.length, 6);
	assert.match(lines[2]!, /├─ ⠋ Reviewer/);
	assert.match(lines[3]!, /│  └─ ✗ Recon.*timed_out.*1h 00m 00s$/);
	assert.match(lines[4]!, /└─ ⠋ Reviewer/);
	assert.match(lines[5]!, /   └─ ⠋ Recon/);
	assert.equal(lines[3]!.indexOf("└─"), lines[2]!.indexOf("├─") + 3);
	assert.equal(lines[5]!.indexOf("└─"), lines[4]!.indexOf("└─") + 3);
	assert.ok(lines.every((line) => visibleWidth(line) <= 160));
});

test("second-level scouts use compact inline stats without repeated identity or context details", () => {
	const children = [
		nested({ agentId: "review", type: "reviewer", displayName: "Reviewer" }),
		nested({ agentId: "scout", parentAgentId: "review" }),
	];
	const current = model([worker({ children })]);
	const lines = workerFleetTreeLines(current, theme, 160, 66_000);
	assert.match(lines[2]!, /Reviewer · gpt-5\.6-sol · xhigh · fast.*↻1 · 2 tools · 2\.5k \(34% · ⇊1\)/);
	assert.match(lines[3]!, /└─ ⠋ Recon  reading…  2 tools · 2\.5k · 1m 00s$/);
	assert.doesNotMatch(lines[3]!, /gpt-|xhigh|fast|↻|%|⇊/);
	assert.ok(visibleWidth(lines[3]!) < 85, "grandchildren avoid padding across the full terminal width");
	for (const width of [1, 4, 12, 24, 80]) {
		const narrow = workerFleetTreeLines(current, theme, width, 66_000);
		assert.ok(narrow.every((line) => visibleWidth(line) <= width));
	}
});

test("completed reviewers retain failed scout evidence", () => {
	for (const status of ["timed_out", "error", "aborted", "stopped"] as const) {
		const children = [
			nested({ agentId: "review", type: "reviewer", displayName: "Reviewer", status: "completed" }),
			nested({ agentId: "scout", parentAgentId: "review", status, activeTools: [], completedAt: 3_606_000 }),
		];
		const lines = workerFleetTreeLines(model([worker({ children })]), theme, 160, 3_606_000);
		assert.equal(lines.length, 4);
		assert.match(lines[2]!, /✓ Reviewer.*done/);
		assert.match(lines[3]!, new RegExp(`Recon.*${status}.*1h 00m 00s$`));
		assert.equal(lines[3]!.indexOf("└─"), lines[2]!.indexOf("└─") + 3);
	}
});

test("completed reviewer summaries include only direct siblings", () => {
	const children = [
		nested({ agentId: "review", type: "reviewer", displayName: "Reviewer", status: "completed" }),
		nested({ agentId: "scout", parentAgentId: "review", status: "completed" }),
	];
	const lines = workerFleetTreeLines(model([worker({ children })]), theme, 160);
	assert.equal(lines.length, 3);
	assert.match(lines[2]!, /✓ 1 Reviewer done$/);
});

test("completed nested agents collapse into one summary under the live children", () => {
	const children = [
		...Array.from({ length: 6 }, (_, index) => nested({
			agentId: `done-${index}`,
			status: "completed",
			activeTools: [],
			activity: "done",
			completedAt: 20_000,
		})),
		nested({ agentId: "live", status: "running" }),
	];
	const lines = workerFleetTreeLines(model([worker({ children })]), theme, 160, 66_000, 0);
	assert.equal(lines.length, 4);
	assert.match(lines[2]!, /⠋ Recon · gpt-5\.6-sol · xhigh · fast  reading…/);
	assert.match(lines[3]!, /✓ 6 Recon done$/);
	assert.equal(lines.filter((line) => /✓ Recon ·/.test(line)).length, 0);
});

test("completed nested summary groups mixed child types and keeps failures expanded", () => {
	const children = [
		nested({ agentId: "recon-1", status: "completed", activeTools: [], activity: "done", completedAt: 20_000 }),
		nested({ agentId: "recon-2", displayName: "Recon", status: "completed", activeTools: [], activity: "done", completedAt: 21_000 }),
		nested({ agentId: "search-1", displayName: "Searcher", type: "searcher", status: "completed", activeTools: [], activity: "done", completedAt: 22_000 }),
		nested({ agentId: "failed", status: "error", activeTools: [], activity: "error" }),
	];
	const lines = workerFleetTreeLines(model([worker({ children })]), theme, 160, 66_000, 0);
	assert.equal(lines.length, 4);
	assert.match(lines[2]!, /✗ Recon · gpt-5\.6-sol · xhigh · fast  error/);
	assert.match(lines[3]!, /✓ 2 Recon · 1 Searcher done$/);
});

test("worker fleet default height shows 16 agent rows before overflow", () => {
	const workers = Array.from({ length: 18 }, (_, index) => worker({
		handle: `pi-worker:${index}`,
		actionId: `action-${index}`,
		planId: String(index + 1).padStart(3, "0"),
	}));
	const lines = workerFleetTreeLines(model(workers), theme, 80, 66_000, 0);
	assert.equal(lines.length, 18);
	assert.equal(lines[17], "└─ +2 more agents");
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

test("failed worker fleet renders the terminal manager detail", () => {
	const failed = { ...model([]), status: "failed" as const, idleDetail: "Verification gate dashboard-ci failed (log /tmp/dashboard-ci.log)." };
	const lines = workerFleetTreeLines(failed, theme, 160);
	assert.equal(lines[1], "└─ Verification gate dashboard-ci failed (log /tmp/dashboard-ci.log).");
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
