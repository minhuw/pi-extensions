import path from "node:path";
import { compiledAssignmentEntry } from "../daemon/git/assignment-bundle.ts";
import { buildGraph, snapshotPlansFromGraph } from "./plans.ts";
import { sha256, stableJson } from "../shared/protocol.ts";
import type { StoredPlanSpec } from "../daemon/run-store.ts";

export function compilePlanSpecs(input: {
	runId: string;
	graphGeneration: number;
	graph: ReturnType<typeof buildGraph>;
	previous?: StoredPlanSpec[];
}): { specs: StoredPlanSpec[]; graphSha256: string } {
	const previous = new Map((input.previous ?? []).map((spec) => [spec.planId, spec]));
	const snapshots = snapshotPlansFromGraph(input.graph);
	const specs = input.graph.plans.map((plan, ordinal) => {
		const snapshot = snapshots[ordinal]!;
		const assignment = compiledAssignmentEntry(snapshot);
		const prior = previous.get(plan.id);
		const semantic = {
			fingerprintVersion: 2,
			planId: plan.id,
			title: plan.title,
			priority: plan.priority,
			effort: plan.effort,
			kind: plan.kind,
			dependencies: plan.dependencies,
			planFile: path.basename(plan.file),
			assignment,
		};
		return {
			runId: input.runId,
			graphGeneration: input.graphGeneration,
			planId: plan.id,
			planFingerprint: sha256(stableJson(semantic)),
			fingerprintVersion: 2,
			ordinal,
			title: plan.title,
			priority: plan.priority,
			effort: plan.effort,
			kind: plan.kind,
			dependencies: plan.dependencies,
			initialStatus: prior?.initialStatus ?? plan.status as StoredPlanSpec["initialStatus"],
			initialStatusDetail: prior?.initialStatusDetail ?? plan.statusDetail,
			planFile: semantic.planFile,
			assignment,
		} satisfies StoredPlanSpec;
	});
	const graphSha256 = sha256(stableJson(specs.map((spec) => ({ planId: spec.planId, fingerprint: spec.planFingerprint }))));
	return { specs, graphSha256 };
}

export function compileGraphIdentity(graph: ReturnType<typeof buildGraph>): string {
	return compilePlanSpecs({ runId: "graph", graphGeneration: 1, graph }).graphSha256;
}
