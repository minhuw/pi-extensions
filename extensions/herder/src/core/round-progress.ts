import type { StoredAction } from "../daemon/run-store.ts";
import type { RoundProgress, WorkerResult } from "../shared/protocol.ts";

function terminalEvidence(action: StoredAction) {
	const record = action.result as { workerResult?: WorkerResult; terminal?: { interrupted?: boolean; error?: string | null; failureKind?: string }; outcome?: string } | null;
	const interrupted = record?.terminal?.interrupted === true;
	// Interrupted/failed transport can retain a partial envelope; it proves no role outcome.
	const result = interrupted || record?.terminal?.error || record?.terminal?.failureKind ? undefined : record?.workerResult;
	return { interrupted, result: result?.kind === action.role.replace("plan-", "") ? result : undefined };
}

/** Pass one run's getActions() history. Exclusions do not grant repair authority. */
export function excludedFindings(actions: readonly StoredAction[], planId: string, generation: number): string[] {
	const excluded = new Map<string, string>();
	for (const action of actions) {
		if (action.state !== "terminal" || action.planId !== planId || action.generation !== generation) continue;
		const { result } = terminalEvidence(action);
		if (result?.kind !== "judge") continue;
		for (const finding of result.findings) {
			const match = finding.match(/^\[([^\[\]\s]+)\]\[(BLOCKING_IN_SCOPE|NONBLOCKING_IN_SCOPE|DEFERRED_OUT_OF_SCOPE|REJECTED)\]\[(PLAN_REQUIREMENT|PATCH_REGRESSION|FOLLOWUP|INVALID|NEEDS_INPUT)\]/);
			if (!match || match[1] === "NEW") continue;
			// Reopening policy is validated by the manager before this terminal result is stored.
			if (result.decision === "REPAIR" && match[2] === "BLOCKING_IN_SCOPE" && match[3] === "PATCH_REGRESSION" && result.authorizedBlockers.includes(match[1]!)) {
				excluded.delete(match[1]!);
				continue;
			}
			if (match[2] === "DEFERRED_OUT_OF_SCOPE" || match[2] === "REJECTED" || match[3] === "FOLLOWUP" || match[3] === "INVALID") {
				excluded.set(match[1]!, finding);
			}
		}
	}
	return [...excluded.values()];
}

/** Keep getActions() ordering; never sort timestamps or infer missing role completion. */
export function buildRoundProgress(actions: readonly StoredAction[]): RoundProgress[] {
	const rounds = new Map<string, RoundProgress>();
	for (const action of actions) {
		if (action.state !== "terminal" || !["plan-implementer", "plan-reviewer", "plan-judge"].includes(action.role)) continue;
		const key = JSON.stringify([action.runId, action.planId, action.generation, action.round]);
		let round = rounds.get(key);
		if (!round) {
			round = { runId: action.runId, planId: action.planId, generation: action.generation, round: action.round, reportId: action.actionId, fixNext: [], notIntendedToFix: [], outcome: "UNKNOWN" };
			rounds.set(key, round);
		}
		const { result, interrupted } = terminalEvidence(action);
		const outcome = result?.kind === "implementer" ? result.status : result?.kind === "reviewer" ? result.verdict : result?.kind === "judge" ? result.decision : "UNKNOWN";
		const summary = result?.kind === "implementer" ? result.notes : result?.rationale;
		const role = action.role.replace("plan-", "") as "implementer" | "reviewer" | "judge";
		round[role] = {
			actionId: action.actionId,
			summary: summary ? summary.replace(/\s+/g, " ").trim().slice(0, 600) : "Unknown: no completed worker evidence.",
			outcome,
			interrupted,
			setup: result ? [...result.setup] : [],
			checks: result ? [...result.checks] : [],
		};
		round.reportId = action.actionId;
		round.outcome = outcome;
		// A newer attempt supersedes the earlier next-step report, even if interrupted.
		round.fixNext = result?.kind === "judge" && result.decision === "REPAIR"
			? result.repairContracts.filter((contract) => {
				const id = contract.match(/^\[([^\[\]\s]+)\]/)?.[1];
				return id !== undefined && id !== "NEW" && result.authorizedBlockers.includes(id);
			}) : [];
	}
	for (const round of rounds.values()) {
		round.notIntendedToFix = excludedFindings(actions.filter((action) => action.runId === round.runId), round.planId, round.generation);
	}
	return [...rounds.values()];
}
