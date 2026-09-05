import type { PlanGraph, PlanSnapshot, getShapeReport } from "../src/core/plans.ts";
import { sha256 } from "../src/shared/protocol.ts";

export interface PlanResponseOptions {
	view?: "compact" | "full";
	/** Zero-based UTF-16 character offset into the selected presentation. */
	offset?: number;
	responseSha256?: string;
}

const INSPECTIONS = new Set(["validate", "shape", "snapshot"]);
// Leave room for the continuation footer within Pi's 50KB / 2000-line limit.
const MAX_CHARACTERS = 12_000;
const MAX_LINES = 1_900;

/** Check before dispatch: presentation options must never replay a mutation. */
export function assertPlanResponseOptions(operation: string, options: PlanResponseOptions): void {
	const supplied = options.view !== undefined || options.offset !== undefined || options.responseSha256 !== undefined;
	if (supplied && !INSPECTIONS.has(operation)) {
		throw new Error("view, offset, and responseSha256 are supported only for validate, shape, and snapshot.");
	}
	if (options.view !== undefined && options.view !== "compact" && options.view !== "full") {
		throw new Error("Herder response view must be compact or full.");
	}
	if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) {
		throw new Error("Herder response offset must be a nonnegative safe integer.");
	}
	if (options.responseSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.responseSha256)) {
		throw new Error("Herder responseSha256 must be a lowercase SHA-256 hash.");
	}
	if ((options.offset ?? 0) > 0 && !options.responseSha256) {
		throw new Error("Continuing a Herder response requires the previous page's responseSha256.");
	}
}

function compactGraph(operation: "validate" | "shape", value: unknown): string {
	const result = value as (PlanGraph | ReturnType<typeof getShapeReport>) & { graphSha256: string };
	const issues = result.plans.flatMap((plan) => {
		const planIssues = "shapeIssues" in plan ? plan.shapeIssues : plan.issues;
		return planIssues.length ? [{ id: plan.id, issues: planIssues }] : [];
	});
	const graph = operation === "validate" ? result as PlanGraph : undefined;
	return JSON.stringify({
		planDir: result.planDir,
		graphSha256: result.graphSha256,
		shapeReady: result.shapeReady,
		planCount: result.plans.length,
		...(graph ? { indexSha256: graph.indexSha256, contextSha256: graph.contextSha256,
			counts: graph.counts, ready: graph.ready, inProgress: graph.inProgress,
			blocked: graph.blocked, waiting: graph.waiting, waves: graph.waves, complete: graph.complete } : {}),
		contextFile: result.contextFile,
		contextWords: result.contextWords,
		contextIssues: result.contextIssues,
		planIssues: issues,
		overlaps: {
			total: result.overlaps.length,
			ordered: result.overlaps.filter((overlap) => overlap.ordered).length,
			unordered: result.overlaps.filter((overlap) => !overlap.ordered),
		},
		warnings: result.warnings,
		inspection: "Structural evidence only, not semantic readiness. Use view: full for plan records and derived contracts.",
	}, null, 2);
}

function compactSnapshot(value: unknown): string {
	const snapshot = value as PlanSnapshot;
	const { id, title, file, dependencies } = snapshot.plan;
	return `${JSON.stringify({
		planDir: snapshot.planDir,
		readme: snapshot.readme,
		plan: { id, title, file, dependencies },
		snapshotSha256: snapshot.snapshotSha256,
		snapshotInputs: snapshot.snapshotInputs,
		inspection: "Compiled planText follows verbatim. Use view: full for the derived contract and raw inputs.",
	}, null, 2)}\n\n${snapshot.planText}`;
}

/** No temp files or cache: continuation re-reads and verifies the same presentation. */
function responsePage(text: string, options: PlanResponseOptions): string {
	const offset = options.offset ?? 0;
	const responseSha256 = sha256(text);
	if (options.responseSha256 && options.responseSha256 !== responseSha256) {
		throw new Error("Herder response changed; restart inspection at offset 0 without responseSha256.");
	}
	if (offset > text.length) throw new Error("Herder response offset is past the end of the response.");
	if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "") && /[\uD800-\uDBFF]/.test(text[offset - 1]!)) {
		throw new Error("Herder response offset splits a Unicode character; use the returned nextOffset.");
	}
	let end = Math.min(text.length, offset + MAX_CHARACTERS);
	// Avoid splitting surrogate pairs, while permitting even a single very long line.
	if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
	let lineEnd = offset;
	for (let line = 0; line < MAX_LINES; line++) {
		lineEnd = text.indexOf("\n", lineEnd);
		if (lineEnd < 0 || lineEnd >= end) break;
		lineEnd++;
		if (line === MAX_LINES - 1) end = lineEnd;
	}
	if (offset === 0 && end === text.length) return text;
	const nextOffset = end < text.length ? end : null;
	return `${text.slice(offset, end)}\n\n[Herder response page: ${JSON.stringify({
		view: options.view ?? "compact", offset, nextOffset, totalCharacters: text.length, responseSha256,
	})}]\n${nextOffset === null
		? "End of response; combine all pages before assessing the snapshot or diagnostics."
		: "PARTIAL response. Repeat the same read-only operation, planDirectory, planId, and view with nextOffset as offset and responseSha256. Do not treat partial evidence as complete."}`;
}

/** Presentation only: raw application results and immutable assignment hashes are unchanged. */
export function formatPlanToolResponse(operation: string, value: unknown, options: PlanResponseOptions = {}): string {
	assertPlanResponseOptions(operation, options);
	if (!INSPECTIONS.has(operation)) return JSON.stringify(value, null, 2);
	const text = options.view === "full" ? JSON.stringify(value, null, 2)
		: operation === "snapshot" ? compactSnapshot(value)
			: compactGraph(operation as "validate" | "shape", value);
	return responsePage(text, options);
}
