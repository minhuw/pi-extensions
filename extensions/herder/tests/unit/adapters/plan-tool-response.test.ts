import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { invokeHerderTool } from "../../../src/application/tools.ts";
import { sha256 } from "../../../src/shared/protocol.ts";
import type { PlanGraph, PlanSnapshot } from "../../../src/core/plans.ts";
import { registerPiPlanningWorkflows } from "../../../adapters/planning-workflows.ts";
import { assertPlanResponseOptions, formatPlanToolResponse, type PlanResponseOptions } from "../../../adapters/plan-tool-response.ts";
import { planFixture } from "../../support/plan-fixture.ts";

function fixture() {
	const fixture = planFixture({ prefix: "herder-plan-response-" });
	const template = fs.readFileSync(new URL("../../../skills/plans/references/plan-template.md", import.meta.url), "utf8");
	const example = /```markdown\n([\s\S]*?)\n```/.exec(template)![1]!;
	const local = example.replace("# Plan 002:", "# Plan 001:")
		.replace("**Depends on**: 001", "**Depends on**: none")
		.replace(/\| Plan \| Consumes \|\n\|[^\n]*\n\| 001 \|[^\n]*\n/, "Dependencies: none.\n");
	fs.writeFileSync(path.join(fixture.planDirectory, "001-plan.md"), local);
	fs.writeFileSync(path.join(fixture.planDirectory, "README.md"), `# Plans
| Plan | Title | Priority | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| [001](001-plan.md) | Inspect orders | P1 | S | none | TODO |
`);
	fs.writeFileSync(path.join(fixture.planDirectory, "CONTEXT.md"), "# Shared context\n\nSHARED_RESPONSE_MARKER: preserve account isolation.\n");
	return { root: fs.realpathSync(fixture.root), planDirectory: fs.realpathSync(fixture.planDirectory) };
}

test("compact inspection keeps identities, readiness and every diagnostic without contracts", async () => {
	const { root, planDirectory } = fixture();
	try {
		const graph = await invokeHerderTool("herder_plan", { operation: "validate", planDirectory }) as PlanGraph & { graphSha256: string };
		// Exercise diagnostics and both ordered/unordered overlaps independently of parser policy.
		graph.contextIssues = ["shared context issue"];
		graph.plans[0]!.shapeIssues = ["local issue"];
		graph.shapeReady = false;
		graph.overlaps = [
			{ plans: ["001", "002"], paths: ["src/shared.ts"], ordered: false },
			{ plans: ["001", "003"], paths: ["tests/shared.ts"], ordered: true },
		];
		graph.warnings = ["graph warning"];
		const before = structuredClone(graph);
		const text = formatPlanToolResponse("validate", graph);
		const result = JSON.parse(text);
		assert.equal(result.graphSha256, graph.graphSha256);
		assert.equal(result.indexSha256, graph.indexSha256);
		assert.equal(result.contextSha256, graph.contextSha256);
		assert.equal(result.shapeReady, false);
		for (const key of ["counts", "ready", "inProgress", "blocked", "waiting", "waves", "complete", "warnings", "contextIssues"] as const) {
			assert.deepEqual(result[key], graph[key]);
		}
		assert.deepEqual(result.planIssues, [{ id: "001", issues: ["local issue"] }]);
		assert.deepEqual(result.overlaps, { total: 2, ordered: 1, unordered: [graph.overlaps[0]] });
		assert.equal(result.planCount, 1);
		assert.equal("plans" in result, false);
		assert.doesNotMatch(text, /"contract"|"requiredBehavior"|"toolchains"/);
		assert.deepEqual(graph, before, "formatting cannot mutate application/assignment data");

		const shape = await invokeHerderTool("herder_plan", { operation: "shape", planDirectory });
		const shapeResult = JSON.parse(formatPlanToolResponse("shape", shape));
		assert.equal(shapeResult.shapeReady, true);
		assert.deepEqual(shapeResult.planIssues, []);
		assert.equal(shapeResult.planCount, 1);
		assert.equal(shapeResult.graphSha256, graph.graphSha256);
		assert.ok(formatPlanToolResponse("shape", shape).length < JSON.stringify(shape, null, 2).length / 2);
		// Shape's issues live at plan.issues, unlike validate's plan.shapeIssues.
		const badShape = structuredClone(shape) as { plans: Array<{ issues: string[] }>; shapeReady: boolean };
		badShape.plans[0]!.issues = ["shape-only issue"];
		badShape.shapeReady = false;
		assert.deepEqual(JSON.parse(formatPlanToolResponse("shape", badShape)).planIssues, [{ id: "001", issues: ["shape-only issue"] }]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("snapshot emits exact compiled Markdown once with hash/input provenance and full opt-in", async () => {
	const { root, planDirectory } = fixture();
	try {
		const snapshot = await invokeHerderTool("herder_plan", { operation: "snapshot", planDirectory, planId: "001" }) as PlanSnapshot;
		const before = structuredClone(snapshot);
		const text = formatPlanToolResponse("snapshot", snapshot);
		const metadata = JSON.parse(text.slice(0, text.indexOf("\n\n")));
		assert.ok(text.endsWith(snapshot.planText));
		assert.equal(text.split("SHARED_RESPONSE_MARKER").length - 1, 1);
		assert.equal(text.split("# Plan 001:").length - 1, 1);
		assert.equal(metadata.snapshotSha256, sha256(snapshot.planText));
		assert.deepEqual(metadata.snapshotInputs, snapshot.snapshotInputs);
		assert.deepEqual(metadata.plan.dependencies, snapshot.plan.dependencies);
		assert.doesNotMatch(text, /"sourcePlanText"|"contextText"|"indexText"|"contract"/);
		assert.ok(text.length < JSON.stringify(snapshot, null, 2).length / 2);
		assert.deepEqual(snapshot, before);
		assert.equal(formatPlanToolResponse("snapshot", snapshot, { view: "compact" }), text);
		const full = collectPages("snapshot", snapshot, { view: "full" });
		assert.deepEqual(JSON.parse(full), snapshot);
		assert.equal(JSON.parse(full).contract.acceptance[0].id, "A1");
		assert.equal(collectPages("validate", { sentinel: "raw contract" }, { view: "full" }), '{\n  "sentinel": "raw contract"\n}');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const PAGE_MARKER = "\n\n[Herder response page: ";
function splitPage(text: string) {
	const index = text.lastIndexOf(PAGE_MARKER);
	if (index < 0) return { body: text, page: null };
	const rest = text.slice(index + PAGE_MARKER.length);
	const metadata = rest.slice(0, rest.indexOf("}]\n") + 1);
	return { body: text.slice(0, index), page: JSON.parse(metadata) as { nextOffset: number | null; responseSha256: string } };
}
function collectPages(operation: string, result: unknown, options: PlanResponseOptions = {}): string {
	let combined = "";
	for (let count = 0; count < 100; count++) {
		const text = formatPlanToolResponse(operation, result, options);
		assert.ok(Buffer.byteLength(text, "utf8") < 50 * 1024);
		assert.ok(text.split("\n").length < 2000);
		const { body, page } = splitPage(text);
		combined += body;
		if (!page || page.nextOffset === null) return combined;
		assert.match(text, /PARTIAL response/);
		assert.ok(page.nextOffset > (options.offset ?? 0));
		options = { ...options, offset: page.nextOffset, responseSha256: page.responseSha256 };
	}
	throw new Error("response pagination did not terminate");
}

test("full inspection pages are lossless for long lines, Unicode and line-heavy output", () => {
	for (const value of [
		{ long: "x".repeat(100_000) },
		{ unicode: "😀界".repeat(25_000) },
		Array.from({ length: 4000 }, (_, id) => ({ id })),
	]) {
		assert.equal(collectPages("validate", value, { view: "full" }), JSON.stringify(value, null, 2));
	}
	const manyIssues = { graphSha256: "a".repeat(64), plans: [], contextIssues: [], shapeReady: false, overlaps: [], warnings: Array.from({ length: 3000 }, (_, id) => `issue ${id}`) };
	const compact = JSON.parse(collectPages("shape", manyIssues));
	assert.deepEqual(compact.warnings, manyIssues.warnings, "compact mode must not silently drop diagnostics");
});

test("continuation rejects drift, missing identity, invalid offsets and mutation options", () => {
	const value = { text: "x".repeat(20_000) };
	const first = splitPage(formatPlanToolResponse("validate", value, { view: "full" })).page!;
	assert.throws(() => formatPlanToolResponse("validate", value, { view: "full", offset: 10 }), /requires.*responseSha256/);
	assert.throws(() => formatPlanToolResponse("validate", { ...value, changed: true }, { view: "full", offset: first.nextOffset!, responseSha256: first.responseSha256 }), /response changed/);
	assert.throws(() => formatPlanToolResponse("validate", value, { view: "full", offset: 99_999, responseSha256: first.responseSha256 }), /past the end/);
	const unicode = { value: "😀" };
	const unicodeText = JSON.stringify(unicode, null, 2);
	assert.throws(() => formatPlanToolResponse("validate", unicode, {
		view: "full", offset: unicodeText.indexOf("😀") + 1, responseSha256: sha256(unicodeText),
	}), /splits a Unicode character/);
	for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => assertPlanResponseOptions("shape", { offset }), /safe integer/);
	}
	assert.throws(() => assertPlanResponseOptions("shape", { view: "unknown" as "full" }), /view/);
	assert.throws(() => assertPlanResponseOptions("shape", { responseSha256: "abc" }), /SHA-256/);
	for (const operation of ["init", "status", "attention", "finish_edit", "track"]) {
		assert.throws(() => assertPlanResponseOptions(operation, { view: "full" }), /supported only/);
		assert.throws(() => assertPlanResponseOptions(operation, { offset: 0 }), /supported only/);
	}
	const raw = { reply: { requestId: "bound", status: "paused" } };
	assert.equal(formatPlanToolResponse("attention", raw), JSON.stringify(raw, null, 2));
});

test("native tool uses compact content but retains raw details and rejects presentation on mutations before dispatch", async () => {
	const { root, planDirectory } = fixture();
	let tool: { parameters: unknown; execute: (...args: any[]) => Promise<any> } | undefined;
	let mutationChecks = 0;
	let rootResolutions = 0;
	const pi = { registerCommand: () => {}, registerTool: (value: typeof tool) => { tool = value; } } as unknown as ExtensionAPI;
	registerPiPlanningWorkflows(pi, root, async () => { rootResolutions++; return root; }, { assertMutationAllowed: () => { mutationChecks++; } });
	const ctx = { isProjectTrusted: () => true } as ExtensionContext;
	try {
		assert.ok(tool);
		assert.equal(Check(tool.parameters as never, { operation: "shape", planDirectory, view: "full", offset: 0 }), true);
		assert.equal(Check(tool.parameters as never, { operation: "shape", planDirectory, view: "unknown" }), false);
		for (const operation of ["validate", "shape", "snapshot"]) {
			const params = { operation, planDirectory, ...(operation === "snapshot" ? { planId: "001" } : {}) };
			const expected = await invokeHerderTool("herder_plan", params);
			const result = await tool.execute("test", params, undefined, undefined, ctx);
			assert.equal(result.isError, undefined);
			assert.deepEqual(result.details.result, expected);
			assert.equal(result.content[0].text, formatPlanToolResponse(operation, expected));
			const full = await tool.execute("full", { ...params, view: "full" }, undefined, undefined, ctx);
			assert.deepEqual(full.details.result, expected);
			assert.equal(full.content[0].text, formatPlanToolResponse(operation, expected, { view: "full" }));
		}
		// A source edit between pages must be caught at the registered tool boundary.
		const contextFile = path.join(planDirectory, "CONTEXT.md");
		fs.writeFileSync(contextFile, `# Shared context\n\n${"page-marker ".repeat(1500)}`);
		const pageParams = { operation: "snapshot", planDirectory, planId: "001", view: "compact" };
		const pageStart = await tool.execute("page-start", pageParams, undefined, undefined, ctx);
		const page = splitPage(pageStart.content[0].text).page!;
		assert.ok(page?.nextOffset);
		const continuation = { ...pageParams, offset: page.nextOffset, responseSha256: page.responseSha256 };
		const pageNext = await tool.execute("page-next", continuation, undefined, undefined, ctx);
		assert.equal(pageNext.isError, undefined);
		assert.deepEqual(pageNext.details.result, pageStart.details.result);
		fs.appendFileSync(contextFile, " changed");
		const drift = await tool.execute("page-drift", continuation, undefined, undefined, ctx);
		assert.match(drift.content[0].text, /response changed; restart inspection/);
		const before = rootResolutions;
		const refused = await tool.execute("mutation", { operation: "init", planDirectory: path.join(root, "new-plans"), view: "full" }, undefined, undefined, ctx);
		assert.match(refused.content[0].text, /supported only/);
		assert.equal(rootResolutions, before);
		assert.equal(mutationChecks, 0);
		assert.equal(fs.existsSync(path.join(root, "new-plans")), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
