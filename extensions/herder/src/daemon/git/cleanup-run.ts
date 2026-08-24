#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { buildGraph } from "../../core/plans.ts"
import { readPlanLifecycle, type PlanLifecycleStatus } from "../../core/workflow.ts"
import { RunStore } from "../run-store.ts"
import { listCoordinationRefs, type CoordinationRefRecord, validatePlanName } from "./coordination-ref.ts"
import type { CoordinationRef } from "./coordination-ref.ts"
import { inspectCompletionProof } from "./completion-proof.ts"
import { listHerderBranches, listWorktrees, type BranchRecord, type WorktreeRecord } from "./namespace-inventory.ts"
import { isTerminalRunStatus } from "../../shared/protocol.ts"
import { fail, isInside, realpathIfPresent, runGit, takeValue } from "./primitives.ts"

export interface CleanupInput {
  repo: string
  planDir: string
  planName?: string | null
  plan?: string | null
  dryRun: boolean
  includeFailed: boolean
  deep: boolean
  force?: boolean
  expectedPlanStatuses?: Record<string, "DONE" | "BLOCKED" | "REJECTED">
  /** Deterministic race injection for integration tests. Not populated by CLI callers. */
  testHooks?: {
    beforeMutation?: () => void
    beforeIntegrationDeletion?: () => void
  }
  pretty?: boolean
}

export interface CleanupDetail {
  [key: string]: any
}

export interface CleanupResult {
  repoRoot: string
  planDir: string
  planName: string
  integrationBranch: string
  integrationHead: string
  plan: string | null
  dryRun: boolean
  includeFailed: boolean
  deep: boolean
  force: boolean
  actions: CleanupDetail[]
  removed: CleanupDetail[]
  skipped: CleanupDetail[]
  destruction: {
    requested: boolean
    eligible: boolean
    blockers: CleanupDetail[]
    refsPlanned: Array<{ ref: string; target: string; kind: CoordinationRef["kind"]; plan?: string }>
    refsRemoved: Array<{ ref: string; target: string; kind: CoordinationRef["kind"]; plan?: string }>
    integrationWorktree: string | null
    integrationRemoved: boolean
    planDirectoryRemoved: boolean
  }
  preserved: {
    integrationBranch: string | null
    integrationWorktree: string | null
    coordinationRefs: string | null
    planDirectory: boolean
  }
}
type CompletionRefRecord = {
  ref: string
  target: string
  plan: string | null
  proof: ReturnType<typeof inspectCompletionProof>
}

function parseArguments(argv: string[]): CleanupInput {
  const options: Partial<CleanupInput> & Pick<CleanupInput, "dryRun" | "includeFailed" | "deep" | "pretty"> = {
    planName: null,
    plan: null,
    dryRun: false,
    includeFailed: false,
    deep: false,
    pretty: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (["--dry-run", "--include-failed", "--deep", "--pretty"].includes(argument)) {
      if (argument === "--dry-run") options.dryRun = true
      else if (argument === "--include-failed") options.includeFailed = true
      else if (argument === "--deep") options.deep = true
      else options.pretty = true
      continue
    }
    if (argument === "--finalize" || argument === "--handoff-target") {
      fail(`${argument} was removed; use --deep for destructive plan-set cleanup`)
    }
    if (["--repo", "--plan-dir", "--plan-name", "--plan"].includes(argument)) {
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === "--repo") options.repo = value
      else if (argument === "--plan-dir") options.planDir = value
      else if (argument === "--plan-name") options.planName = value
      else options.plan = value
      continue
    }
    fail(`Unknown argument: ${argument}`)
  }
  for (const [name, value] of [
    ["--repo", options.repo],
    ["--plan-dir", options.planDir],
  ]) {
    if (!value) fail(`${name} is required`)
  }
  if (options.deep && options.plan) fail("--deep is plan-set-level and cannot be combined with --plan")
  return options as CleanupInput
}

function refTarget(repoRoot: string, ref: string): string | null {
  const result = runGit(repoRoot, ["rev-parse", "--verify", ref], { allowFailure: true })
  return result.status === 0 ? result.stdout.trim() : null
}

function assertNotUserCheckout(repoRoot: string, worktreePath: string): void {
  if (realpathIfPresent(worktreePath) === repoRoot) {
    fail(`Refusing to remove the user checkout: ${repoRoot}`)
  }
}

function removeOwnedWorktree(repoRoot: string, worktreePath: string): void {
  assertNotUserCheckout(repoRoot, worktreePath)
  runGit(repoRoot, ["worktree", "remove", "--", worktreePath])
}

function deleteBranchIfPresent(repoRoot: string, branch: string, expectedHead: string): void {
  const ref = `refs/heads/${branch}`
  const current = refTarget(repoRoot, ref)
  if (current === null) return
  if (current !== expectedHead) fail(`Cannot delete moved branch ${branch}: expected ${expectedHead}, found ${current}`)
  runGit(repoRoot, ["update-ref", "-d", ref, expectedHead])
}

function canonicalPlanId(value: unknown): string {
  if (!/^\d+$/.test(String(value))) fail(`Invalid plan ID: ${JSON.stringify(value)}`)
  const number = Number.parseInt(String(value), 10)
  if (!Number.isSafeInteger(number)) fail(`Invalid plan ID: ${JSON.stringify(value)}`)
  return String(number).padStart(3, "0")
}

function planBranchSnapshot(items: BranchRecord[]): string {
  return JSON.stringify(items.map((item) => `${item.branch}\t${item.head}`).sort())
}

function coordinationRefSnapshot(items: CoordinationRefRecord[]): string {
  return JSON.stringify(items.map((item) => `${item.ref}\t${item.target}`).sort())
}

function worktreeSnapshot(items: WorktreeRecord[], namespace: string, includeIntegration: boolean): string {
  return JSON.stringify(items
    .filter((item) => item.branch.startsWith(`${namespace}/`) && (includeIntegration || item.branch !== `${namespace}/integration`))
    .map((item) => `${item.branch}\t${item.path}\t${item.locked}`)
    .sort())
}

function currentCheckout(repoRoot: string): { branch: string | null; head: string | null } {
  const branch = runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })
  const head = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true })
  return {
    branch: branch.status === 0 ? branch.stdout.trim() : null,
    head: head.status === 0 ? head.stdout.trim() : null,
  }
}

function planBranchIdentity(relative: string): { plan: string; kind: "plan" } | null {
  const match = relative.match(/^(\d{3,})$/)
  if (!match) return null
  return { plan: match[1]!, kind: "plan" }
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  const result = runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true })
  if (result.status === 0) return true
  if (result.status === 1) return false
  fail(`Cannot compare ${ancestor} with ${descendant}: ${(result.stderr || result.stdout).trim()}`)
}

function isPatchEquivalent(repoRoot: string, artifactHead: string, integrationHead: string): boolean {
  const mergeBaseResult = runGit(repoRoot, ["merge-base", artifactHead, integrationHead], { allowFailure: true })
  if (mergeBaseResult.status === 1) return false
  if (mergeBaseResult.status !== 0) {
    fail(`Cannot find a merge base for ${artifactHead} and ${integrationHead}: ${(mergeBaseResult.stderr || mergeBaseResult.stdout).trim()}`)
  }
  const mergeBase = mergeBaseResult.stdout.trim()
  const mergeCommits = runGit(repoRoot, ["rev-list", "--min-parents=2", `${mergeBase}..${artifactHead}`]).stdout.trim()
  if (mergeCommits) return false

  const rows = runGit(repoRoot, ["cherry", integrationHead, artifactHead]).stdout.split(/\r?\n/).filter(Boolean)
  return rows.length > 0 && rows.every((row) => /^- [0-9a-f]+$/.test(row))
}

function readCleanupRunStatus(planDir: string): { present: boolean; status: string | null; terminal: boolean } {
  let store: RunStore | undefined
  try {
    store = new RunStore(planDir, { readOnly: true })
    const run = store.getRun()
    if (!run) return { present: false, status: null, terminal: false }
    return {
      present: true,
      status: run.status,
      terminal: isTerminalRunStatus(run.status),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/not initialized/.test(message)) return { present: false, status: null, terminal: false }
    throw error
  } finally {
    store?.close()
  }
}

function completionProofs(repoRoot: string, integrationHead: string, completionRefs: CompletionRefRecord[]): Set<string> {
  const completedPlans = new Set<string>()
  for (const item of completionRefs) {
    if (!item.plan) continue
    if (item.proof.ok && item.proof.payload.planId === item.plan && isAncestor(repoRoot, item.proof.object, integrationHead)) completedPlans.add(item.plan)
  }
  return completedPlans
}

function worktreeStatus(repoRoot: string, worktree?: WorktreeRecord) {
  if (!worktree) return { clean: true, locked: false, path: null }
  if (worktree.locked) return { clean: false, locked: true, path: worktree.path }
  if (!fs.existsSync(worktree.path)) return { clean: false, locked: false, path: worktree.path, missing: true }
  const result = runGit(repoRoot, ["-C", worktree.path, "status", "--porcelain=v1", "--untracked-files=all"])
  return { clean: result.stdout === "", locked: false, path: worktree.path }
}

export function cleanupRun(input: CleanupInput) {
  if (input.force) fail("Use forceCleanupRun for unconditional --force cleanup")
  const repoCandidate = path.resolve(input.repo)
  if (!fs.existsSync(repoCandidate) || !fs.statSync(repoCandidate).isDirectory()) fail(`Repository does not exist: ${repoCandidate}`)
  const repoRoot = fs.realpathSync(repoCandidate)
  const actualRoot = fs.realpathSync(runGit(repoRoot, ["rev-parse", "--show-toplevel"]).stdout.trim())
  if (actualRoot !== repoRoot) fail(`--repo must be the Git repository root: ${actualRoot}`)

  const planCandidate = path.resolve(repoRoot, input.planDir)
  if (!fs.existsSync(planCandidate) || !fs.statSync(planCandidate).isDirectory()) fail(`Plan directory does not exist: ${planCandidate}`)
  if (fs.lstatSync(planCandidate).isSymbolicLink()) fail(`Plan directory must not be a symlink: ${planCandidate}`)
  const planDir = fs.realpathSync(planCandidate)
  if (planDir === repoRoot) fail(`Refusing to remove the repository root: ${repoRoot}`)
  if (!isInside(repoRoot, planDir)) fail(`Plan directory must be inside the repository: ${planDir}`)

  const planName = validatePlanName(input.planName ?? path.basename(planCandidate))
  const integrationBranch = `herder/${planName}/integration`
  runGit(repoRoot, ["check-ref-format", "--branch", integrationBranch])
  const integrationRef = `refs/heads/${integrationBranch}`
  const integrationRefResult = runGit(repoRoot, ["show-ref", "--verify", integrationRef], { allowFailure: true })
  if (integrationRefResult.status !== 0) fail(`Integration branch does not exist: ${integrationBranch}`)
  const integrationHead = runGit(repoRoot, ["rev-parse", integrationRef]).stdout.trim()
  const graph = buildGraph(planDir)
  const planFilter = input.plan ? canonicalPlanId(input.plan) : null
  if (input.deep && planFilter) fail("--deep is plan-set-level and cannot be combined with --plan")
  if (planFilter && !graph.plans.some((plan) => plan.id === planFilter)) fail(`Plan ${planFilter} is not indexed in ${graph.readme}`)
  const overlayStatus = (planId: string, fallback: string, lifecycle: Map<string, PlanLifecycleStatus>): PlanLifecycleStatus | string =>
    lifecycle.get(planId) ?? fallback
  const statusSnapshot = (value: typeof graph, lifecycle: Map<string, PlanLifecycleStatus>): string =>
    JSON.stringify(value.plans.map((plan) => ({ id: plan.id, status: overlayStatus(plan.id, plan.status, lifecycle) })))
  const plannedLifecycle = readPlanLifecycle(planDir, graph)
  const plannedStatusSnapshot = statusSnapshot(graph, plannedLifecycle)
  const plannedRun = readCleanupRunStatus(planDir)
  const assertPlanStatusesUnchanged = (): void => {
    const current = buildGraph(planDir)
    const currentLifecycle = readPlanLifecycle(planDir, current)
    if (statusSnapshot(current, currentLifecycle) !== plannedStatusSnapshot) {
      fail("Cannot clean up because plan status changed after preflight")
    }
    for (const [rawPlanId, expectedStatus] of Object.entries(input.expectedPlanStatuses ?? {})) {
      const planId = canonicalPlanId(rawPlanId)
      const currentStatus = overlayStatus(planId, current.plans.find((plan) => plan.id === planId)?.status ?? "missing", currentLifecycle)
      if (currentStatus !== expectedStatus) {
        fail(`Cannot clean up plan ${planId}: expected status ${expectedStatus}, found ${currentStatus}`)
      }
    }
  }
  const assertRunStatusUnchanged = (): void => {
    const current = readCleanupRunStatus(planDir)
    if (current.present !== plannedRun.present || current.status !== plannedRun.status) {
      fail("Cannot clean up because run status changed after preflight")
    }
  }
  const assertMutationAllowed = (): void => {
    const current = readCleanupRunStatus(planDir)
    if (current.present && !current.terminal) {
      fail(`Cannot clean up while run status is ${current.status}: run-not-terminal`)
    }
    assertRunStatusUnchanged()
  }
  assertPlanStatusesUnchanged()
  assertRunStatusUnchanged()

  const planStatus = (plan: { id: string; status: string }): string => overlayStatus(plan.id, plan.status, plannedLifecycle)
  const plans = new Map(graph.plans.map((plan) => [plan.id, plan]))
  const coordinationRefs = listCoordinationRefs(repoRoot, planName)
  const completionRefs: CompletionRefRecord[] = coordinationRefs
    .filter((item) => item.identity?.kind === "completed")
    .map((item) => ({
      ref: item.ref,
      target: item.target,
      plan: item.identity!.plan,
      proof: inspectCompletionProof(repoRoot, item.ref),
    }))

  const completionProofsForRun = integrationHead ? completionProofs(repoRoot, integrationHead, completionRefs) : new Set<string>()
  const allPlanBranches = listHerderBranches(repoRoot, planName)
  const expectedPlanBranchSnapshot = planBranchSnapshot(allPlanBranches)
  const expectedCoordinationRefSnapshot = coordinationRefSnapshot(coordinationRefs)
  const expectedCheckout = currentCheckout(repoRoot)
  const initialWorktrees = listWorktrees(repoRoot).filter((item) => item.path)
  const expectedWorktreeSnapshot = worktreeSnapshot(initialWorktrees, `herder/${planName}`, false)
  const expectedIntegrationWorktreeSnapshot = worktreeSnapshot(initialWorktrees, `herder/${planName}`, true)
  const worktrees = new Map(initialWorktrees.filter((item) => item.path && item.branch).map((item) => [item.branch, item]))
  const actions: CleanupDetail[] = []
  const skipped: CleanupDetail[] = []
  const planBranches = allPlanBranches.filter((item) => item.relative !== "integration")

  for (const item of planBranches) {
    const identity = planBranchIdentity(item.relative)
    if (!identity) {
      skipped.push({ branch: item.branch, reason: "unrecognized-plan-branch" })
      continue
    }
    if (planFilter && identity.plan !== planFilter) continue
    const plan = plans.get(identity.plan)
    if (!plan) {
      skipped.push({ branch: item.branch, plan: identity.plan, reason: "plan-not-indexed" })
      continue
    }

    let mode: "completed-plan" | "failed-evidence"
    let proof: "ancestor" | "patch-equivalent" | "superseded-by-completion" | null = null
    const status = planStatus(plan)
    if (status === "DONE") {
      if (!completionProofsForRun.has(plan.id)) {
        skipped.push({ branch: item.branch, plan: plan.id, status, reason: "completion-proof-missing" })
        continue
      }
      if (isAncestor(repoRoot, item.head, integrationHead)) {
        proof = "ancestor"
      } else if (isPatchEquivalent(repoRoot, item.head, integrationHead)) {
        proof = "patch-equivalent"
      } else {
        proof = "superseded-by-completion"
      }
      mode = "completed-plan"
    } else if ((status === "BLOCKED" || status === "REJECTED") && (input.deep || input.includeFailed)) {
      mode = "failed-evidence"
    } else {
      skipped.push({ branch: item.branch, plan: plan.id, status, reason: "preserved-non-done-evidence" })
      continue
    }

    const candidateWorktree = worktrees.get(item.branch)
    if (candidateWorktree) assertNotUserCheckout(repoRoot, candidateWorktree.path)
    const state = worktreeStatus(repoRoot, candidateWorktree)
    if (state.locked) {
      skipped.push({ branch: item.branch, plan: plan.id, status, worktree: state.path, reason: "worktree-locked" })
      continue
    }
    if (state.missing) {
      skipped.push({ branch: item.branch, plan: plan.id, status, worktree: state.path, reason: "worktree-missing" })
      continue
    }
    if (!state.clean) {
      skipped.push({ branch: item.branch, plan: plan.id, status, worktree: state.path, reason: "worktree-dirty" })
      continue
    }
    actions.push({
      branch: item.branch,
      head: item.head,
      plan: plan.id,
      status,
      kind: identity.kind,
      mode,
      proof,
      worktree: state.path,
      operations: [...(state.path ? ["remove-worktree"] : []), mode === "completed-plan" ? "delete-completed-plan-branch" : "delete-failed-evidence-branch"],
    })
  }

  const integrationWorktree = worktrees.get(integrationBranch)
  const destruction: {
    requested: boolean
    eligible: boolean
    blockers: CleanupDetail[]
    refsPlanned: Array<{ ref: string; target: string; kind: CoordinationRef["kind"]; plan?: string }>
    refsRemoved: Array<{ ref: string; target: string; kind: CoordinationRef["kind"]; plan?: string }>
    integrationWorktree: string | null
    integrationRemoved: boolean
    planDirectoryRemoved: boolean
  } = {
    requested: Boolean(input.deep), eligible: false, blockers: [], refsPlanned: [], refsRemoved: [],
    integrationWorktree: integrationWorktree?.path ?? null, integrationRemoved: false, planDirectoryRemoved: false,
  }
  if (input.deep) {
    const terminal = new Set(["DONE", "BLOCKED", "REJECTED"])
    if (!graph.plans.every((plan) => terminal.has(planStatus(plan)))) {
      for (const plan of graph.plans.filter((item) => !terminal.has(planStatus(item)))) {
        destruction.blockers.push({ reason: "plan-not-terminal", plan: plan.id, status: planStatus(plan) })
      }
    }
    if (!integrationHead) destruction.blockers.push({ reason: "integration-branch-missing", branch: integrationBranch })
    const currentHeadResult = runGit(repoRoot, ["rev-parse", "HEAD"], { allowFailure: true })
    const currentBranchResult = runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })
    if (currentBranchResult.status !== 0) destruction.blockers.push({ reason: "detached-head" })
    else if (currentHeadResult.status !== 0) destruction.blockers.push({ reason: "current-head-missing" })
    else if (integrationHead && !isAncestor(repoRoot, integrationHead, currentHeadResult.stdout.trim())) {
      destruction.blockers.push({ reason: "integration-not-ancestor-of-current", integrationHead, currentHead: currentHeadResult.stdout.trim() })
    }
    if (!integrationWorktree) destruction.blockers.push({ reason: "integration-worktree-missing" })
    else {
      const integrationPath = realpathIfPresent(integrationWorktree.path)
      if (integrationPath === repoRoot) destruction.blockers.push({ reason: "integration-is-user-checkout", worktree: integrationWorktree.path })
      else {
        const state = worktreeStatus(repoRoot, integrationWorktree)
        if (state.locked) destruction.blockers.push({ reason: "integration-worktree-locked", worktree: state.path })
        else if (state.missing) destruction.blockers.push({ reason: "integration-worktree-missing", worktree: state.path })
        else if (!state.clean) destruction.blockers.push({ reason: "integration-worktree-dirty", worktree: state.path })
      }
    }
    const removableBranches = new Set(actions.map((action) => action.branch))
    for (const item of planBranches) {
      if (!removableBranches.has(item.branch)) {
        const skip = skipped.find((candidate) => candidate.branch === item.branch)
        destruction.blockers.push({ reason: "plan-branch-would-remain", branch: item.branch, detail: skip?.reason ?? "not-eligible" })
      }
    }
    for (const item of coordinationRefs) {
      if (!item.identity) {
        destruction.blockers.push({ reason: "unrecognized-coordination-ref", ref: item.ref })
        continue
      }
      // Every plan-owned coordination ref must be tied to an indexed plan.
      if (item.identity.plan && !plans.has(item.identity.plan)) {
        destruction.blockers.push({ reason: "coordination-ref-plan-not-indexed", ref: item.ref, plan: item.identity.plan })
        continue
      }
      if (item.identity.kind === "base") {
        if (!isAncestor(repoRoot, item.target, integrationHead)) {
          destruction.blockers.push({ reason: "base-ref-not-reachable", ref: item.ref, target: item.target })
          continue
        }
      } else if (item.identity.kind === "completed") {
        const plan = item.identity.plan ? plans.get(item.identity.plan) : undefined
        if (!plan || planStatus(plan) !== "DONE") {
          destruction.blockers.push({ reason: "completion-ref-plan-not-done", ref: item.ref, plan: item.identity.plan ?? "" })
          continue
        }
        const proof = inspectCompletionProof(repoRoot, item.ref)
        if (!proof.ok || proof.payload.planId !== item.identity.plan) {
          destruction.blockers.push({
            reason: "completion-approval-proof-invalid",
            ref: item.ref,
            detail: proof.ok === false ? proof.error : "plan identity mismatch",
          })
          continue
        }
        if (!isAncestor(repoRoot, proof.object, integrationHead)) {
          destruction.blockers.push({ reason: "completion-ref-not-reachable", ref: item.ref, target: proof.object })
          continue
        }
      }
      destruction.refsPlanned.push({ ref: item.ref, target: item.target, kind: item.identity.kind, ...(item.identity.plan ? { plan: item.identity.plan } : {}) })
    }
    if (!coordinationRefs.some((item) => item.identity?.kind === "base")) {
      destruction.blockers.push({ reason: "base-ref-missing", ref: `refs/plan-herder/${planName}/base` })
    }
    if (graph.plans.some((plan) => planStatus(plan) === "DONE" && !completionProofsForRun.has(plan.id))) {
      for (const plan of graph.plans.filter((item) => planStatus(item) === "DONE" && !completionProofsForRun.has(item.id))) {
        destruction.blockers.push({ reason: "completion-proof-missing", plan: plan.id })
      }
    }
    if (plannedRun.present && !plannedRun.terminal) {
      destruction.blockers.push({ reason: "run-not-terminal", status: plannedRun.status })
    }
    destruction.eligible = destruction.blockers.length === 0
  }

  const removed: CleanupDetail[] = []
  if (!input.dryRun) {
    assertPlanStatusesUnchanged()
    assertMutationAllowed()
    if (input.deep) {
      if (!destruction.eligible) fail(`Deep cleanup preflight failed: ${destruction.blockers.map((item) => item.reason).join(", ")}`)
      // All deterministic race hooks run before the first mutation. External Git
      // changes after this final preflight cannot be made transactionally atomic.
      input.testHooks?.beforeMutation?.()
      input.testHooks?.beforeIntegrationDeletion?.()
      assertPlanStatusesUnchanged()
      assertMutationAllowed()
      if (planBranchSnapshot(listHerderBranches(repoRoot, planName)) !== expectedPlanBranchSnapshot) {
        fail("Deep cleanup plan branch namespace changed after preflight")
      }
      const currentWorktrees = listWorktrees(repoRoot).filter((item) => item.path)
      if (worktreeSnapshot(currentWorktrees, `herder/${planName}`, false) !== expectedWorktreeSnapshot) {
        fail("Deep cleanup plan worktree namespace changed after preflight")
      }
      if (worktreeSnapshot(currentWorktrees, `herder/${planName}`, true) !== expectedIntegrationWorktreeSnapshot) {
        fail("Deep cleanup worktree namespace changed after preflight")
      }
      if (coordinationRefSnapshot(listCoordinationRefs(repoRoot, planName)) !== expectedCoordinationRefSnapshot) {
        fail("Deep cleanup coordination refs changed after preflight")
      }
      const checkout = currentCheckout(repoRoot)
      if (checkout.branch !== expectedCheckout.branch || checkout.head !== expectedCheckout.head) {
        fail("Deep cleanup current branch or HEAD changed after preflight")
      }
      const currentIntegrationHead = refTarget(repoRoot, integrationRef)
      if (!currentIntegrationHead) fail(`Integration branch does not exist: ${integrationBranch}`)
      if (currentIntegrationHead !== integrationHead) {
        fail(`Cannot delete moved branch ${integrationBranch}: expected ${integrationHead}, found ${currentIntegrationHead}`)
      }
      if (!checkout.branch || !checkout.head || !isAncestor(repoRoot, integrationHead, checkout.head)) {
        fail(`Cannot remove integration because ${checkout.branch ?? "current branch"} no longer contains ${integrationHead}`)
      }
      // Revalidate every worktree, graph, proof, and reachability precondition after
      // deterministic race injection and immediately before the first mutation.
      const fresh = cleanupRun({ ...input, dryRun: true, testHooks: undefined })
      if (!fresh.destruction.eligible) fail(`Deep cleanup preflight changed: ${fresh.destruction.blockers.map((item) => item.reason).join(", ")}`)
    }
    for (const action of actions) {
      assertPlanStatusesUnchanged()
      assertMutationAllowed()
      if (action.worktree) removeOwnedWorktree(repoRoot, action.worktree)
      deleteBranchIfPresent(repoRoot, action.branch, action.head)
      removed.push(action)
    }
    if (input.deep) {
      const remainingBranches = listHerderBranches(repoRoot, planName).filter((item) => item.relative !== "integration")
      const remainingWorktrees = listWorktrees(repoRoot).filter((item) => item.path && item.branch.startsWith(`herder/${planName}/`) && item.branch !== integrationBranch)
      if (remainingBranches.length > 0 || remainingWorktrees.length > 0) {
        fail(`Cannot deep-clean while plan namespace artifacts remain: ${[
          ...remainingBranches.map((item) => item.branch),
          ...remainingWorktrees.map((item) => item.path),
        ].join(", ")}`)
      }
      const currentRefs = listCoordinationRefs(repoRoot, planName)
      if (coordinationRefSnapshot(currentRefs) !== expectedCoordinationRefSnapshot) {
        fail("Deep cleanup coordination refs changed after preflight")
      }
      for (const item of destruction.refsPlanned) {
        runGit(repoRoot, ["update-ref", "-d", item.ref, item.target])
        destruction.refsRemoved.push(item)
      }
      const remainingCoordinationRefs = listCoordinationRefs(repoRoot, planName)
      if (remainingCoordinationRefs.length > 0) {
        fail(`Cannot deep-clean while coordination refs remain: ${remainingCoordinationRefs.map((item) => item.ref).join(", ")}`)
      }
      const checkout = currentCheckout(repoRoot)
      const checkoutHead = checkout.head
      if (!checkout.branch || !checkoutHead || checkout.branch !== expectedCheckout.branch || checkoutHead !== expectedCheckout.head) {
        fail("Cannot remove integration because the current branch or HEAD changed after preflight")
      }
      const currentIntegrationHead = refTarget(repoRoot, integrationRef)
      if (!currentIntegrationHead) fail(`Integration branch does not exist: ${integrationBranch}`)
      if (currentIntegrationHead !== integrationHead) {
        fail(`Cannot delete moved branch ${integrationBranch}: expected ${integrationHead}, found ${currentIntegrationHead}`)
      }
      if (!isAncestor(repoRoot, integrationHead, checkoutHead)) {
        fail(`Cannot remove integration because ${checkout.branch} no longer contains ${integrationHead}`)
      }
      if (integrationWorktree) {
        assertNotUserCheckout(repoRoot, integrationWorktree.path)
        removeOwnedWorktree(repoRoot, integrationWorktree.path)
      }
      deleteBranchIfPresent(repoRoot, integrationBranch, integrationHead)
      destruction.integrationRemoved = true
      const deletionTarget = realpathIfPresent(planDir)
      if (fs.lstatSync(planDir).isSymbolicLink() || deletionTarget !== planDir || deletionTarget === repoRoot || !isInside(repoRoot, deletionTarget)) {
        fail(`Refusing to remove changed or unsafe plan directory: ${planDir}`)
      }
      if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) {
        fail(`Refusing to remove changed or missing plan directory: ${planDir}`)
      }
      fs.rmSync(planDir, { recursive: true, force: true })
      destruction.planDirectoryRemoved = true
    }
  }

  return {
    repoRoot,
    planDir,
    planName,
    integrationBranch,
    integrationHead,
    plan: planFilter,
    dryRun: Boolean(input.dryRun),
    includeFailed: Boolean(input.includeFailed),
    deep: Boolean(input.deep),
    force: false,
    actions,
    removed,
    skipped,
    destruction,
    preserved: {
      integrationBranch: destruction.integrationRemoved ? null : integrationBranch,
      integrationWorktree: destruction.integrationRemoved ? null : integrationWorktree?.path ?? null,
      coordinationRefs: destruction.requested && destruction.eligible && !input.dryRun ? null : `refs/plan-herder/${planName}/`,
      planDirectory: !destruction.planDirectoryRemoved,
    },
  }
}

function main(argv: string[]): void {
  const options = parseArguments(argv)
  const result = cleanupRun(options)
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`herder-cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
