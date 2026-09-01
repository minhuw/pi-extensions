import fs from "node:fs"
import path from "node:path"
import { buildGraph } from "../../core/plans.ts"
import { listCoordinationRefs, validatePlanName } from "./coordination-ref.ts"
import { inspectCompletionProof } from "./completion-proof.ts"
import { listHerderBranches, listWorktreeInventory } from "./namespace-inventory.ts"
import { fail, isAncestor, isInside, runGit } from "./primitives.ts"

type NamespaceMode = "fire" | "resume"
interface NamespaceInput {
  repo: string
  planDir: string
  planName?: string | null
  mode: NamespaceMode
}
interface RefRecord { ref: string; target: string; relative: string }
type NamespaceConflict = Record<string, string>

function refExists(repoRoot: string, ref: string): boolean {
  return runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }).status === 0
}

export function inspectNamespace(input: NamespaceInput) {
  const repoCandidate = path.resolve(input.repo)
  if (!fs.existsSync(repoCandidate) || !fs.statSync(repoCandidate).isDirectory()) fail(`Repository does not exist: ${repoCandidate}`)
  const repoRoot = fs.realpathSync(repoCandidate)
  const actualRoot = fs.realpathSync(runGit(repoRoot, ["rev-parse", "--show-toplevel"]).stdout.trim())
  if (actualRoot !== repoRoot) fail(`--repo must be the Git repository root: ${actualRoot}`)

  const planCandidate = path.resolve(repoRoot, input.planDir)
  if (!fs.existsSync(planCandidate) || !fs.statSync(planCandidate).isDirectory()) fail(`Plan directory does not exist: ${planCandidate}`)
  const planDir = fs.realpathSync(planCandidate)
  if (!isInside(repoRoot, planDir)) fail(`Plan directory must be inside the repository: ${planDir}`)

  const planName = validatePlanName(input.planName ?? path.basename(planCandidate))
  const namespace = `herder/${planName}`
  const integrationBranch = `${namespace}/integration`
  runGit(repoRoot, ["check-ref-format", "--branch", integrationBranch])

  const graph = buildGraph(planDir)
  const planIds = new Set(graph.plans.map((plan) => plan.id))
  const branches = listHerderBranches(repoRoot, planName)
  const coordinationRecords = listCoordinationRefs(repoRoot, planName)
  const parentConflicts = [
    "refs/heads/herder",
    `refs/heads/${namespace}`,
    "refs/plan-herder",
    `refs/plan-herder/${planName}`,
  ].filter((ref) => refExists(repoRoot, ref))
  const integration = branches.find((item) => item.relative === "integration") ?? null
  const baseRef = coordinationRecords.find((item) => item.relative === "base") ?? null

  const planBranches = branches.filter((item) => /^\d{3,}$/.test(item.relative))
  const unknownBranches = branches.filter((item) => item.relative !== "integration" && !/^\d{3,}$/.test(item.relative))
  const unindexedBranches = planBranches.filter((item) => !planIds.has(item.relative))
  const recognizedCoordinationRefs = coordinationRecords.filter((item) => item.identity)
  const unknownCoordinationRefs = coordinationRecords.filter((item) => !item.identity)
  const unindexedCoordinationRefs = recognizedCoordinationRefs.filter((item) => {
    return item.identity?.plan ? !planIds.has(item.identity.plan) : false
  })
  const invalidCompletionRefs = recognizedCoordinationRefs
    .filter((item) => item.identity?.kind === "completed")
    .map((item) => ({ item, proof: inspectCompletionProof(repoRoot, item.ref) }))
    .filter(({ item, proof }) => !proof.ok || proof.payload.planId !== item.identity?.plan)
  const worktrees = listWorktreeInventory(repoRoot).filter((item) => item.path)
  const rawCoordinationRef = ({ ref, target, relative }: RefRecord) => ({ ref, target, relative })
  const namespaceBranchNames = new Set(branches.map((item) => item.branch))
  const namespaceWorktrees = worktrees.filter((item) => namespaceBranchNames.has(item.branch))

  let ok = true
  let reason: string | null = null
  const conflicts: NamespaceConflict[] = []
  if (input.mode === "fire") {
    conflicts.push(...parentConflicts.map((ref) => ({ type: "parent-ref", ref })))
    conflicts.push(...branches.map((item) => ({ type: "branch", branch: item.branch, head: item.head })))
    conflicts.push(...coordinationRecords.map((item) => ({ type: "coordination-ref", ref: item.ref, target: item.target })))
    if (conflicts.length > 0) {
      ok = false
      reason = "namespace-conflict"
    }
  } else if (input.mode === "resume") {
    if (!integration || !baseRef) {
      ok = false
      reason = !integration ? "integration-branch-missing" : "base-ref-missing"
    }
    conflicts.push(...parentConflicts.map((ref) => ({ type: "parent-ref", ref })))
    conflicts.push(...unknownBranches.map((item) => ({ type: "unknown-branch", branch: item.branch, head: item.head })))
    conflicts.push(...unindexedBranches.map((item) => ({ type: "unindexed-plan", branch: item.branch, plan: item.relative, head: item.head })))
    conflicts.push(...unknownCoordinationRefs.map((item) => ({ type: "unknown-coordination-ref", ref: item.ref, target: item.target })))
    conflicts.push(...unindexedCoordinationRefs.map((item) => ({ type: "unindexed-coordination-ref", ref: item.ref, target: item.target })))
    conflicts.push(...invalidCompletionRefs.map(({ item, proof }) => ({
      type: "invalid-completion-proof",
      ref: item.ref,
      target: item.target,
      detail: proof.ok === false ? proof.error : "plan identity mismatch",
    })))
    if (integration && baseRef && !isAncestor(repoRoot, baseRef.target, integration.head)) {
      conflicts.push({ type: "base-not-reachable", ref: baseRef.ref, target: baseRef.target, integrationHead: integration.head })
    }
    if (integration) {
      for (const item of recognizedCoordinationRefs.filter((ref) => ref.identity?.kind === "completed")) {
        const proof = inspectCompletionProof(repoRoot, item.ref)
        if (proof.ok && !isAncestor(repoRoot, proof.object, integration.head)) {
          conflicts.push({ type: "completion-not-reachable", ref: item.ref, target: proof.object, integrationHead: integration.head })
        }
      }
    }
    if (conflicts.length > 0) {
      ok = false
      reason = "namespace-ambiguous"
    }
  }

  return {
    ok,
    mode: input.mode,
    reason,
    repoRoot,
    planDir,
    planName,
    namespace,
    integrationBranch,
    integration,
    baseRef: baseRef ? (({ ref, target, relative }) => ({ ref, target, relative }))(baseRef) : null,
    planBranches,
    unknownBranches,
    unindexedBranches,
    coordinationRefs: coordinationRecords.map(({ ref, target, relative }) => ({ ref, target, relative })),
    unknownCoordinationRefs: unknownCoordinationRefs.map(rawCoordinationRef),
    unindexedCoordinationRefs: unindexedCoordinationRefs.map(rawCoordinationRef),
    invalidCompletionRefs: invalidCompletionRefs.map(({ item, proof }) => ({ ref: item.ref, target: item.target, proof })),
    worktrees: namespaceWorktrees,
    conflicts,
  }
}
