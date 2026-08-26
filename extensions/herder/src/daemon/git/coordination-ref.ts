import { fail, runGit } from "./primitives.ts"

const PLAN_ID = /^\d{3,}$/
const PLAN_NAME = /^[a-z0-9][a-z0-9._-]*$/
const CURRENT_GENERATION = /^generation-(\d+)$/

export interface CheckpointRef {
  kind: "checkpoint"
  plan: string
  generation: string
  generationNumber?: string
  ordinal: string
  format: "generation" | "numeric-legacy"
  ref?: string
  relative?: string
}

export type CoordinationRef = CheckpointRef
  | { kind: "base"; plan: null }
  | { kind: "completed"; plan: string }
  | { kind: "restack-target"; plan: string; generation: string; generationNumber: string; ordinal: string }
  | { kind: "run-checkpoint"; plan: null; ordinal: string }

export interface FormatCheckpointInput {
  planName: string
  plan: string
  generation: string
  ordinal: string | number | bigint
}

export function validatePlanName(value: unknown): string {
  const name = String(value)
  if (!PLAN_NAME.test(name)
    || name.includes("..")
    || name.endsWith(".")
    || name.endsWith(".lock")) {
    fail(`Plan-set name must be a lowercase Git-safe basename: ${JSON.stringify(name)}`)
  }
  return name
}

export function parseCheckpointRefRelative(relative: string): CheckpointRef | null {
  const current = String(relative).match(/^checkpoints\/(\d{3,})\/(generation-(\d+))-(\d+)$/)
  if (current) {
    return {
      kind: "checkpoint",
      plan: current[1],
      generation: current[2],
      generationNumber: current[3],
      ordinal: current[4],
      format: "generation",
    }
  }
  const numeric = String(relative).match(/^checkpoints\/(\d{3,})\/(\d+)-(\d+)$/)
  if (numeric) {
    return {
      kind: "checkpoint",
      plan: numeric[1],
      generation: numeric[2],
      generationNumber: numeric[2],
      ordinal: numeric[3],
      format: "numeric-legacy",
    }
  }
  return null
}

export function parseCoordinationRefRelative(relative: string): CoordinationRef | null {
  const value = String(relative)
  if (value === "base") return { kind: "base", plan: null }
  const completed = value.match(/^completed\/(\d{3,})$/)
  if (completed) return { kind: "completed", plan: completed[1] }
  const restackTarget = value.match(/^restacks\/(\d{3,})\/(generation-(\d+))-(\d+)-onto$/)
  if (restackTarget) {
    return {
      kind: "restack-target",
      plan: restackTarget[1],
      generation: restackTarget[2],
      generationNumber: restackTarget[3],
      ordinal: restackTarget[4],
    }
  }
  const checkpoint = parseCheckpointRefRelative(value)
  if (checkpoint) return checkpoint
  const runCheckpoint = value.match(/^checkpoints\/RUN\/(\d+)$/)
  if (runCheckpoint) {
    return { kind: "run-checkpoint", plan: null, ordinal: runCheckpoint[1] }
  }
  return null
}

export function formatCheckpointRef({ planName, plan, generation, ordinal }: FormatCheckpointInput): CheckpointRef & { ref: string; relative: string; format: "generation" } {
  const normalizedPlanName = String(planName)
  const normalizedPlan = String(plan)
  const normalizedGeneration = String(generation)
  const normalizedOrdinal = String(ordinal)
  validatePlanName(normalizedPlanName)
  if (!PLAN_ID.test(normalizedPlan)) fail(`Invalid checkpoint plan ID: ${JSON.stringify(plan)}`)
  if (!CURRENT_GENERATION.test(normalizedGeneration)) {
    fail(`Checkpoint generation must use generation-<n>: ${JSON.stringify(generation)}`)
  }
  if (!/^\d+$/.test(normalizedOrdinal) || BigInt(normalizedOrdinal) < 1n) {
    fail(`Checkpoint ordinal must be a positive integer: ${JSON.stringify(ordinal)}`)
  }
  const canonicalOrdinal = BigInt(normalizedOrdinal).toString().padStart(3, "0")
  const relative = `checkpoints/${normalizedPlan}/${normalizedGeneration}-${canonicalOrdinal}`
  return {
    ref: `refs/plan-herder/${normalizedPlanName}/${relative}`,
    relative,
    kind: "checkpoint",
    plan: normalizedPlan,
    generation: normalizedGeneration,
    ordinal: canonicalOrdinal,
    format: "generation",
  }
}

export interface CoordinationRefRecord {
  ref: string
  target: string
  relative: string
  identity: CoordinationRef | null
}

export function listCoordinationRefs(repoRoot: string, planName: string): CoordinationRefRecord[] {
  const prefix = `refs/plan-herder/${planName}/`
  const output = runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    prefix,
  ]).stdout
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t")
    if (separator === -1) fail(`Cannot parse coordination ref record: ${JSON.stringify(line)}`)
    const ref = line.slice(0, separator)
    const target = line.slice(separator + 1)
    const relative = ref.slice(prefix.length)
    return { ref, target, relative, identity: parseCoordinationRefRelative(relative) }
  })
}
