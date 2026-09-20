import type { StoredPlanSpec } from "../daemon/run-store.ts";
import { parsePlanContract, parseSharedToolchains, structuralLines } from "./plan-contract.ts";
import { sha256, type JudgeResult, type ReviewerResult } from "../shared/protocol.ts";

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

function blockerFields(body: string, requireObligation = true): Pick<ValidatedReviewBlocker, "obligation" | "evidence" | "violation"> {
	const fields = new Map<string, string>();
	const matches = [...body.matchAll(/(?:^|;\s*)([a-z_]+)=/g)];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]!;
		const name = match[1]!;
		if (!["obligation", "evidence", "violation"].includes(name)) continue;
		if (fields.has(name)) fail(`duplicate ${name}`);
		const value = body.slice(match.index! + match[0].length, matches[index + 1]?.index ?? body.length).trim();
		if ((!value || /^(?:none|unknown|n\/a|pending|tbd|not run|\.\.\.|<[^>]*>)$/i.test(value)) && (name !== "obligation" || requireObligation)) fail(`missing concrete ${name}`);
		fields.set(name, value);
	}
	for (const name of ["obligation", "evidence", "violation"]) {
		if (!fields.has(name) && (name !== "obligation" || requireObligation)) fail(`missing ${name}`);
	}
	return { obligation: fields.get("obligation") ?? "unknown", evidence: fields.get("evidence")!, violation: fields.get("violation")! };
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
export function validateReviewFindings(findings: readonly string[], contracts: readonly ReviewFindingContract[], finalAudit = false, requireObligation = true): ValidatedReviewBlocker[] {
	const blockers: ValidatedReviewBlocker[] = [];
	for (const finding of findings) {
		if (!finding.includes("[BLOCKING]")) continue;
		const match = finding.match(/^\[([^\[\]\s]+)\]\[(P0|P1)\]\[BLOCKING\]\[(PLAN_REQUIREMENT|PATCH_REGRESSION)\]\s+(.+)$/);
		if (!match) fail("blocker requires P0/P1 and PLAN_REQUIREMENT or PATCH_REGRESSION; FOLLOWUP/INVALID are advisory");
		const fields = blockerFields(match[4]!, requireObligation);
		if (requireObligation) validateObligation(fields.obligation, contracts, finalAudit);
		const id = match[1]!;
		if (id !== "NEW" && blockers.some((entry) => entry.id === id)) fail(`duplicate blocker ${id}`);
		blockers.push({ id, relationship: match[3] as ValidatedReviewBlocker["relationship"], ...fields });
	}
	return blockers;
}

/** Compare retained observations without requiring historical repair authority. */
function findingEvidence(finding: string): string {
	const body = finding.replace(/^(?:\[[^\]\r\n]+\])+\s*/, "");
	return body.match(/(?:^|;\s*)evidence=([^;]*)/)?.[1]?.trim() || body.trim();
}

/** Normalize before persistence/hashing. Repeated observations retain their identity;
 * ambiguous NEW guidance is left unbound rather than guessed by list position.
 */
export function normalizeReviewerFindings(result: ReviewerResult, actionId: string, previousFindings: readonly string[] = []): ReviewerResult {
	const newIds: string[] = [];
	const used = new Set([...result.findings, ...previousFindings].map(entry => entry.match(/^\[([^\[\]\s]+)\]/)?.[1]));
	const findings = result.findings.map((finding, index) => {
		if (!finding.startsWith("[NEW]")) return finding;
		const priorIds = new Set(previousFindings.filter(prior => findingEvidence(prior) === findingEvidence(finding))
			.map(prior => prior.match(/^\[([^\[\]\s]+)\]/)?.[1]).filter((id): id is string => !!id && id !== "NEW"));
		if (priorIds.size > 1) fail("NEW finding matches ambiguous retained evidence; retain its existing ID");
		let id = [...priorIds][0];
		if (!id) {
			id = `F-${sha256(actionId)}-${index + 1}`;
			while (used.has(id)) id += "-new";
		}
		used.add(id);
		newIds.push(id);
		return finding.replace(/^\[NEW\]/, `[${id}]`);
	});
	return { ...result, findings, fixGuidance: result.fixGuidance.map(entry => newIds.length === 1 ? entry.replace(/^\[NEW\](?=\s)/, `[${newIds[0]}]`) : entry) };
}

/** Reviewer reports are evidence only; obligation authority is checked at Judge authorization. */
export function validateReviewerResult(
	result: Pick<ReviewerResult, "verdict" | "scope" | "findings">,
	contracts: readonly ReviewFindingContract[],
	finalAudit = false,
): ValidatedReviewBlocker[] {
	const blockers = validateReviewFindings(result.findings, contracts, finalAudit, false);
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
	previouslyExcluded: readonly string[] = [],
	finalAudit = false,
): void {
	const validated = validateReviewFindings(reviewerFindings, contracts, finalAudit, false);
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
		validateObligation(original.obligation, contracts, finalAudit);
		if (match[2] !== original.relationship || fields.obligation !== original.obligation
			|| fields.evidence !== original.evidence || fields.violation !== original.violation) {
			fail(`judge blocker ${id} must retain validated obligation, evidence, violation, and relationship`);
		}
		for (const prior of previouslyExcluded.filter(entry => entry.startsWith(`[${id}]`) || findingEvidence(entry) === fields.evidence)) {
			const rationale = finding.match(/;\s*regression_rationale=([^;]+)/i)?.[1]?.trim();
			if (original.relationship !== "PATCH_REGRESSION" || fields.evidence === findingEvidence(prior)
				|| !rationale || !/\b(?:introduced|worsened)\b/i.test(rationale)) {
				fail(`excluded finding ${id} requires changed evidence and explicit regression_rationale`);
			}
		}
		dispositions.add(id);
	}
	if (result.decision === "DONE") {
		if (result.findings.some(entry => !/^\[[^\[\]\s]+\]\[(NONBLOCKING_IN_SCOPE|DEFERRED_OUT_OF_SCOPE|REJECTED)\]\[(PLAN_REQUIREMENT|PATCH_REGRESSION|FOLLOWUP|INVALID)\]\s+\S/.test(entry))) fail("DONE requires classified nonblocking findings");
		for (const finding of reviewerFindings) {
			const id = finding.match(/^\[([^\[\]\s]+)\]/)?.[1];
			const matches = result.findings.filter(entry => /^\[[^\[\]\s]+\]\[(NONBLOCKING_IN_SCOPE|DEFERRED_OUT_OF_SCOPE|REJECTED)\]\[(PLAN_REQUIREMENT|PATCH_REGRESSION|FOLLOWUP|INVALID|NEEDS_INPUT)\]\s+\S/.test(entry)
				&& (id ? entry.startsWith(`[${id}]`) : entry.includes(finding)));
			if (matches.length !== 1) fail(`DONE requires exactly one disposition for ${id ?? finding}`);
		}
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
