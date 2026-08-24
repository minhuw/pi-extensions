import fs from "node:fs"
import path from "node:path"
import { buildGraph } from "../core/plans.ts"
import { readPlanLifecycle } from "../core/workflow.ts"
import { executionReport, readUsageState } from "../daemon/execution-store.ts"
import { readManagerState } from "../daemon/run-store.ts"
import type { UsageRecord } from "../daemon/execution-store.ts"
import { listCoordinationRefs, validatePlanName } from "../daemon/git/coordination-ref.ts"
import { inspectCompletionProof } from "../daemon/git/completion-proof.ts"
import { listHerderBranches, listWorktreeInventory } from "../daemon/git/namespace-inventory.ts"
import { fail, isInside, runGit } from "../daemon/git/primitives.ts"

export const DASHBOARD_STATE_VERSION = 2

type DashboardPhase = "complete" | "rejected" | "blocked" | "waiting" | "ready" | "queued"
  | "implementation" | "review" | "judge" | "gates" | "repair" | "judge-queued" | "integration" | "coordination"
interface LeaseView { role: string; attempt: string | null; task: string | null; reason: string }
interface ForecastPlan {
  id: string
  phase: DashboardPhase
  report: ReturnType<typeof planReport>
}
interface PlanView extends ForecastPlan {
  status: string
  unsatisfied: string[]
  [key: string]: any
}
interface DashboardInput { planDir?: string; planName?: string | null }
type DynamicRecord = Record<string, any>


export function parseLease(reason: string | null, planName: string, planId: string): LeaseView | null {
  if (!reason) return null
  const prefix = `plan-herder:${planName}:${planId}:`
  if (!reason.startsWith(prefix)) return { role: "coordination", attempt: null, task: null, reason }
  const fields = reason.slice(prefix.length).split(":")
  return {
    role: fields.shift() || "coordination",
    attempt: fields.shift() || null,
    task: fields.join(":") || null,
    reason,
  }
}

function rolePhase(role: unknown): DashboardPhase {
  const normalized = String(role ?? "").toLowerCase()
  if (normalized.includes("implementer")) return "implementation"
  if (normalized.includes("reviewer")) return "review"
  if (normalized.includes("judge")) return "judge"
  return "coordination"
}

function latestRecord(records: UsageRecord[]): UsageRecord | null {
  let latest: UsageRecord | null = null
  let latestTime = ""
  for (const record of records) {
    const time = record.finishedAt ?? record.recordedAt ?? ""
    if (!latest || time >= latestTime) {
      latest = record
      latestTime = time
    }
  }
  return latest
}

function outcomeContains(record: UsageRecord | null, words: string[]): boolean {
  const outcome = String(record?.outcome ?? "").toUpperCase()
  return words.some((word) => outcome.includes(word))
}

export function derivePlanPhase(
  plan: { status: string; unsatisfied: string[] },
  attempts: UsageRecord[],
  lease: LeaseView | null,
  completion: unknown,
): DashboardPhase {
  if (completion || plan.status === "DONE") return "complete"
  if (plan.status === "REJECTED") return "rejected"
  if (plan.status === "BLOCKED") return "blocked"
  if (lease) return rolePhase(lease.role)
  if (plan.status === "TODO") return plan.unsatisfied.length > 0 ? "waiting" : "ready"
  const latest = latestRecord(attempts)
  if (!latest) return "queued"
  const role = String(latest.role).toLowerCase()
  if (role.includes("implementer")) {
    return outcomeContains(latest, ["COMPLETE", "SUCCESS", "DONE"]) ? "gates" : "repair"
  }
  if (role.includes("reviewer")) {
    if (outcomeContains(latest, ["APPROVE"])) return "integration"
    return Number(latest.round ?? 0) >= 3 ? "judge-queued" : "repair"
  }
  if (role.includes("judge")) {
    return outcomeContains(latest, ["DONE", "APPROVE"]) ? "integration" : "repair"
  }
  return "coordination"
}

export function managerPlanPhase(spec: DynamicRecord, runtime: DynamicRecord | null, activeAction: DynamicRecord | null, unsatisfied: string[]): DashboardPhase {
  if (!runtime) {
    if (spec.initialStatus === "DONE") return "complete"
    if (spec.initialStatus === "REJECTED") return "rejected"
    if (spec.initialStatus === "BLOCKED") return "blocked"
    return unsatisfied.length > 0 ? "waiting" : "ready"
  }
  if (runtime.phase === "DONE" || runtime.phase === "FINAL_APPROVED") return "complete"
  if (runtime.phase === "BLOCKED" || runtime.phase === "NEEDS_INPUT") return "blocked"
  if (runtime.phase === "READY_TO_INTEGRATE") return "integration"
  if (["READY_JUDGE", "JUDGING"].includes(runtime.phase)) return activeAction ? "judge" : "judge-queued"
  if (["READY_REVIEWER", "REVIEWING"].includes(runtime.phase)) return "review"
  if (["READY_IMPLEMENTER", "IMPLEMENTING"].includes(runtime.phase)) {
    if (runtime.round > 1 && !activeAction) return "repair"
    return activeAction ? "implementation" : "ready"
  }
  return "coordination"
}

function attemptsByRound(attempts: UsageRecord[]): Array<{ round: number | null; attempts: UsageRecord[] }> {
  const rounds = new Map<number, UsageRecord[]>()
  for (const attempt of attempts) {
    const key = attempt.round ?? 0
    const group = rounds.get(key) ?? []
    group.push(attempt)
    rounds.set(key, group)
  }
  return [...rounds.entries()]
    .sort(([left], [right]) => left - right)
    .map(([round, records]) => ({ round: round || null, attempts: records }))
}

function shortSha(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}

export function buildForecast(plans: ForecastPlan[], runReport: ReturnType<typeof executionReport>) {
  const terminal = plans.filter((plan) => ["complete", "rejected"].includes(plan.phase))
  const unfinished = plans.filter((plan) => !["complete", "rejected"].includes(plan.phase))
  const completedDurations = terminal
    .filter((plan) => plan.report.attempts > 0
      && plan.report.timing.attemptDurationMs !== null
      && plan.report.timing.durationCoverage.reported === plan.report.timing.durationCoverage.total)
    .map((plan) => plan.report.timing.attemptDurationMs!)
  const elapsedMs = runReport.timing.wallClockMs
  const sufficientEvidence = terminal.length >= 2
    && completedDurations.length >= 2
    && elapsedMs !== null
    && elapsedMs > 0
  const estimatedPlanMs = sufficientEvidence ? median(completedDurations) : null
  const byPlan = Object.fromEntries(plans.map((plan) => {
    if (["complete", "rejected"].includes(plan.phase)) return [plan.id, { remainingMs: 0 }]
    if (!sufficientEvidence || plan.phase === "blocked") return [plan.id, { remainingMs: null }]
    const observedMs = plan.report.timing.attemptDurationMs ?? 0
    const minimumRemainingMs = plan.report.attempts > 0 ? Math.round(estimatedPlanMs! * 0.25) : 0
    return [plan.id, { remainingMs: Math.max(minimumRemainingMs, estimatedPlanMs! - observedMs) }]
  }))
  return {
    finished: terminal.length,
    unfinished: unfinished.length,
    percent: plans.length === 0 ? 0 : Math.round((terminal.length / plans.length) * 100),
    sufficientEvidence,
    samples: completedDurations.length,
    elapsedMs,
    estimatedPlanMs,
    estimatedRemainingMs: sufficientEvidence
      ? Math.round((elapsedMs / terminal.length) * unfinished.length)
      : null,
    byPlan,
  }
}

function planReport(records: UsageRecord[]) {
  const report = executionReport(records)
  return {
    attempts: report.attempts,
    rounds: report.rounds,
    interruptions: report.interruptions,
    tokenCoverage: report.tokenCoverage,
    tokens: report.tokens,
    timing: report.timing,
    byRole: report.byRole,
    byOutcome: report.byOutcome,
    byModel: report.byModel,
    byHarness: report.byHarness,
    byGeneration: report.byGeneration,
    byServiceTier: report.byServiceTier,
  }
}

function resolveContext(inputDir: string, inputPlanName?: string | null) {
  const planCandidate = path.resolve(inputDir)
  if (!fs.existsSync(planCandidate) || !fs.statSync(planCandidate).isDirectory()) {
    fail(`Plan directory does not exist: ${planCandidate}`)
  }
  const planDir = fs.realpathSync(planCandidate)
  const repoRoot = fs.realpathSync(runGit(planDir, ["rev-parse", "--show-toplevel"]).stdout.trim())
  if (!isInside(repoRoot, planDir)) fail(`Plan directory must be inside the Git repository: ${planDir}`)
  const planName = validatePlanName(inputPlanName ?? path.basename(planDir))
  return { planDir, planName, repoRoot }
}

function dependencyWaves(plans: Array<{ id: string; dependencies: string[] }>): string[][] {
  const remaining = new Map(plans.map((plan) => [plan.id, new Set(plan.dependencies)]))
  const waves: string[][] = []
  while (remaining.size > 0) {
    const wave = [...remaining].filter(([, dependencies]) => [...dependencies].every((id) => !remaining.has(id))).map(([id]) => id).sort()
    if (wave.length === 0) fail("Compiled plan specification contains a dependency cycle")
    waves.push(wave)
    for (const id of wave) remaining.delete(id)
  }
  return waves
}

export function buildDashboardState(input: DashboardInput = {}) {
  const context = resolveContext(input.planDir ?? "herder-plans", input.planName)
  const manager = readManagerState(context.planDir)
  if (manager.run && manager.specs.length === 0) fail("Manager run has no compiled plan specification")
  const graph: DynamicRecord = manager.run ? {
    plans: manager.specs.map((spec) => ({
      id: spec.planId,
      title: spec.title,
      priority: spec.priority,
      effort: spec.effort,
      kind: spec.kind,
      dependencies: spec.dependencies,
      status: spec.initialStatus,
      statusDetail: spec.initialStatusDetail,
      shapeReady: true,
    })),
    ready: [],
    shapeReady: true,
    waves: dependencyWaves(manager.specs.map((spec) => ({ id: spec.planId, dependencies: spec.dependencies }))),
    warnings: [],
  } : buildGraph(context.planDir)
  const usage = readUsageState(context.planDir)
  const records = usage.records
  const recordsByPlan = new Map<string, UsageRecord[]>()
  for (const record of records) {
    const group = recordsByPlan.get(record.plan) ?? []
    group.push(record)
    recordsByPlan.set(record.plan, group)
  }
  const branches = listHerderBranches(context.repoRoot, context.planName)
  const coordinationRefs = listCoordinationRefs(context.repoRoot, context.planName)
  const worktrees = listWorktreeInventory(context.repoRoot)
  const branchByRelative = new Map(branches.map((item) => [item.relative, item]))
  const worktreeByBranch = new Map(worktrees.filter((item) => item.path && item.branch).map((item) => [item.branch, item]))
  const completionByPlan = new Map(coordinationRefs
    .filter((item) => /^completed\/\d{3,}$/.test(item.relative))
    .map((item) => {
      const plan = item.relative.slice("completed/".length)
      const proof = inspectCompletionProof(context.repoRoot, item.ref)
      return [plan, { ...item, proof, target: proof.ok ? proof.object : item.target }]
    }))
  const runtimeById = new Map(manager.plans.map((plan) => [plan.planId, plan]))
  const activeActionById = new Map(manager.actions.filter((action) => ["proposed", "dispatched"].includes(action.state)).map((action) => [action.planId, action]))
  const sourcePlans = graph.plans as DynamicRecord[]
  const lifecycle = readPlanLifecycle(context.planDir)
  const statusById = new Map(sourcePlans.map((plan) => [plan.id, lifecycle.get(plan.id) ?? plan.status]))
  const plans = sourcePlans.map((plan) => {
    const branch = branchByRelative.get(plan.id) ?? null
    const branchName = `herder/${context.planName}/${plan.id}`
    const worktree = worktreeByBranch.get(branchName) ?? null
    const completion = completionByPlan.get(plan.id) ?? null
    const attempts = recordsByPlan.get(plan.id) ?? []
    const unsatisfied = (plan.dependencies as string[]).filter((id: string) => statusById.get(id) !== "DONE")
    const lease = worktree?.locked ? parseLease(worktree.lockReason, context.planName, plan.id) : null
    const planAttention = manager.attention?.planId === plan.id ? manager.attention : null
    const planView: PlanView = {
      id: String(plan.id),
      title: plan.title,
      priority: plan.priority,
      effort: plan.effort,
      kind: plan.kind,
      status: String(statusById.get(plan.id)),
      statusDetail: runtimeById.get(plan.id)?.repair?.[0] ?? plan.statusDetail,
      dependencies: plan.dependencies,
      unsatisfied,
      ready: graph.ready.includes(plan.id),
      branch: branch ? { name: branchName, head: branch.head, shortHead: shortSha(branch.head) } : null,
      worktree: worktree ? {
        path: worktree.path,
        head: worktree.head || null,
        shortHead: shortSha(worktree.head),
        locked: worktree.locked,
      } : null,
      lease,
      completion: completion ? { ref: completion.ref, target: completion.target, shortTarget: shortSha(completion.target) } : null,
      phase: "coordination",
      rounds: attemptsByRound(attempts),
      report: planReport(attempts),
      ...(planAttention ? { attention: planAttention } : {}),
    }
    const runtime = runtimeById.get(plan.id) ?? null
    planView.phase = manager.run
      ? managerPlanPhase(plan, runtime, activeActionById.get(plan.id) ?? null, unsatisfied)
      : derivePlanPhase(planView, attempts, lease, completion)
    return planView
  })
  const integrationBranch = branchByRelative.get("integration") ?? null
  const integrationName = `herder/${context.planName}/integration`
  const integrationWorktree = worktreeByBranch.get(integrationName) ?? null
  const runReport = executionReport(records, "RUN")
  const forecast = buildForecast(plans, runReport)
  const counts: {
    total: number
    todo: number
    inProgress: number
    done: number
    blocked: number
    rejected: number
    actionable: number
  } = {
    total: plans.length,
    todo: plans.filter((plan) => plan.status === "TODO").length,
    inProgress: plans.filter((plan) => plan.status === "IN PROGRESS").length,
    done: plans.filter((plan) => plan.status === "DONE").length,
    blocked: plans.filter((plan) => plan.status === "BLOCKED").length,
    rejected: plans.filter((plan) => plan.status === "REJECTED").length,
    actionable: 0,
  }
  counts.actionable = counts.todo + counts.inProgress + counts.blocked

  return {
    version: DASHBOARD_STATE_VERSION,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    planSet: {
      name: context.planName,
      directory: context.planDir,
      repository: context.repoRoot,
      complete: counts.done + counts.rejected === counts.total,
      shapeReady: graph.shapeReady,
      counts,
      ready: plans.filter((plan) => plan.phase === "ready").map((plan) => plan.id),
      inProgress: plans.filter((plan) => plan.status === "IN PROGRESS").map((plan) => plan.id),
      blocked: plans.filter((plan) => plan.status === "BLOCKED").map((plan) => plan.id),
      waiting: plans.filter((plan) => plan.phase === "waiting").map((plan) => plan.id),
      waves: graph.waves,
      warnings: graph.warnings,
    },
    accounting: {
      database: usage.database,
      databaseExists: usage.databaseExists,
      storage: usage.storage,
      schemaVersion: usage.schemaVersion,
      runConfiguration: usage.runConfiguration,
      attempts: runReport.attempts,
      rounds: runReport.rounds,
      interruptions: runReport.interruptions,
      tokenCoverage: runReport.tokenCoverage,
      tokens: runReport.tokens,
      timing: runReport.timing,
      byRole: runReport.byRole,
      byOutcome: runReport.byOutcome,
      byModel: runReport.byModel,
      byHarness: runReport.byHarness,
    },
    manager,
    forecast,
    integration: {
      branch: integrationBranch ? {
        name: integrationName,
        head: integrationBranch.head,
        shortHead: shortSha(integrationBranch.head),
      } : null,
      worktree: integrationWorktree ? {
        path: integrationWorktree.path,
        head: integrationWorktree.head || null,
        shortHead: shortSha(integrationWorktree.head),
        locked: integrationWorktree.locked,
        lockReason: integrationWorktree.lockReason || null,
      } : null,
      completedPlans: [...completionByPlan.keys()].sort(),
      readyPlans: plans.filter((plan) => plan.phase === "integration").map((plan) => plan.id),
    },
    plans,
  }
}

export function buildDashboardStateBody(input: DashboardInput = {}): string {
  return `${JSON.stringify(buildDashboardState(input))}\n`
}
