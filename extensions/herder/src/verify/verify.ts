// §12 verification: every check at the integration head, the verifier when the run is non-trivial, and a
// runtime-computed verdict that fails closed.
import { readFileSync } from "node:fs";
import { validateSchema } from "../agents/structured.ts";
import { type Criterion, hashGoal, parseGoal } from "../artifacts/goal.ts";
import { appendConvergence } from "../artifacts/plan.ts";
import { runCheck } from "../checks/runner.ts";
import { LIMITS, VERIFIER_DIFF_LINES } from "../config.ts";
import { writeAtomic } from "../run/files.ts";
import { integrationRef, worktreePath } from "../run/paths.ts";
import type { RunStore } from "../run/store.ts";
import type { AgentRunner, CheckResult, CheckSpec, CriterionResult, CriterionStatus, Gap, Limits, RoleDefinition, Vcs, Verdict } from "../types.ts";

export interface VerifyDeps { runId: string; store: RunStore; vcs: Vcs; runner: AgentRunner; roles: ReadonlyMap<string, RoleDefinition>; checks: readonly CheckSpec[]; limits?: Limits; signal?: AbortSignal; onProgress?: () => void }
export interface VerifyOutcome { verdict: Verdict; head: string; checks: CheckResult[]; criteria: CriterionResult[]; gaps: Gap[]; verifierRan: boolean; convergence?: number; reason?: string }

export interface BlockedClaim { id: string; quote: string; reason: string }
export interface VerifierReport { criteria: CriterionResult[]; gaps: Gap[]; blocked: BlockedClaim[] }
/** `undefined`: the verifier was not needed; `{ error }`: it ran and failed (runner error or invalid output). */
export type VerifierOutcome = VerifierReport | { error: string } | undefined;

export const VERIFY_SLOT = "verify";
const STATUSES: CriterionStatus[] = ["met", "not_met", "cant_tell"];
const GAP_KINDS: Gap["kind"][] = ["missing", "partial", "contradicts", "unrequested"];
const STRING = { type: "string" };
export const VERIFIER_SCHEMA = {
	type: "object",
	required: ["criteria", "gaps", "blocked"],
	properties: {
		criteria: { type: "array", items: { type: "object", required: ["id", "status", "evidence"], properties: { id: STRING, status: { type: "string", enum: STATUSES }, evidence: STRING } } },
		gaps: { type: "array", items: { type: "object", required: ["kind", "criteria", "text"], properties: { kind: { type: "string", enum: GAP_KINDS }, criteria: { type: "array", items: STRING }, text: STRING } } },
		blocked: { type: "array", items: { type: "object", required: ["id", "quote", "reason"], properties: { id: STRING, quote: STRING, reason: STRING } } },
	},
} as const;

/** §12.2: more than one task integrated (untasked integrations count one each), a large diff, or a judge criterion. */
export function verifierNeeded(input: { integrations: readonly { task?: string }[]; changedLines: number; criteria: readonly Criterion[] }): boolean {
	const tasks = new Set(input.integrations.flatMap((event) => event.task === undefined ? [] : [event.task]));
	const integrated = tasks.size + input.integrations.filter((event) => event.task === undefined).length;
	return integrated > 1 || input.changedLines > VERIFIER_DIFF_LINES || input.criteria.some((criterion) => criterion.verify.kind === "judge");
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const describeCheck = (check: CheckResult) => check.passed ? `check ${check.id} passed` : `check ${check.id} ${check.timedOut ? "timed out" : `failed (exit ${check.exitCode ?? "none"})`}`;

/** §12.3, pure. `met` needs every check passed and every criterion met; a failing check always wins over the verifier.
 * `blocked` needs every check passed and a valid claim on every criterion that is not met. */
export function computeVerdict(input: { criteria: readonly Criterion[]; checks: readonly CheckResult[]; verifier: VerifierOutcome }): { verdict: Verdict; criteria: CriterionResult[]; gaps: Gap[]; reason?: string } {
	const { checks, verifier } = input;
	const report = verifier && !("error" in verifier) ? verifier : undefined;
	const failed = verifier && "error" in verifier ? verifier.error : undefined;
	const judged = new Map<string, CriterionResult>();
	for (const result of report?.criteria ?? []) if (!judged.has(result.id)) judged.set(result.id, result);
	const criteria = input.criteria.map((criterion): CriterionResult => {
		const judgment = judged.get(criterion.id);
		if (criterion.verify.kind === "check") {
			const own = criterion.verify.checks.map((id) => checks.find((check) => check.id === id));
			const evidence = criterion.verify.checks.map((id, i) => own[i] ? describeCheck(own[i]) : `check ${id} did not run`).join("; ");
			if (own.some((check) => !check?.passed)) return { id: criterion.id, status: "not_met", evidence };
			if (!report) return { id: criterion.id, status: "met", evidence };
			return judgment ? { id: criterion.id, status: judgment.status, evidence: `${evidence}; verifier: ${judgment.evidence}` } : { id: criterion.id, status: "cant_tell", evidence: `${evidence}; the verifier did not assess it` };
		}
		if (judgment) return { id: criterion.id, status: judgment.status, evidence: judgment.evidence };
		return { id: criterion.id, status: "cant_tell", evidence: failed ? `verifier failed: ${failed}` : "the verifier did not assess it" };
	});
	const failedChecks = checks.filter((check) => !check.passed);
	const unmet = criteria.filter((result) => result.status !== "met");
	// A claim counts only when its quote is a substantial verbatim span of the criterion, so the verifier cannot block on a
	// paraphrase or a single matching word.
	const blocked = (report?.blocked ?? []).filter((claim) => {
		const criterion = input.criteria.find((entry) => entry.id === claim.id);
		const quote = claim.quote.trim();
		return !!criterion && !!quote && criterion.text.includes(quote) && words(quote) >= Math.min(3, words(criterion.text)) && unmet.some((result) => result.id === claim.id);
	});
	const gaps: Gap[] = [
		...(report?.gaps ?? []),
		...(failed ? [{ kind: "missing" as const, criteria: input.criteria.map((criterion) => criterion.id), text: `verifier failed, so the run could not be verified: ${failed}` }] : []),
		...blocked.map((claim): Gap => ({ kind: "contradicts", criteria: [claim.id], text: `cannot be satisfied as written ("${claim.quote.trim()}"): ${claim.reason}` })),
		...unmet.map((result): Gap => ({ kind: result.status === "cant_tell" ? "partial" : "missing", criteria: [result.id], text: `${result.status}: ${result.evidence}` })),
		...failedChecks.map((check): Gap => ({
			kind: "missing",
			criteria: input.criteria.filter((criterion) => criterion.verify.kind === "check" && criterion.verify.checks.includes(check.id)).map((criterion) => criterion.id),
			text: `${describeCheck(check)} at ${check.commit.slice(0, 12)}`,
		})),
	];
	if (failed) return { verdict: "not_met", criteria, gaps, reason: `verifier failed: ${failed}` };
	if (!failedChecks.length && !unmet.length) return { verdict: "met", criteria, gaps };
	if (!failedChecks.length && unmet.every((result) => blocked.some((claim) => claim.id === result.id))) return { verdict: "blocked", criteria, gaps, reason: blocked.map((claim) => `${claim.id} cannot be satisfied as written: ${claim.reason}`).join("; ") };
	const reasons = [
		...(failedChecks.length ? [`failed checks: ${failedChecks.map((check) => check.id).join(", ")}`] : []),
		...(unmet.length ? [`criteria not met: ${unmet.map((result) => `${result.id} (${result.status})`).join(", ")}`] : []),
	];
	return { verdict: "not_met", criteria, gaps, reason: reasons.join("; ") };
}

/** Validates the verifier's structured result; throws with the problems when it is unusable. */
export function parseVerifierReport(data: unknown): VerifierReport {
	if (data === undefined) throw new Error("the verifier returned no structured result");
	const problems = validateSchema(VERIFIER_SCHEMA, data);
	if (problems.length) throw new Error(`invalid verifier result: ${problems.join("; ")}`);
	const report = data as VerifierReport;
	return {
		criteria: report.criteria.map(({ id, status, evidence }) => ({ id, status, evidence })),
		gaps: report.gaps.map(({ kind, criteria, text }) => ({ kind, criteria: [...criteria], text })),
		blocked: report.blocked.map(({ id, quote, reason }) => ({ id, quote, reason })),
	};
}

// A fence longer than any backtick run inside, so check output cannot close it early.
function fenced(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}\n${text.replace(/\n$/, "")}\n${fence}`;
}

export function verifierPrompt(input: { goal: string; criteria: readonly Criterion[]; checks: readonly CheckResult[]; specs: readonly CheckSpec[]; base: string; head: string; diffStat: string; plan: string }): string {
	const checks = input.checks.map((check) => {
		const command = input.specs.find((spec) => spec.id === check.id)?.command ?? "";
		return `### ${check.id}: ${check.passed ? "passed" : "FAILED"}\nCommand: \`${command}\`\nExit code: ${check.exitCode ?? "none"}${check.timedOut ? " (timed out)" : ""}\nOutput tail:\n${fenced(check.tail || "(no output)")}`;
	});
	return [
		`Verify the change from ${input.base} (base) to ${input.head} (head) against its goal. Your working directory is checked out at the head.`,
		"## Rules",
		"- Plan checkboxes, task lists, commit messages, and agent summaries are claims, not evidence.",
		"- For every acceptance criterion return `met`, `not_met`, or `cant_tell`, citing the evidence (check results, `file:line` you read, output of read-only commands you ran). A criterion verified by a check is met only if that check passed. When in doubt, never answer `met`.",
		"- Report gaps: `missing`, `partial`, `contradicts` (violates a criterion or a constraint), and `unrequested` (changes outside the goal or out of scope), each with the criterion IDs it concerns. Report every constraint violation and unrequested change.",
		"- List a criterion under `blocked` only when it cannot be satisfied as written; `quote` must be at least three words copied verbatim from that criterion's text (the whole text if it is shorter).",
		`- Criteria to assess: ${input.criteria.map((criterion) => criterion.id).join(", ")}.`,
		"## Goal (goal.md)",
		fenced(input.goal),
		`## Check results at ${input.head}`,
		...(checks.length ? checks : ["No checks are declared."]),
		`## Diff summary (git diff --stat ${input.base}..${input.head})`,
		fenced(input.diffStat || "(no changes)"),
		`List the changed files with \`git diff --name-only ${input.base} ${input.head}\` and read them in your working directory.`,
		"## Plan (plan.md; claims, not evidence)",
		fenced(input.plan || "(empty)"),
	].join("\n\n");
}

/** Runs §12 verification at the integration head and journals `verify.completed`. Refuses an unapproved or changed goal. */
export async function verifyRun(deps: VerifyDeps): Promise<VerifyOutcome> {
	const { store, vcs, runId } = deps;
	const state = store.state();
	if (!state.goal) throw new Error("cannot verify: the goal is not approved");
	const goalText = readFileSync(store.paths.goal, "utf8");
	if (hashGoal(goalText) !== state.goal.sha256) throw new Error("cannot verify: goal.md changed after approval; restore the approved goal or approve the new one");
	const goal = parseGoal(goalText);
	const base = state.base;
	const head = vcs.readRef(integrationRef(runId)) ?? state.integrationHead;
	if (!base || !head) throw new Error("cannot verify: the run has no base commit");
	const limits = deps.limits ?? LIMITS;
	const signal = deps.signal ?? new AbortController().signal;
	const path = worktreePath(vcs.commonDir(), runId, VERIFY_SLOT);
	vcs.removeWorktree(path);
	const checks: CheckResult[] = [];
	let verifier: VerifierOutcome;
	let verifierRan = false;
	try {
		vcs.addWorktree(path, head);
		for (const spec of deps.checks) {
			const result = await runCheck(spec, { cwd: path, commit: head, outputs: store.outputs, signal });
			checks.push(result);
			const { id: checkId, commit, exitCode, timedOut, durationMs, logRef, tail } = result;
			store.journal.append({ t: "check.completed", checkId, commit, exitCode, timedOut, durationMs, logRef, tail, purpose: "verify" });
		}
		const range = `${base}..${head}`;
		if (verifierNeeded({ integrations: state.integrations, changedLines: vcs.changedLines(range), criteria: goal.criteria })) {
			verifierRan = true;
			const role = deps.roles.get("verifier");
			const plan = readFileSync(store.paths.plan, "utf8");
			const prompt = verifierPrompt({ goal: goalText, criteria: goal.criteria, checks, specs: deps.checks, base, head, diffStat: vcs.diffStat(range), plan });
			try {
				if (!role) throw new Error("the verifier role is not defined");
				const result = await deps.runner.run({ role, prompt, cwd: path, schema: VERIFIER_SCHEMA, signal, timeoutMs: limits.timeoutMs, stallMs: limits.stallMs });
				verifier = parseVerifierReport(result.data);
			} catch (error) {
				// A stop is not a verdict: nothing is journaled.
				if (signal.aborted) throw error;
				verifier = { error: error instanceof Error ? error.message : String(error) };
			}
		}
	} finally {
		vcs.removeWorktree(path);
	}
	const { verdict, criteria, gaps, reason } = computeVerdict({ criteria: goal.criteria, checks, verifier });
	const appended = appendConvergence(readFileSync(store.paths.plan, "utf8"), gaps);
	writeAtomic(store.paths.plan, appended.text);
	store.journal.append({ t: "verify.completed", head, checks, verdict, criteria, verifierRan, gaps });
	deps.onProgress?.();
	return { verdict, head, checks, criteria, gaps, verifierRan, convergence: appended.n, ...(reason ? { reason } : {}) };
}
