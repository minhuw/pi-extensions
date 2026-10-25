import { INLINE_TEXT_LIMIT } from "../config.ts";
import type { CheckResult, IntegrateResult, StepResult } from "../types.ts";
import type { DeliveryOutcome, VerifyOutcome } from "./runtime.ts";

const short = (sha: string | undefined) => (sha ? sha.slice(0, 12) : "—");
const indent = (text: string) => text.split("\n").map((line) => `    ${line}`).join("\n");

export function describeChecks(checks: readonly CheckResult[]): string {
	if (!checks.length) return "No checks ran.";
	return checks.map((check) => {
		const outcome = check.passed ? "passed" : check.timedOut ? "timed out" : `failed (exit ${check.exitCode})`;
		return `- ${check.id} ${outcome} at ${short(check.commit)} in ${Math.round(check.durationMs / 100) / 10}s (log ${check.logRef})${check.passed || !check.tail ? "" : `\n${indent(check.tail)}`}`;
	}).join("\n");
}

export function describeStep(result: StepResult): string {
	const lines = [`Step ${result.key}: ${result.status}${result.reused ? " (reused)" : ""}${result.commit ? `, commit ${result.commit}` : ""}`];
	if (result.error) lines.push(`Error (${result.error.class}): ${result.error.message}`);
	if (result.checks?.length) lines.push("Gates:", describeChecks(result.checks));
	if (result.data !== undefined) lines.push(`Data: ${JSON.stringify(result.data)}`);
	if (result.text) lines.push(`Text:\n${result.text.length > INLINE_TEXT_LIMIT ? `${result.text.slice(0, INLINE_TEXT_LIMIT)}\n[truncated]` : result.text}`);
	return lines.join("\n");
}

export function describeIntegration(result: IntegrateResult): string {
	const lines = [`Integration: ${result.status}${result.head ? `, head ${result.head}` : ""}`];
	if (result.conflicts?.length) lines.push(`Conflicts: ${result.conflicts.join(", ")}`);
	if (result.checks?.length) lines.push("Checks:", describeChecks(result.checks));
	return lines.join("\n");
}

export function describeVerification(outcome: VerifyOutcome): string {
	const lines = [`Verdict: ${outcome.verdict} at ${short(outcome.head)}${outcome.verifierRan ? " (verifier ran)" : ""}${outcome.reason ? ` — ${outcome.reason}` : ""}`, "Checks:", describeChecks(outcome.checks)];
	if (outcome.criteria.length) lines.push("Criteria:", ...outcome.criteria.map((criterion) => `- ${criterion.id} ${criterion.status}: ${criterion.evidence}`));
	if (outcome.gaps.length) lines.push("Gaps (appended to plan.md):", ...outcome.gaps.map((gap) => `- ${gap.kind} [${gap.criteria.join(", ")}]: ${gap.text}`));
	return lines.join("\n");
}

export function describeDelivery(outcome: DeliveryOutcome): string {
	const lines = outcome.status !== "delivered"
		? [`Delivery (${outcome.mode}) ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}.`]
		: [`Delivered (${outcome.mode}) to ${outcome.target ?? "?"} at ${short(outcome.tip)}${outcome.commits ? `, ${outcome.commits.length} commit(s)` : ""}${outcome.curated ? ", curated" : ""}.`];
	if (outcome.curation) lines.push(`Kept the original series (${outcome.curation}).`);
	if (outcome.conflicts?.length) lines.push(`Conflicting paths: ${outcome.conflicts.join(", ")}`);
	if (outcome.status !== "delivered") return lines.join("\n");
	if (outcome.rebasedOnto) lines.push(`Replayed onto ${short(outcome.rebasedOnto)}; checks at the new tip:`, describeChecks(outcome.checks ?? []));
	return lines.join("\n");
}
