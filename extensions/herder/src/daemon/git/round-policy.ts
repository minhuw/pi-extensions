#!/usr/bin/env node

import process from "node:process"
import { pathToFileURL } from "node:url"
import { fail } from "./primitives.ts"

const REVIEW_VERDICTS = new Set(["APPROVE", "REVISE", "BLOCK"])
const REVIEW_SCOPES = new Set(["PASS", "FAIL"])
const JUDGE_DECISIONS = new Set(["DONE", "REPAIR", "NEEDS_INPUT", "BLOCKED"])

export type ReviewVerdict = "APPROVE" | "REVISE" | "BLOCK"
export type ReviewScope = "PASS" | "FAIL"
export type JudgeDecision = "DONE" | "REPAIR" | "NEEDS_INPUT" | "BLOCKED"
export type PolicyAction = "READY_TO_INTEGRATE" | "BLOCKED" | "REPAIR_DIRECT" | "JUDGE" | "BLOCKED_ROUND_LIMIT" | "REPAIR_GUIDED" | "NEEDS_INPUT"

interface ParsedPolicyArgs {
  event: "review" | "judge"
  pretty: boolean
  round?: string
  verdict?: string
  scope?: string
  open_blockers?: string
  decision?: string
}

function parseInteger(value: string | undefined, name: string, { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}): number {
  if (!/^(0|[1-9]\d*)$/.test(value ?? "")) fail(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(`${name} must be between ${min} and ${max}`)
  }
  return parsed
}

function parseArgs(argv: string[]): ParsedPolicyArgs {
  const [event, ...rest] = argv
  if (!event || !new Set(["review", "judge"]).has(event)) {
    fail("usage: round-policy.ts <review|judge> --round <1..6> [options] [--pretty]")
  }
  const allowedKeys = event === "review"
    ? new Set(["round", "verdict", "scope", "open_blockers"])
    : new Set(["round", "decision"])
  const values: ParsedPolicyArgs = { event: event as "review" | "judge", pretty: false }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === "--pretty") {
      if (values.pretty) fail("--pretty was provided more than once")
      values.pretty = true
      continue
    }
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`)
    const key = arg.slice(2).replaceAll("-", "_")
    if (!allowedKeys.has(key)) fail(`unexpected option for ${event}: ${arg}`)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`)
    if (Object.hasOwn(values, key)) fail(`${arg} was provided more than once`)
    values[key as keyof ParsedPolicyArgs] = value as never
    index += 1
  }
  return values
}

export function decideReview({ round, verdict, scope, openBlockers }: { round: number | string; verdict: ReviewVerdict; scope: ReviewScope; openBlockers: number | string }): { action: PolicyAction; judgeRequired: boolean; nextRound: number | null } {
  const normalizedRound = parseInteger(String(round), "round", { min: 1, max: 6 })
  const normalizedBlockers = parseInteger(String(openBlockers), "open-blockers")
  if (!REVIEW_VERDICTS.has(verdict)) fail("verdict must be APPROVE, REVISE, or BLOCK")
  if (!REVIEW_SCOPES.has(scope)) fail("scope must be PASS or FAIL")

  if (verdict === "APPROVE") {
    if (scope !== "PASS" || normalizedBlockers !== 0) {
      fail("APPROVE requires scope PASS and zero open blockers")
    }
    return { action: "READY_TO_INTEGRATE", judgeRequired: false, nextRound: null }
  }

  if (normalizedRound <= 2) {
    if (verdict === "BLOCK") {
      return { action: "BLOCKED", judgeRequired: false, nextRound: null }
    }
    if (normalizedBlockers < 1) fail("REVISE requires at least one open blocker")
    return { action: "REPAIR_DIRECT", judgeRequired: false, nextRound: normalizedRound + 1 }
  }

  return { action: "JUDGE", judgeRequired: true, nextRound: null }
}

export function decideJudge({ round, decision }: { round: number | string; decision: JudgeDecision }): { action: PolicyAction; nextRound: number | null } {
  const normalizedRound = parseInteger(String(round), "round", { min: 3, max: 6 })
  if (!JUDGE_DECISIONS.has(decision)) {
    fail("decision must be DONE, REPAIR, NEEDS_INPUT, or BLOCKED")
  }
  if (decision === "DONE") {
    return { action: "READY_TO_INTEGRATE", nextRound: null }
  }
  if (decision === "REPAIR") {
    if (normalizedRound === 6) return { action: "BLOCKED_ROUND_LIMIT", nextRound: null }
    return { action: "REPAIR_GUIDED", nextRound: normalizedRound + 1 }
  }
  return { action: decision, nextRound: null }
}

export function main(argv: string[] = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const round = parseInteger(args.round, "round", { min: 1, max: 6 })
  let result
  if (args.event === "review") {
    if (args.decision !== undefined) fail("--decision is invalid for review")
    result = decideReview({
      round,
      verdict: args.verdict as ReviewVerdict,
      scope: args.scope as ReviewScope,
      openBlockers: args.open_blockers ?? "",
    })
  } else {
    if (args.verdict !== undefined || args.scope !== undefined || args.open_blockers !== undefined) {
      fail("review options are invalid for judge")
    }
    result = decideJudge({ round, decision: args.decision as JudgeDecision })
  }
  const output = { ok: true, event: args.event, round, ...result }
  process.stdout.write(`${JSON.stringify(output, null, args.pretty ? 2 : 0)}\n`)
  return output
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntrypoint) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`round-policy: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
