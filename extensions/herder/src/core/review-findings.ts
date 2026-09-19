import type { StoredPlanSpec } from "../daemon/run-store.ts";
import { parsePlanContract, parseSharedToolchains, structuralLines } from "./plan-contract.ts";
import type { JudgeResult, ReviewerResult } from "../shared/protocol.ts";

/** Manager-supplied facts from immutable assignments, never worker-provided authority.
 * boundaryText contains binding frozen Boundaries lines, excluding examples and markers.
 */
export interface ReviewFindingContract {
	readonly planId: string;
	readonly acceptanceIds: readonly string[];
	readonly verificationIds: readonly string[];
	readonly boundaryText: string;
}

/** Read only the captured assignment; never source plans or live worktrees. */
export function reviewFindingContractsFromSpecs(specs: readonly Pick<StoredPlanSpec, "planId" | "assignment">[]): ReviewFindingContract[] {
	return specs.map((spec) => {
		const text = spec.assignment.planText;
		const marker = "<!-- herder-snapshot:local-plan -->";
		const split = text.indexOf(marker);
		const local = split < 0 ? text : text.slice(split + marker.length);
		const sharedToolchains = split < 0 ? [] : parseSharedToolchains(text.slice(0, split));
		const contract = parsePlanContract(local, { sharedToolchains, label: `Frozen plan ${spec.planId}` });
		const lines = structuralLines(local, `Frozen plan ${spec.planId}`);
		const start = lines.findIndex((line) => /^ {0,3}##\s+Boundaries(?:\s+#+)?\s*$/.test(line));
		const end = lines.findIndex((line, index) => index > start && /^ {0,3}##\s/.test(line));
		return {
			planId: spec.planId,
			acceptanceIds: contract.acceptance.map((entry) => entry.id),
			verificationIds: contract.verification.map((entry) => entry.id),
			boundaryText: lines.slice(start + 1, end < 0 ? undefined : end)
				.filter(line => line.trim() && !/^\s*(?:#{1,6}\s|\*\*(?:Write paths|Out of scope)\*\*\s*:?)\s*/.test(line)).join("\n"),
		};
	});
}

export interface ValidatedReviewBlocker {
	readonly id: string;
	readonly obligation: string;
	readonly evidence: string;
	readonly violation: string;
	readonly relationship: "PLAN_REQUIREMENT" | "PATCH_REGRESSION";
}

function fail(message: string): never {
	throw new Error(`Review finding protocol: ${message}`);
}

function blockerFields(body: string): Pick<ValidatedReviewBlocker, "obligation" | "evidence" | "violation"> {
	const fields = new Map<string, string>();
	const matches = [...body.matchAll(/(?:^|;\s*)([a-z_]+)=/g)];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]!;
		const name = match[1]!;
		if (!["obligation", "evidence", "violation"].includes(name)) continue;
		if (fields.has(name)) fail(`duplicate ${name}`);
		const value = body.slice(match.index! + match[0].length, matches[index + 1]?.index ?? body.length).trim();
		if (!value || /^(?:none|unknown|n\/a|pending|tbd|not run|\.\.\.|<[^>]*>)$/i.test(value)) fail(`missing concrete ${name}`);
		fields.set(name, value);
	}
	for (const name of ["obligation", "evidence", "violation"]) {
		if (!fields.has(name)) fail(`missing ${name}`);
	}
	return { obligation: fields.get("obligation")!, evidence: fields.get("evidence")!, violation: fields.get("violation")! };
}

function validateObligation(obligation: string, contracts: readonly ReviewFindingContract[], finalAudit = false): void {
	if (obligation.startsWith("constraint:")) {
		const quote = obligation.slice("constraint:".length);
		// Exact nonempty boundary lines avoid granting authority to arbitrary substrings.
		if (!quote.trim() || !contracts.some((contract) => contract.boundaryText.split(/\r?\n/).some((line) => line.trim() === quote))) {
			fail("constraint must quote an exact frozen Boundaries line");
		}
		return;
	}
	const match = obligation.match(/^(?:(.+):)?([AV][1-9][0-9]*)$/);
	if (!match) fail(`invalid obligation ${obligation}`);
	const planId = match[1];
	const id = match[2]!;
	if (!planId && (finalAudit || contracts.length !== 1)) fail("aggregate obligations require planId:A1 or planId:V1");
	const contract = planId ? contracts.find((entry) => entry.planId === planId) : contracts[0];
	if (!contract || !(id.startsWith("A") ? contract.acceptanceIds : contract.verificationIds).includes(id)) {
		fail(`unknown obligation ${obligation}`);
	}
}

/** Structural binding only: reviewers/judges still establish truth, causal relevance,
 * and materiality. Legacy nonblocking prose remains advisory and grants no repair.
 */
export function validateReviewFindings(findings: readonly string[], contracts: readonly ReviewFindingContract[], finalAudit = false): ValidatedReviewBlocker[] {
	const blockers: ValidatedReviewBlocker[] = [];
	for (const finding of findings) {
		if (!finding.includes("[BLOCKING]")) continue;
		const match = finding.match(/^\[([^\[\]\s]+)\]\[(P0|P1)\]\[BLOCKING\]\[(PLAN_REQUIREMENT|PATCH_REGRESSION)\]\s+(.+)$/);
		if (!match) fail("blocker requires P0/P1 and PLAN_REQUIREMENT or PATCH_REGRESSION; FOLLOWUP/INVALID are advisory");
		const fields = blockerFields(match[4]!);
		validateObligation(fields.obligation, contracts, finalAudit);
		const id = match[1]!;
		if (id !== "NEW" && blockers.some((entry) => entry.id === id)) fail(`duplicate blocker ${id}`);
		blockers.push({ id, relationship: match[3] as ValidatedReviewBlocker["relationship"], ...fields });
	}
	return blockers;
}

/** Validate the verdict too: advisory observations cannot initiate a repair round. */
export function validateReviewerResult(
	result: Pick<ReviewerResult, "verdict" | "scope" | "findings">,
	contracts: readonly ReviewFindingContract[],
	finalAudit = false,
): ValidatedReviewBlocker[] {
	const blockers = validateReviewFindings(result.findings, contracts, finalAudit);
	if (result.verdict === "REVISE" && !blockers.length) fail("REVISE requires a validated blocking finding");
	if (result.verdict === "APPROVE" && (result.scope !== "PASS" || blockers.length)) fail("APPROVE requires scope PASS and no blockers");
	return blockers;
}

/** Supply the current reviewer evidence with the exact retained finding IDs.
 * Judge dispositions may reject evidence, but authorization cannot invent or replace it.
 */
export function validateJudgeFindings(
	result: Pick<JudgeResult, "decision" | "findings" | "authorizedBlockers" | "repairContracts">,
	reviewerFindings: readonly string[],
	contracts: readonly ReviewFindingContract[],
): void {
	const validated = validateReviewFindings(reviewerFindings, contracts);
	const authorized = new Set(result.authorizedBlockers);
	if (authorized.size !== result.authorizedBlockers.length) fail("duplicate authorized blocker");
	if (result.decision !== "REPAIR" && authorized.size) fail("only REPAIR may authorize blockers");
	if (result.decision === "REPAIR" && !authorized.size) fail("REPAIR requires validated blockers");
	const dispositions = new Set<string>();
	for (const finding of result.findings) {
		if (finding.includes("[BLOCKING]")) fail("judge findings require disposition tags, not reviewer blocker tags");
		if (!finding.includes("[BLOCKING_IN_SCOPE]")) continue;
		const match = finding.match(/^\[([^\[\]\s]+)\]\[BLOCKING_IN_SCOPE\]\[(PLAN_REQUIREMENT|PATCH_REGRESSION)\]\s+(.+)$/);
		if (!match) fail("invalid judge blocking disposition");
		const id = match[1]!;
		if (result.decision === "DONE" || (result.decision === "REPAIR" && !authorized.has(id)) || dispositions.has(id)) fail(`unbound or duplicate judge blocker ${id}`);
		const evidence = validated.filter((entry) => entry.id === id);
		if (evidence.length !== 1) fail(`judge blocker ${id} requires unambiguous validated reviewer evidence`);
		const fields = blockerFields(match[3]!);
		const original = evidence[0]!;
		if (match[2] !== original.relationship || fields.obligation !== original.obligation
			|| fields.evidence !== original.evidence || fields.violation !== original.violation) {
			fail(`judge blocker ${id} must retain validated obligation, evidence, violation, and relationship`);
		}
		dispositions.add(id);
	}
	for (const id of authorized) {
		if (!dispositions.has(id)) fail(`authorized blocker ${id} lacks a bound disposition`);
		if (result.findings.filter((entry) => entry.startsWith(`[${id}]`)).length !== 1) fail(`authorized blocker ${id} requires exactly one disposition`);
		if (result.repairContracts.filter((entry) => entry.startsWith(`[${id}] `)).length !== 1) fail(`authorized blocker ${id} requires one repair contract`);
	}
	for (const entry of result.repairContracts) {
		const id = entry.match(/^\[([^\[\]\s]+)\]\s+/)?.[1];
		if (!id || !authorized.has(id)) fail("repair contract refers to an unauthorized blocker");
	}
}
