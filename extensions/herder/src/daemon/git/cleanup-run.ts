#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import type { SpawnSyncReturns } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildGraph } from "../../core/plans.ts"
import { parseCoordinationRefRelative } from "./coordination-ref.ts"
import type { CoordinationRef } from "./coordination-ref.ts"
import { inspectCompletionProof } from "./completion-proof.ts"

export interface CleanupInput {
  repo: string
  planDir: string
  planName?: string | null
  plan?: string | null
  dryRun: boolean
  includeFailed: boolean
  finalize: boolean
  handoffTarget?: string | null
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
  finalize: boolean
  handoffTarget: string | null
  actions: CleanupDetail[]
  removed: CleanupDetail[]
  skipped: CleanupDetail[]
  finalization: {
    requested: boolean
    eligible: boolean
    blockers: CleanupDetail[]
    refsPlanned: Array<{ ref: string; target: string; kind: CoordinationRef["kind"]; plan?: string }>
    refsRemoved: Array<{ ref: string; target: string; kind: CoordinationRef["kind"]; plan?: string }>
  }
  handoff: {
    requested: boolean
    targetBranch: string | null
    targetHead: string | null
    eligible: boolean
    blockers: CleanupDetail[]
    integrationWorktree: string | null
    removed: boolean
  }
  preserved: {
    integrationBranch: string | null
    integrationWorktree: string | null
    coordinationRefs: string | null
    logs: boolean
  }
}
interface WorktreeRecord { path: string; branch: string; locked: boolean }
interface BranchRecord { branch: string; head: string; relative: string }
interface CoordinationRefRecord {
  ref: string
  target: string
  relative: string
  kind: CoordinationRef["kind"] | null
  plan: string | null
}
type CompletionRefRecord = ReturnType<typeof listCompletionRefs>[number]

function fail(message: string): never {
  throw new Error(message)
}

function runGit(repoRoot: string, args: string[], { allowFailure = false }: { allowFailure?: boolean } = {}): SpawnSyncReturns<string> {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) fail(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

function takeValue(args: string[], index: number, name: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) fail(`${name} requires a value`)
  return value
}

function parseArguments(argv: string[]): CleanupInput {
  const options: Partial<CleanupInput> & Pick<CleanupInput, "dryRun" | "includeFailed" | "finalize" | "pretty"> = {
    planName: null,
    plan: null,
    dryRun: false,
    includeFailed: false,
    finalize: false,
    handoffTarget: null,
    pretty: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (["--dry-run", "--include-failed", "--finalize", "--pretty"].includes(argument)) {
      if (argument === "--dry-run") options.dryRun = true
      else if (argument === "--include-failed") options.includeFailed = true
      else if (argument === "--finalize") options.finalize = true
      else options.pretty = true
      continue
    }
    if (["--repo", "--plan-dir", "--plan-name", "--plan", "--handoff-target"].includes(argument)) {
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === "--repo") options.repo = value
      else if (argument === "--plan-dir") options.planDir = value
      else if (argument === "--plan-name") options.planName = value
      else if (argument === "--plan") options.plan = value
      else options.handoffTarget = value
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
  if (options.finalize && options.plan) fail("--finalize cannot be combined with --plan")
  if (options.handoffTarget && !options.finalize) fail("--handoff-target requires --finalize")
  return options as CleanupInput
}

function refTarget(repoRoot: string, ref: string): string | null {
  const result = runGit(repoRoot, ["rev-parse", "--verify", ref], { allowFailure: true })
  return result.status === 0 ? result.stdout.trim() : null
}

function realpathIfPresent(candidate: string): string {
  try { return fs.realpathSync(candidate) }
  catch { return path.resolve(candidate) }
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

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function resolvePlanName(planDir: string, inputName: unknown): string {
  const name = String(inputName ?? path.basename(planDir))
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)
    || name.includes("..")
    || name.endsWith(".")
    || name.endsWith(".lock")) {
    fail(`Plan-set name must be a lowercase Git-safe basename: ${JSON.stringify(name)}`)
  }
  return name
}

export function parseWorktreeRecords(output: string, nulDelimited: boolean): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  const rawRecords = nulDelimited
    ? output.split("\0\0")
    : output.split(/(?:\r?\n){2,}/)
  for (const rawRecord of rawRecords.filter((record) => record.trim())) {
    const record = { path: "", branch: "", locked: false }
    const fields = nulDelimited ? rawRecord.split("\0") : rawRecord.split(/\r?\n/)
    for (const field of fields.filter(Boolean)) {
      if (field.startsWith("worktree ")) record.path = field.slice("worktree ".length)
      else if (field.startsWith("branch refs/heads/")) record.branch = field.slice("branch refs/heads/".length)
      else if (field === "locked" || field.startsWith("locked ")) record.locked = true
    }
    if (record.path) records.push(record)
  }
  return records
}

function parseWorktrees(repoRoot: string): WorktreeRecord[] {
  const nulResult = runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"], { allowFailure: true })
  if (nulResult.status === 0) return parseWorktreeRecords(nulResult.stdout, true)

  // Git 2.34 and older do not support `git worktree list -z`.
  const output = runGit(repoRoot, ["worktree", "list", "--porcelain"]).stdout
  return parseWorktreeRecords(output, false)
}

function listPlanBranches(repoRoot: string, planName: string): BranchRecord[] {
  const prefix = `herder/${planName}/`
  const output = runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:lstrip=2)%09%(objectname)",
    `refs/heads/${prefix}`,
  ]).stdout
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t")
    if (separator === -1) fail(`Cannot parse Git branch record: ${JSON.stringify(line)}`)
    const branch = line.slice(0, separator)
    return { branch, head: line.slice(separator + 1), relative: branch.slice(prefix.length) }
  })
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

function listCompletionRefs(repoRoot: string, planName: string) {
  const prefix = `refs/plan-herder/${planName}/completed/`
  const output = runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    prefix,
  ]).stdout
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t")
    if (separator === -1) fail(`Cannot parse completion ref record: ${JSON.stringify(line)}`)
    const ref = line.slice(0, separator)
    const target = line.slice(separator + 1)
    const relative = ref.slice(prefix.length)
    const plan = /^\d{3,}$/.test(relative) ? relative : null
    return { ref, target, relative, plan, proof: inspectCompletionProof(repoRoot, ref) }
  })
}

function listCoordinationRefs(repoRoot: string, planName: string): CoordinationRefRecord[] {
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
    const identity = parseCoordinationRefRelative(relative)
    return { ref, target, relative, kind: identity?.kind ?? null, plan: identity?.plan ?? null }
  })
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
  const repoCandidate = path.resolve(input.repo)
  if (!fs.existsSync(repoCandidate) || !fs.statSync(repoCandidate).isDirectory()) fail(`Repository does not exist: ${repoCandidate}`)
  const repoRoot = fs.realpathSync(repoCandidate)
  const actualRoot = fs.realpathSync(runGit(repoRoot, ["rev-parse", "--show-toplevel"]).stdout.trim())
  if (actualRoot !== repoRoot) fail(`--repo must be the Git repository root: ${actualRoot}`)

  const planCandidate = path.resolve(repoRoot, input.planDir)
  if (!fs.existsSync(planCandidate) || !fs.statSync(planCandidate).isDirectory()) fail(`Plan directory does not exist: ${planCandidate}`)
  const planDir = fs.realpathSync(planCandidate)
  if (!isInside(repoRoot, planDir)) fail(`Plan directory must be inside the repository: ${planDir}`)

  const planName = resolvePlanName(planCandidate, input.planName)
  const integrationBranch = `herder/${planName}/integration`
  runGit(repoRoot, ["check-ref-format", "--branch", integrationBranch])
  const integrationRef = `refs/heads/${integrationBranch}`
  runGit(repoRoot, ["show-ref", "--verify", integrationRef])
  const integrationHead = runGit(repoRoot, ["rev-parse", integrationRef]).stdout.trim()
  const graph = buildGraph(planDir)
  const planFilter = input.plan ? canonicalPlanId(input.plan) : null
  if (input.finalize && planFilter) fail("--finalize cannot be combined with --plan")
  if (planFilter && !graph.plans.some((plan) => plan.id === planFilter)) fail(`Plan ${planFilter} is not indexed in ${graph.readme}`)

  const plans = new Map(graph.plans.map((plan) => [plan.id, plan]))
  const coordinationRefs = listCoordinationRefs(repoRoot, planName)
  const completionRefs = listCompletionRefs(repoRoot, planName)
  const completionProofsForRun = completionProofs(repoRoot, integrationHead, completionRefs)
  const worktrees = new Map(parseWorktrees(repoRoot).filter((item) => item.branch).map((item) => [item.branch, item]))
  const actions: CleanupDetail[] = []
  const skipped: CleanupDetail[] = []
  const planBranches = listPlanBranches(repoRoot, planName).filter((item) => item.relative !== "integration")

  let handoffTarget: string | null = null
  let handoffTargetHead: string | null = null
  if (input.handoffTarget) {
    if (input.handoffTarget === integrationBranch) fail("--handoff-target must differ from the integration branch")
    runGit(repoRoot, ["check-ref-format", "--branch", input.handoffTarget])
    const handoffRef = `refs/heads/${input.handoffTarget}`
    runGit(repoRoot, ["show-ref", "--verify", handoffRef])
    handoffTarget = input.handoffTarget
    handoffTargetHead = runGit(repoRoot, ["rev-parse", handoffRef]).stdout.trim()
  }

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
    if (plan.status === "DONE") {
      if (!completionProofsForRun.has(plan.id)) {
        skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, reason: "completion-proof-missing" })
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
    } else if (input.includeFailed || (input.finalize && plan.status === "REJECTED")) {
      mode = "failed-evidence"
    } else {
      skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, reason: "preserved-non-done-evidence" })
      continue
    }

    const candidateWorktree = worktrees.get(item.branch)
    if (candidateWorktree) assertNotUserCheckout(repoRoot, candidateWorktree.path)
    const state = worktreeStatus(repoRoot, candidateWorktree)
    if (state.locked) {
      skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, worktree: state.path, reason: "worktree-locked" })
      continue
    }
    if (state.missing) {
      skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, worktree: state.path, reason: "worktree-missing" })
      continue
    }
    if (!state.clean) {
      skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, worktree: state.path, reason: "worktree-dirty" })
      continue
    }
    actions.push({
      branch: item.branch,
      head: item.head,
      plan: plan.id,
      status: plan.status,
      kind: identity.kind,
      mode,
      proof,
      worktree: state.path,
      operations: [...(state.path ? ["remove-worktree"] : []), mode === "completed-plan" ? "delete-completed-plan-branch" : "delete-failed-evidence-branch"],
    })
  }

  const finalization: {
    requested: boolean
    eligible: boolean
    blockers: CleanupDetail[]
    refsPlanned: Array<{ ref: string; target: string; kind: CoordinationRef["kind"]; plan?: string }>
    refsRemoved: Array<{ ref: string; target: string; kind: CoordinationRef["kind"]; plan?: string }>
  } = {
    requested: Boolean(input.finalize),
    eligible: false,
    blockers: [],
    refsPlanned: [],
    refsRemoved: [],
  }
  if (input.finalize) {
    const terminal = new Set(["DONE", "REJECTED"])
    const allPlansTerminal = graph.plans.every((plan) => terminal.has(plan.status))
    const alreadyFinalized = allPlansTerminal && planBranches.length === 0 && coordinationRefs.length === 0
    if (!alreadyFinalized && !coordinationRefs.some((item) => item.kind === "base")) {
      finalization.blockers.push({ reason: "base-ref-missing", ref: `refs/plan-herder/${planName}/base` })
    }
    for (const plan of graph.plans) {
      if (!terminal.has(plan.status)) {
        finalization.blockers.push({ reason: "plan-not-terminal", plan: plan.id, status: plan.status })
      } else if (!alreadyFinalized && plan.status === "DONE" && !completionProofsForRun.has(plan.id)) {
        finalization.blockers.push({ reason: "completion-proof-missing", plan: plan.id, status: plan.status })
      }
    }

    const removableBranches = new Set(actions.map((action) => action.branch))
    for (const item of planBranches) {
      if (!removableBranches.has(item.branch)) {
        const skip = skipped.find((candidate) => candidate.branch === item.branch)
        finalization.blockers.push({
          reason: "plan-branch-would-remain",
          branch: item.branch,
          detail: skip?.reason ?? "not-eligible",
        })
      }
    }

    for (const item of coordinationRefs) {
      if (!item.kind) {
        finalization.blockers.push({ reason: "unrecognized-coordination-ref", ref: item.ref })
        continue
      }
      if (item.kind === "base") {
        if (!isAncestor(repoRoot, item.target, integrationHead)) {
          finalization.blockers.push({ reason: "base-ref-not-reachable", ref: item.ref, target: item.target })
          continue
        }
      } else if (item.plan) {
        const plan = plans.get(item.plan)
        if (!plan) {
          finalization.blockers.push({ reason: "coordination-ref-plan-not-indexed", ref: item.ref, plan: item.plan })
          continue
        }
        if (item.kind === "completed") {
          if (plan.status !== "DONE") {
            finalization.blockers.push({ reason: "completion-ref-plan-not-done", ref: item.ref, plan: item.plan })
            continue
          }
          const proof = inspectCompletionProof(repoRoot, item.ref)
          if (!proof.ok || proof.payload.planId !== item.plan) {
            finalization.blockers.push({
              reason: "completion-approval-proof-invalid",
              ref: item.ref,
              detail: proof.ok === false ? proof.error : "plan identity mismatch",
            })
            continue
          }
          if (!isAncestor(repoRoot, proof.object, integrationHead)) {
            finalization.blockers.push({ reason: "completion-ref-not-reachable", ref: item.ref, target: proof.object })
            continue
          }
        }
      }
      finalization.refsPlanned.push({ ref: item.ref, target: item.target, kind: item.kind, ...(item.plan ? { plan: item.plan } : {}) })
    }
    finalization.eligible = finalization.blockers.length === 0
  }

  const integrationWorktree = worktrees.get(integrationBranch)
  const handoff: {
    requested: boolean
    targetBranch: string | null
    targetHead: string | null
    eligible: boolean
    blockers: CleanupDetail[]
    integrationWorktree: string | null
    removed: boolean
  } = {
    requested: Boolean(handoffTarget),
    targetBranch: handoffTarget,
    targetHead: handoffTargetHead,
    eligible: false,
    blockers: [],
    integrationWorktree: integrationWorktree?.path ?? null,
    removed: false,
  }
  if (handoffTarget) {
    if (!finalization.eligible) {
      handoff.blockers.push({ reason: "finalization-ineligible" })
    }
    if (!isAncestor(repoRoot, integrationHead, handoffTargetHead!)) {
      handoff.blockers.push({
        reason: "handoff-target-does-not-contain-integration",
        targetBranch: handoffTarget,
        targetHead: handoffTargetHead,
        integrationHead,
      })
    }
    if (integrationWorktree) {
      const integrationPath = fs.existsSync(integrationWorktree.path)
        ? fs.realpathSync(integrationWorktree.path)
        : integrationWorktree.path
      if (integrationPath === repoRoot) {
        handoff.blockers.push({ reason: "integration-is-user-checkout", worktree: integrationWorktree.path })
      } else {
        const state = worktreeStatus(repoRoot, integrationWorktree)
        if (state.locked) handoff.blockers.push({ reason: "integration-worktree-locked", worktree: state.path })
        else if (state.missing) handoff.blockers.push({ reason: "integration-worktree-missing", worktree: state.path })
        else if (!state.clean) handoff.blockers.push({ reason: "integration-worktree-dirty", worktree: state.path })
      }
    }
    handoff.eligible = handoff.blockers.length === 0
  }

  const removed: CleanupDetail[] = []
  if (!input.dryRun) {
    for (const action of actions) {
      if (action.worktree) removeOwnedWorktree(repoRoot, action.worktree)
      deleteBranchIfPresent(repoRoot, action.branch, action.head)
      removed.push(action)
    }
    if (finalization.eligible) {
      const remainingBranches = listPlanBranches(repoRoot, planName).filter((item) => item.relative !== "integration")
      if (remainingBranches.length > 0) {
        fail(`Cannot finalize while plan branches remain: ${remainingBranches.map((item) => item.branch).join(", ")}`)
      }
      const currentCoordinationRefs = listCoordinationRefs(repoRoot, planName)
      const expectedRefs = finalization.refsPlanned.map((item) => `${item.ref}\t${item.target}`).sort()
      const currentRefs = currentCoordinationRefs.map((item) => `${item.ref}\t${item.target}`).sort()
      if (JSON.stringify(currentRefs) !== JSON.stringify(expectedRefs)) {
        fail("Cannot finalize because coordination refs changed after preflight")
      }
      for (const item of finalization.refsPlanned) {
        runGit(repoRoot, ["update-ref", "-d", item.ref, item.target])
        finalization.refsRemoved.push(item)
      }
      const remainingCoordinationRefs = listCoordinationRefs(repoRoot, planName)
      if (remainingCoordinationRefs.length > 0) {
        fail(`Cannot finalize while coordination refs remain: ${remainingCoordinationRefs.map((item) => item.ref).join(", ")}`)
      }
    }
    if (handoff.eligible) {
      const currentTargetHead = runGit(repoRoot, ["rev-parse", `refs/heads/${handoffTarget}`]).stdout.trim()
      if (!isAncestor(repoRoot, integrationHead, currentTargetHead)) {
        fail(`Cannot remove integration because ${handoffTarget} no longer contains ${integrationHead}`)
      }
      if (integrationWorktree) {
        assertNotUserCheckout(repoRoot, integrationWorktree.path)
        removeOwnedWorktree(repoRoot, integrationWorktree.path)
      }
      deleteBranchIfPresent(repoRoot, integrationBranch, integrationHead)
      handoff.targetHead = currentTargetHead
      handoff.removed = true
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
    finalize: Boolean(input.finalize),
    handoffTarget,
    actions,
    removed,
    skipped,
    finalization,
    handoff,
    preserved: {
      integrationBranch: handoff.removed ? null : integrationBranch,
      integrationWorktree: handoff.removed ? null : integrationWorktree?.path ?? null,
      coordinationRefs: input.finalize && finalization.eligible && !input.dryRun
        ? null
        : `refs/plan-herder/${planName}/`,
      logs: true,
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
