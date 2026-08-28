import { buildGraph } from "./plans.ts"
import { executionReport, readUsageState } from "../daemon/execution-store.ts"
import { readManagerState } from "../daemon/run-store.ts"

const DEFAULT_PLAN_DIR = "herder-plans"

function fail(message: string): never {
  throw new Error(message)
}

function canonicalId(value: unknown, context = "plan ID"): string {
  const match = String(value).match(/\b(\d+)\b/)
  if (!match) fail(`Cannot find a numeric plan ID in ${context}: ${JSON.stringify(value)}`)
  const numeric = Number.parseInt(match[1]!, 10)
  if (!Number.isSafeInteger(numeric)) fail(`Invalid plan ID in ${context}: ${JSON.stringify(value)}`)
  return String(numeric).padStart(3, "0")
}

export function getExecutionReport(inputDir = DEFAULT_PLAN_DIR, inputPlan = "RUN") {
  const graph = buildGraph(inputDir)
  const requested = String(inputPlan ?? "RUN").trim()
  const plan = requested.toUpperCase() === "RUN" ? "RUN" : canonicalId(requested)
  const planRecord = plan === "RUN" ? null : graph.plans.find((candidate) => candidate.id === plan)
  if (plan !== "RUN" && !planRecord) fail(`Plan ${plan} is not indexed in ${graph.readme}`)
  const state = readUsageState(graph.planDir)
  let managerState: ReturnType<typeof readManagerState> | undefined
  try { managerState = readManagerState(graph.planDir) } catch { /* Reports still work without a live manager run. */ }
  const runGeneration = managerState?.run?.currentGeneration
  const planGenerations = new Map(managerState?.plans.map((runtime) => [String(runtime.planId), Number(runtime.generation)]) ?? [])
  const specGenerations = new Map(managerState?.specs.map((spec) => [String(spec.planId), Number(spec.graphGeneration)]) ?? [])
  const records = state.records.map((record) => {
    const currentGeneration = record.plan === "RUN"
      ? (planGenerations.get("RUN") ?? runGeneration)
      : (planGenerations.get(record.plan) ?? specGenerations.get(record.plan))
    return {
      ...record,
      superseded: Boolean(currentGeneration && record.generation && record.generation !== `generation-${currentGeneration}`),
    }
  })
  const report = executionReport(records, plan)
  const supersededAttempts = report.records.filter((record) => record.superseded).length
  return {
    planDir: graph.planDir,
    readme: graph.readme,
    database: state.database,
    storage: state.storage,
    schemaVersion: state.schemaVersion,
    runConfiguration: state.runConfiguration,
    lifecycle: plan === "RUN"
      ? { complete: graph.complete, counts: graph.counts }
      : { title: planRecord!.title, status: planRecord!.status, statusDetail: planRecord!.statusDetail },
    ...report,
    supersededAttempts,
  }
}
