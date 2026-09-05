import { MAX_PLAN_ROUNDS } from "../../shared/protocol.ts"
import { fail } from "./primitives.ts"

const REVIEW_VERDICTS = new Set(["APPROVE", "REVISE", "BLOCK"])
const REVIEW_SCOPES = new Set(["PASS", "FAIL"])
const JUDGE_DECISIONS = new Set(["DONE", "REPAIR", "NEEDS_INPUT", "BLOCKED"])

export type ReviewVerdict = "APPROVE" | "REVISE" | "BLOCK"
export type ReviewScope = "PASS" | "FAIL"
export type JudgeDecision = "DONE" | "REPAIR" | "NEEDS_INPUT" | "BLOCKED"
export type PolicyAction = "READY_TO_INTEGRATE" | "BLOCKED" | "REPAIR_DIRECT" | "JUDGE" | "BLOCKED_ROUND_LIMIT" | "REPAIR_GUIDED" | "NEEDS_INPUT"

function parseInteger(value: string | undefined, name: string, { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}): number {
  if (!/^(0|[1-9]\d*)$/.test(value ?? "")) fail(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(`${name} must be between ${min} and ${max}`)
  }
  return parsed
}

export function decideReview({ round, verdict, scope, openBlockers }: { round: number | string; verdict: ReviewVerdict; scope: ReviewScope; openBlockers: number | string }): { action: PolicyAction; judgeRequired: boolean; nextRound: number | null } {
  const normalizedRound = parseInteger(String(round), "round", { min: 1, max: MAX_PLAN_ROUNDS })
  const normalizedBlockers = parseInteger(String(openBlockers), "open-blockers")
  if (!REVIEW_VERDICTS.has(verdict)) fail("verdict must be APPROVE, REVISE, or BLOCK")
  if (!REVIEW_SCOPES.has(scope)) fail("scope must be PASS or FAIL")

  if (verdict === "APPROVE") {
    if (scope !== "PASS" || normalizedBlockers !== 0) {
      fail("APPROVE requires scope PASS and zero open blockers")
    }
    return { action: "READY_TO_INTEGRATE", judgeRequired: false, nextRound: null }
  }

  if (normalizedRound === 1) {
    if (verdict === "BLOCK") {
      return { action: "BLOCKED", judgeRequired: false, nextRound: null }
    }
    return { action: "REPAIR_DIRECT", judgeRequired: false, nextRound: normalizedRound + 1 }
  }

  if (normalizedRound === MAX_PLAN_ROUNDS) return { action: "BLOCKED_ROUND_LIMIT", judgeRequired: false, nextRound: null }
  return { action: "JUDGE", judgeRequired: true, nextRound: null }
}

export function decideJudge({ round, decision }: { round: number | string; decision: JudgeDecision }): { action: PolicyAction; nextRound: number | null } {
  const normalizedRound = parseInteger(String(round), "round", { min: 2, max: 2 })
  if (!JUDGE_DECISIONS.has(decision)) {
    fail("decision must be DONE, REPAIR, NEEDS_INPUT, or BLOCKED")
  }
  if (decision === "DONE") {
    return { action: "READY_TO_INTEGRATE", nextRound: null }
  }
  if (decision === "REPAIR") {
    return { action: "REPAIR_GUIDED", nextRound: normalizedRound + 1 }
  }
  return { action: decision, nextRound: null }
}
