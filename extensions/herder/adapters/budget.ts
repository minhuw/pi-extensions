import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withServiceExclusion } from "../src/client/index.ts";
import { RunStore } from "../src/daemon/run-store.ts";
import { stableJson } from "../src/shared/protocol.ts";
import { tokenizeArguments } from "./arguments.ts";

export function parseBudgetArguments(args: string) {
	const { values, positionals } = parseArgs({ args: tokenizeArguments(args), allowPositionals: true,
		options: { plan: { type: "string" }, rounds: { type: "string" }, recoveries: { type: "string" } } });
	const positive = (value: string | undefined): number => {
		if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Budget increments must be positive safe integers");
		return Number(value);
	};
	if (positionals.length < 1 || positionals.length > 2) throw new Error("Usage: /herder-budget <amount> [plan-dir] [--plan ID --rounds N --recoveries N]");
	if (values.plan !== undefined && !/^\d+$/.test(values.plan)) throw new Error("Budget plan must be a numeric plan ID");
	if (!values.plan && (values.rounds || values.recoveries)) throw new Error("Task budget increments require --plan ID");
	return { amount: positive(positionals[0]), planDirectory: positionals[1],
		...(values.plan ? { planId: values.plan.padStart(3, "0") } : {}),
		...(values.rounds ? { implementationRounds: positive(values.rounds) } : {}),
		...(values.recoveries ? { infrastructureRecoveries: positive(values.recoveries) } : {}) };
}

/** User-command only: no model tool or public manager operation can mint effort. */
export async function grantUserBudget(directory: string, increments: Omit<ReturnType<typeof parseBudgetArguments>, "planDirectory">,
	ctx: Pick<ExtensionContext, "hasUI" | "ui">, assertCurrent: () => void): Promise<void> {
	if (!ctx.hasUI) throw new Error("Budget grants require interactive host confirmation");
	assertCurrent();
	const store = new RunStore(directory, { readOnly: true });
	let run, budget;
	try { run = store.getRun(); budget = run ? store.getBudget(run.runId) : null; }
	finally { store.close(); }
	if (!run || !budget || ["complete", "stopped"].includes(run.status)) throw new Error("Budget grant requires a nonterminal recorded run and budget");
	const grant = { requestId: randomUUID(), runId: run.runId, generation: run.currentGeneration, graphSha256: run.graphSha256, ...increments };
	const approved = await ctx.ui.confirm("Grant this exact additional Herder effort?", [
		`Run: ${grant.runId}`, `Generation: ${grant.generation}`, `Graph: ${grant.graphSha256}`,
		`Current effort: ${budget.used}/${budget.limit}`, `Additional executions: ${grant.amount}`,
		`Plan: ${grant.planId ?? "none"}`, `Additional implementation rounds: ${grant.implementationRounds ?? 0}`,
		`Additional infrastructure recoveries: ${grant.infrastructureRecoveries ?? 0}`,
		`Stopped reason: ${budget.stopReason ?? "none"}`,
		"This durable grant clears the budget stop only. It does not authorize scope changes, waive acceptance, discard patches, or automatically resume execution.",
	].join("\n\n"));
	if (!approved) throw new Error("Budget grant dismissed; no additional effort was authorized");
	assertCurrent();
	await withServiceExclusion(directory, () => {
		assertCurrent();
		const current = new RunStore(directory);
		try {
			if (stableJson(current.getRun()) !== stableJson(run) || stableJson(current.getBudget(run.runId)) !== stableJson(budget)) throw new Error("Run or budget changed during confirmation; request a fresh grant");
			current.grantBudget(grant);
		} finally { current.close(); }
	});
}
