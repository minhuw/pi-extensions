#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import type { SpawnSyncReturns } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildGraph } from "../../core/plans.ts"
import { parseCoordinationRefRelative } from "./coordination-ref.ts"
import { inspectCompletionProof } from "./completion-proof.ts"

type NamespaceMode = "fire" | "resume" | "status"
interface NamespaceInput {
  repo: string
  planDir: string
  planName?: string | null
  mode: NamespaceMode
  pretty?: boolean
}
interface BranchRecord { branch: string; head: string; relative: string }
interface RefRecord { ref: string; target: string; relative: string }
interface WorktreeRecord { path: string; branch: string; locked: boolean }
type NamespaceConflict = Record<string, string>

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

function parseArguments(argv: string[]): NamespaceInput {
  const options: Partial<NamespaceInput> & { pretty: boolean } = {
    planName: null,
    pretty: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--pretty") {
      options.pretty = true
      continue
    }
    if (["--repo", "--plan-dir", "--plan-name", "--mode"].includes(argument)) {
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === "--repo") options.repo = value
      else if (argument === "--plan-dir") options.planDir = value
      else if (argument === "--plan-name") options.planName = value
      else options.mode = value as NamespaceMode
      continue
    }
    fail(`Unknown argument: ${argument}`)
  }
  for (const [name, value] of [["--repo", options.repo], ["--plan-dir", options.planDir], ["--mode", options.mode]]) {
    if (!value) fail(`${name} is required`)
  }
  if (!options.mode || !(["fire", "resume", "status"] as string[]).includes(options.mode)) fail(`Unsupported mode: ${JSON.stringify(options.mode)}`)
  return options as NamespaceInput
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function validatePlanName(value: unknown): string {
  const name = String(value)
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)
    || name.includes("..")
    || name.endsWith(".")
    || name.endsWith(".lock")) {
    fail(`Plan-set name must be a lowercase Git-safe basename: ${JSON.stringify(value)}`)
  }
  return name
}

function refExists(repoRoot: string, ref: string): boolean {
  return runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }).status === 0
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  const result = runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true })
  if (result.status === 0) return true
  if (result.status === 1) return false
  fail(`Cannot compare ${ancestor} with ${descendant}: ${(result.stderr || result.stdout).trim()}`)
}

function listNamespaceBranches(repoRoot: string, planName: string): BranchRecord[] {
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

function listCoordinationRefs(repoRoot: string, planName: string): RefRecord[] {
  const prefix = `refs/plan-herder/${planName}/`
  const output = runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    prefix,
  ]).stdout
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t")
    if (separator === -1) fail(`Cannot parse Git coordination ref: ${JSON.stringify(line)}`)
    const ref = line.slice(0, separator)
    return { ref, target: line.slice(separator + 1), relative: ref.slice(prefix.length) }
  })
}

function listWorktrees(repoRoot: string): WorktreeRecord[] {
  const output = runGit(repoRoot, ["worktree", "list", "--porcelain"]).stdout
  const records: WorktreeRecord[] = []
  for (const block of output.split(/(?:\r?\n){2,}/).filter((item) => item.trim())) {
    const record = { path: "", branch: "", locked: false }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) record.path = line.slice("worktree ".length)
      else if (line.startsWith("branch refs/heads/")) record.branch = line.slice("branch refs/heads/".length)
      else if (line === "locked" || line.startsWith("locked ")) record.locked = true
    }
    if (record.path) records.push(record)
  }
  return records
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
  const branches = listNamespaceBranches(repoRoot, planName)
  const coordinationRefs = listCoordinationRefs(repoRoot, planName)
  const parentConflicts = [
    "refs/heads/herder",
    `refs/heads/${namespace}`,
    "refs/plan-herder",
    `refs/plan-herder/${planName}`,
  ].filter((ref) => refExists(repoRoot, ref))
  const integration = branches.find((item) => item.relative === "integration") ?? null
  const baseRef = coordinationRefs.find((item) => item.relative === "base") ?? null
  const planBranches = branches.filter((item) => /^\d{3,}$/.test(item.relative))
  const unknownBranches = branches.filter((item) => item.relative !== "integration" && !/^\d{3,}$/.test(item.relative))
  const unindexedBranches = planBranches.filter((item) => !planIds.has(item.relative))
  const recognizedCoordinationRefs = coordinationRefs.filter((item) => parseCoordinationRefRelative(item.relative))
  const unknownCoordinationRefs = coordinationRefs.filter((item) => !recognizedCoordinationRefs.includes(item))
  const unindexedCoordinationRefs = recognizedCoordinationRefs.filter((item) => {
    const identity = parseCoordinationRefRelative(item.relative)
    return identity?.plan ? !planIds.has(identity.plan) : false
  })
  const invalidCompletionRefs = recognizedCoordinationRefs
    .filter((item) => parseCoordinationRefRelative(item.relative)?.kind === "completed")
    .map((item) => ({ item, proof: inspectCompletionProof(repoRoot, item.ref) }))
    .filter(({ item, proof }) => !proof.ok || proof.payload.planId !== parseCoordinationRefRelative(item.relative)?.plan)
  const worktrees = listWorktrees(repoRoot)
  const namespaceBranchNames = new Set(branches.map((item) => item.branch))
  const namespaceWorktrees = worktrees.filter((item) => namespaceBranchNames.has(item.branch))

  let ok = true
  let reason: string | null = null
  const conflicts: NamespaceConflict[] = []
  if (input.mode === "fire") {
    conflicts.push(...parentConflicts.map((ref) => ({ type: "parent-ref", ref })))
    conflicts.push(...branches.map((item) => ({ type: "branch", branch: item.branch, head: item.head })))
    conflicts.push(...coordinationRefs.map((item) => ({ type: "coordination-ref", ref: item.ref, target: item.target })))
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
      for (const item of recognizedCoordinationRefs.filter((ref) => parseCoordinationRefRelative(ref.relative)?.kind === "completed")) {
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
    baseRef,
    planBranches,
    unknownBranches,
    unindexedBranches,
    coordinationRefs,
    unknownCoordinationRefs,
    unindexedCoordinationRefs,
    invalidCompletionRefs: invalidCompletionRefs.map(({ item, proof }) => ({ ref: item.ref, target: item.target, proof })),
    worktrees: namespaceWorktrees,
    conflicts,
  }
}

function main(argv: string[]): void {
  const options = parseArguments(argv)
  const result = inspectNamespace(options)
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`)
  if (!result.ok) process.exitCode = 2
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`herder-fire-namespace: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
