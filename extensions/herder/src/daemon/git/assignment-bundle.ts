#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import type { SpawnSyncReturns } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { buildGraph, snapshotPlan, snapshotPlanFromGraph } from "../../core/plans.ts"
import type { PlanSnapshot } from "../../core/plans.ts"
import { parseCheckpointRefRelative } from "./coordination-ref.ts"

export const ASSIGNMENT_SCHEMA_VERSION = 1
export const ASSIGNMENT_KIND = "herder-plan-assignment"
export const RUN_ASSIGNMENT_KIND = "herder-run-assignment"
export const ASSIGNMENT_RELATIVE_SUFFIX = path.join(".herder", "assignment.json")

type AssignmentCommand = "materialize" | "materialize-run" | "inspect-active-rebase" | "verify"
type AssignmentOptions = Record<string, string | boolean | undefined> & { pretty?: boolean }

interface SnapshotInputFingerprint { kind: string; name: string; sha256: string }
interface TreeFingerprint {
  path: string
  type: string
  mode: number
  size?: number
  sha256?: string
}
export interface CompiledAssignmentEntry {
  snapshotSha256: string
  snapshotInputs: SnapshotInputFingerprint[]
  plan: {
    id: string
    title: string
    kind: string | null
    parentObjective: string | null
    dependencies: string[]
    inScopePaths: string[]
  }
  planText: string
}

interface AssignmentMetadata {
  branch: string
  generationBase: string
  graphGeneration?: number
}

interface PlanAssignmentBundle extends CompiledAssignmentEntry {
  schemaVersion: 1
  kind: typeof ASSIGNMENT_KIND
  assignment: AssignmentMetadata
}

interface RunAssignmentBundle {
  schemaVersion: 1
  kind: typeof RUN_ASSIGNMENT_KIND
  snapshotSha256: string
  plans: CompiledAssignmentEntry[]
  assignment: AssignmentMetadata
}

type AssignmentBundle = PlanAssignmentBundle | RunAssignmentBundle

interface RepositoryContext { root: string; commonDir: string }
interface MaterializeConfiguration {
  run?: boolean
  entries?: CompiledAssignmentEntry[] | null
  runGeneration?: number
}

export function runAssignmentRelativeSuffix(generation = 1): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("run assignment generation must be a positive integer")
  return path.join(".herder", `run-assignment-generation-${generation}.json`)
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function isSha256(value: unknown): value is string {
  return /^[0-9a-f]{64}$/.test(String(value))
}

function isObjectId(value: unknown): value is string {
  return /^[0-9a-f]{40,64}$/.test(String(value))
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function git(cwd: string, args: string[], { allowFailure = false }: { allowFailure?: boolean } = {}): SpawnSyncReturns<string> {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.error) throw new Error(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

function gitValue(cwd: string, ...args: string[]): string {
  return git(cwd, args).stdout.trim()
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", cwd, ...args])
  if (result.error) throw new Error(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${Buffer.concat([result.stderr || Buffer.alloc(0), result.stdout || Buffer.alloc(0)]).toString().trim()}`)
  }
  return result.stdout
}

function canonicalGitPath(cwd: string, value: string): string {
  const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value)
  return fs.realpathSync(resolved)
}

function repositoryContext(start: string): RepositoryContext {
  const root = fs.realpathSync(gitValue(start, "rev-parse", "--show-toplevel"))
  const commonDir = canonicalGitPath(root, gitValue(root, "rev-parse", "--git-common-dir"))
  return { root, commonDir }
}

function currentBranch(worktree: string): string {
  const result = git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`worktree must have a checked-out branch: ${worktree}`)
  }
  return result.stdout.trim()
}

function readRequiredMetadata(metadataDir: string, name: string): string {
  const file = path.join(metadataDir, name)
  let status
  try {
    status = fs.lstatSync(file)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(`active rebase metadata is missing ${name}`)
    throw error
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`active rebase metadata is not a regular file: ${name}`)
  }
  const value = fs.readFileSync(file, "utf8").trim()
  if (!value) throw new Error(`active rebase metadata is empty: ${name}`)
  return value
}

function fingerprintTree(root: string): TreeFingerprint[] {
  const entries: TreeFingerprint[] = []
  function visit(directory: string, relativeDirectory = ""): void {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = path.join(relativeDirectory, name).split(path.sep).join("/")
      const status = fs.lstatSync(absolute)
      if (status.isSymbolicLink()) throw new Error(`active rebase metadata contains a symlink: ${relative}`)
      if (status.isDirectory()) {
        entries.push({ path: `${relative}/`, type: "directory", mode: status.mode & 0o777 })
        visit(absolute, relative)
        continue
      }
      if (!status.isFile()) throw new Error(`active rebase metadata contains a non-file: ${relative}`)
      entries.push({
        path: relative,
        type: "file",
        mode: status.mode & 0o777,
        size: status.size,
        sha256: sha256(fs.readFileSync(absolute)),
      })
    }
  }
  visit(root)
  return entries
}

function fingerprintUntracked(worktree: string): TreeFingerprint[] {
  const output = gitBuffer(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
  const names = output.toString("utf8").split("\0").filter(Boolean).sort()
  return names.map((name) => {
    const absolute = path.resolve(worktree, name)
    if (!isInside(worktree, absolute)) throw new Error(`untracked path escapes the worktree: ${name}`)
    const status = fs.lstatSync(absolute)
    if (status.isSymbolicLink()) {
      return { path: name, type: "symlink", mode: status.mode & 0o777, sha256: sha256(fs.readlinkSync(absolute)) }
    }
    if (!status.isFile()) throw new Error(`untracked path is not a regular file: ${name}`)
    return {
      path: name,
      type: "file",
      mode: status.mode & 0o777,
      size: status.size,
      sha256: sha256(fs.readFileSync(absolute)),
    }
  })
}

function worktreeLeaseReason(worktree: string): string | null {
  const blocks = gitValue(worktree, "worktree", "list", "--porcelain").split(/\n\n+/)
  const prefix = `worktree ${worktree}\n`
  const block = blocks.find((entry) => `${entry}\n`.startsWith(prefix))
  if (!block) throw new Error(`expected stable plan worktree is not registered: ${worktree}`)
  const locked = block.split("\n").find((line) => line === "locked" || line.startsWith("locked "))
  return locked ? locked.slice("locked".length).trim() : null
}

function activeRebaseMetadata(worktree: string): {
  backend: string
  metadataDir: string
  headName: string
  onto: string
  origHead: string
  entries: TreeFingerprint[]
} {
  const mergePath = path.resolve(worktree, gitValue(worktree, "rev-parse", "--git-path", "rebase-merge"))
  const applyPath = path.resolve(worktree, gitValue(worktree, "rev-parse", "--git-path", "rebase-apply"))
  const candidates: Array<[string, string]> = [
    ["merge", mergePath] as [string, string],
    ["apply", applyPath] as [string, string],
  ].filter(([, candidate]) => fs.existsSync(candidate))
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? "active-rebase verification requires active Git rebase metadata"
      : "active-rebase verification found ambiguous Git rebase metadata")
  }
  const [backend, metadataDir] = candidates[0]!
  if (!fs.lstatSync(metadataDir).isDirectory() || fs.lstatSync(metadataDir).isSymbolicLink()) {
    throw new Error("active rebase metadata must be a real directory")
  }
  return {
    backend,
    metadataDir,
    headName: readRequiredMetadata(metadataDir, "head-name"),
    onto: readRequiredMetadata(metadataDir, "onto"),
    origHead: readRequiredMetadata(metadataDir, "orig-head"),
    entries: fingerprintTree(metadataDir),
  }
}

function parseArguments(argv: string[]): { command: AssignmentCommand; options: AssignmentOptions } {
  const command = argv.shift()
  if (!command || !["materialize", "materialize-run", "inspect-active-rebase", "verify"].includes(command)) {
    throw new Error("usage: assignment-bundle.ts materialize|materialize-run|inspect-active-rebase|verify [options]")
  }
  const options: AssignmentOptions = { pretty: false }
  while (argv.length > 0) {
    const argument = argv.shift()
    if (argument === "--pretty") {
      options.pretty = true
      continue
    }
    if (!argument?.startsWith("--")) throw new Error(`unknown argument: ${argument}`)
    const value = argv.shift()
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
    const key = argument.slice(2).replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase())
    if (Object.hasOwn(options, key)) throw new Error(`${argument} may be provided only once`)
    options[key] = value
  }
  return { command: command as AssignmentCommand, options }
}

function requireOption(options: AssignmentOptions, name: string): string {
  const value = options[name]
  if (!value) {
    const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    throw new Error(`--${flag} is required`)
  }
  return String(value)
}

function assertKnownOptions(options: AssignmentOptions, allowed: Set<string>): void {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new Error(`unknown option: --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
  }
}

function assertNoSymlinkComponents(root: string, candidate: string): void {
  if (!isInside(root, candidate)) throw new Error(`assignment path escapes the worktree: ${candidate}`)
  const relative = path.relative(root, candidate)
  let cursor = root
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    let status
    try {
      status = fs.lstatSync(cursor)
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue
      throw error
    }
    if (status.isSymbolicLink()) throw new Error(`assignment path contains a symlink: ${cursor}`)
    if (cursor !== candidate && !status.isDirectory()) {
      throw new Error(`assignment parent is not a directory: ${cursor}`)
    }
  }
}

function assertIgnored(worktree: string, bundlePath: string): string {
  const relative = path.relative(worktree, bundlePath).split(path.sep).join("/")
  const result = git(worktree, ["check-ignore", "--quiet", "--no-index", "--", relative], { allowFailure: true })
  if (result.status !== 0) {
    throw new Error(`assignment bundle must be Git-ignored before materialization: ${relative}`)
  }
  return relative
}

function assertSnapshotEntry(entry: unknown): asserts entry is CompiledAssignmentEntry {
  const candidate = entry as Partial<CompiledAssignmentEntry>
  if (!candidate?.plan || typeof candidate.plan !== "object" || !/^\d{3,}$/.test(String(candidate.plan.id))) {
    throw new Error("assignment bundle has an invalid plan identity")
  }
  if (!Array.isArray(candidate.snapshotInputs) || candidate.snapshotInputs.length === 0) {
    throw new Error("assignment bundle has no snapshot input fingerprints")
  }
  for (const input of candidate.snapshotInputs) {
    if (!input || typeof input.kind !== "string" || typeof input.name !== "string" || !isSha256(input.sha256)) {
      throw new Error("assignment bundle has an invalid snapshot input fingerprint")
    }
    if (Object.hasOwn(input, "file")) throw new Error("assignment bundle leaks a coordinator snapshot path")
  }
  if (typeof candidate.planText !== "string" || !isSha256(candidate.snapshotSha256)) {
    throw new Error("assignment bundle has invalid compiled plan content")
  }
  if (sha256(candidate.planText) !== candidate.snapshotSha256) {
    throw new Error("assignment bundle planText does not match snapshotSha256")
  }
}

function runSnapshotSha256(plans: CompiledAssignmentEntry[]): string {
  return sha256(JSON.stringify(plans.map((entry) => ({
    id: entry.plan.id,
    snapshotSha256: entry.snapshotSha256,
  }))))
}

function assertBundleEnvelope(bundle: unknown): asserts bundle is AssignmentBundle {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("assignment bundle is not a JSON object")
  const candidate = bundle as Record<string, any>
  if (
    candidate.schemaVersion !== ASSIGNMENT_SCHEMA_VERSION
    || ![ASSIGNMENT_KIND, RUN_ASSIGNMENT_KIND].includes(candidate.kind)
  ) {
    throw new Error(`unsupported assignment bundle schema: ${JSON.stringify(candidate.schemaVersion)}`)
  }
  if (!candidate.assignment || typeof candidate.assignment.branch !== "string" || typeof candidate.assignment.generationBase !== "string") {
    throw new Error("assignment bundle has invalid branch metadata")
  }
  if (candidate.kind === ASSIGNMENT_KIND) {
    assertSnapshotEntry(candidate)
    return
  }
  if (!Array.isArray(candidate.plans) || candidate.plans.length === 0) {
    throw new Error("run assignment bundle has no plan snapshots")
  }
  for (const entry of candidate.plans) assertSnapshotEntry(entry)
  if (!isSha256(candidate.snapshotSha256) || candidate.snapshotSha256 !== runSnapshotSha256(candidate.plans)) {
    throw new Error("run assignment bundle snapshot set does not match snapshotSha256")
  }
}

export function compiledAssignmentEntry(snapshot: PlanSnapshot): CompiledAssignmentEntry {
  return {
    snapshotSha256: snapshot.snapshotSha256,
    snapshotInputs: snapshot.snapshotInputs.map((input) => ({
      kind: input.kind,
      name: path.basename(input.file),
      sha256: input.sha256,
    })),
    plan: {
      id: snapshot.plan.id,
      title: snapshot.plan.title,
      kind: snapshot.plan.kind,
      parentObjective: snapshot.plan.parentObjective,
      dependencies: snapshot.plan.dependencies,
      inScopePaths: snapshot.plan.inScopePaths,
    },
    planText: snapshot.planText,
  }
}

export function materializeAssignment(options: AssignmentOptions, configuration: MaterializeConfiguration = {}) {
  const { run = false, entries: compiledEntries = null, runGeneration = 1 } = configuration
  const allowed = new Set([
    "pretty",
    "planDir",
    "worktree",
    "expectedBranch",
    "expectedHead",
  ])
  if (!run) {
    allowed.add("plan")
    allowed.add("expectedSnapshotSha256")
  }
  assertKnownOptions(options, allowed)
  const planId = run ? null : requireOption(options, "plan")
  const planDir = fs.realpathSync(path.resolve(requireOption(options, "planDir")))
  const worktreeInput = fs.realpathSync(path.resolve(requireOption(options, "worktree")))
  const expectedBranch = requireOption(options, "expectedBranch")
  const expectedHead = requireOption(options, "expectedHead")
  const expectedSnapshotSha256 = run ? null : requireOption(options, "expectedSnapshotSha256")
  if (run && (!Number.isSafeInteger(runGeneration) || runGeneration < 1)) {
    throw new Error("run assignment generation must be a positive integer")
  }
  if (!run && !isSha256(expectedSnapshotSha256)) {
    throw new Error("--expected-snapshot-sha256 must be a lowercase SHA-256")
  }

  const coordination = repositoryContext(planDir)
  const execution = repositoryContext(worktreeInput)
  if (worktreeInput !== execution.root) throw new Error(`--worktree must be the Git worktree root: ${execution.root}`)
  if (coordination.root === execution.root) throw new Error("assignment bundle requires a separate execution worktree")
  if (coordination.commonDir !== execution.commonDir) {
    throw new Error("plan directory and execution worktree do not belong to the same Git repository")
  }
  if (!isInside(coordination.root, planDir)) throw new Error("plan directory must be inside the coordination checkout")

  const branch = currentBranch(execution.root)
  if (branch !== expectedBranch) throw new Error(`worktree branch mismatch: expected ${expectedBranch}, found ${branch}`)
  const head = gitValue(execution.root, "rev-parse", "HEAD")
  if (head !== expectedHead) throw new Error(`worktree HEAD mismatch: expected ${expectedHead}, found ${head}`)
  const beforeStatus = gitValue(execution.root, "status", "--porcelain=v1", "--untracked-files=all")
  if (beforeStatus) throw new Error("execution worktree must be clean before assignment materialization")

  let entries: CompiledAssignmentEntry[] | null = compiledEntries
  if (entries === null) {
    if (run) {
      const graph = buildGraph(planDir)
      if (graph.plans.length === 0) throw new Error("cannot materialize a run assignment for an empty plan set")
      entries = graph.plans.map((plan) => compiledAssignmentEntry(snapshotPlanFromGraph(graph, plan.id)))
    } else {
      entries = [compiledAssignmentEntry(snapshotPlan(planDir, planId!))]
    }
  }
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("compiled assignment entries are required")
  for (const entry of entries) assertSnapshotEntry(entry)
  if (!run && entries.length !== 1) throw new Error("a plan assignment requires exactly one compiled entry")
  if (!run && entries[0].plan.id !== planId) throw new Error(`compiled assignment plan mismatch: expected ${planId}, found ${entries[0].plan.id}`)
  if (!run && entries[0].snapshotSha256 !== expectedSnapshotSha256) {
    throw new Error(`plan snapshot mismatch: expected ${expectedSnapshotSha256}, found ${entries[0].snapshotSha256}`)
  }

  const relativePlanDir = path.relative(coordination.root, planDir)
  const bundlePath = path.join(
    execution.root,
    relativePlanDir,
    run ? runAssignmentRelativeSuffix(runGeneration) : ASSIGNMENT_RELATIVE_SUFFIX,
  )
  assertNoSymlinkComponents(execution.root, bundlePath)
  const relativePath = assertIgnored(execution.root, bundlePath)

  const bundle: AssignmentBundle = run
    ? {
        schemaVersion: ASSIGNMENT_SCHEMA_VERSION,
        kind: RUN_ASSIGNMENT_KIND,
        snapshotSha256: runSnapshotSha256(entries),
        plans: entries,
        assignment: {
          branch,
          generationBase: head,
          graphGeneration: runGeneration,
        },
      }
    : {
        schemaVersion: ASSIGNMENT_SCHEMA_VERSION,
        kind: ASSIGNMENT_KIND,
        ...entries[0]!,
        assignment: {
          branch,
          generationBase: head,
        },
      }
  assertBundleEnvelope(bundle)
  const bytes = `${JSON.stringify(bundle, null, 2)}\n`
  const bundleSha256 = sha256(bytes)

  if (fs.existsSync(bundlePath)) {
    readVerifiedBundle(execution.root, {
      bundle: bundlePath,
      expectedBundleSha256: bundleSha256,
    })
    return {
      ok: true,
      command: run ? "materialize-run" : "materialize",
      scope: run ? "RUN" : entries[0]!.plan.id,
      branch,
      generationBase: head,
      bundlePath,
      relativePath,
      bundleSha256,
      snapshotSha256: bundle.snapshotSha256,
    }
  }

  fs.mkdirSync(path.dirname(bundlePath), { recursive: true })
  assertNoSymlinkComponents(execution.root, bundlePath)
  const temporary = `${bundlePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 })
    fs.renameSync(temporary, bundlePath)
    fs.chmodSync(bundlePath, 0o444)
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary)
  }

  const afterStatus = gitValue(execution.root, "status", "--porcelain=v1", "--untracked-files=all")
  if (afterStatus) {
    throw new Error("assignment materialization changed visible Git worktree state")
  }

  return {
    ok: true,
    command: run ? "materialize-run" : "materialize",
    scope: run ? "RUN" : entries[0]!.plan.id,
    branch,
    generationBase: head,
    bundlePath,
    relativePath,
    bundleSha256,
    snapshotSha256: bundle.snapshotSha256,
  }
}

export function verifyAssignment(options: AssignmentOptions) {
  const verificationMode = options.verificationMode || "branch"
  if (verificationMode === "active-rebase") return verifyActiveRebase(options)
  if (verificationMode !== "branch") throw new Error(`unknown verification mode: ${verificationMode}`)
  assertKnownOptions(options, new Set(["pretty", "worktree", "bundle", "expectedBundleSha256", "verificationMode"]))
  const worktreeInput = fs.realpathSync(path.resolve(requireOption(options, "worktree")))
  const execution = repositoryContext(worktreeInput)
  if (worktreeInput !== execution.root) throw new Error(`--worktree must be the Git worktree root: ${execution.root}`)
  const verifiedBundle = readVerifiedBundle(execution.root, options)
  const { bundle, bundlePath, relativePath, bundleSha256 } = verifiedBundle
  const branch = currentBranch(execution.root)
  if (bundle.assignment.branch !== branch) {
    throw new Error(`assignment branch mismatch: expected ${bundle.assignment.branch}, found ${branch}`)
  }

  return {
    ok: true,
    command: "verify",
    verificationMode: "branch",
    scope: bundle.kind === RUN_ASSIGNMENT_KIND ? "RUN" : bundle.plan.id,
    branch,
    generationBase: bundle.assignment.generationBase,
    bundlePath,
    relativePath,
    bundleSha256,
    snapshotSha256: bundle.snapshotSha256,
  }
}

function readVerifiedBundle(worktree: string, options: AssignmentOptions): {
  bundle: AssignmentBundle
  bundlePath: string
  relativePath: string
  bundleSha256: string
} {
  const bundleInput = path.resolve(requireOption(options, "bundle"))
  const expectedBundleSha256 = requireOption(options, "expectedBundleSha256")
  if (!isSha256(expectedBundleSha256)) throw new Error("--expected-bundle-sha256 must be a lowercase SHA-256")
  if (!fs.existsSync(bundleInput)) throw new Error(`assignment bundle is missing: ${bundleInput}`)
  const bundlePath = fs.realpathSync(bundleInput)
  if (bundlePath !== bundleInput || fs.lstatSync(bundleInput).isSymbolicLink()) {
    throw new Error(`assignment bundle must not be a symlink: ${bundleInput}`)
  }
  assertNoSymlinkComponents(worktree, bundlePath)
  if (!fs.statSync(bundlePath).isFile()) throw new Error(`assignment bundle is not a regular file: ${bundlePath}`)
  if ((fs.statSync(bundlePath).mode & 0o222) !== 0) throw new Error("assignment bundle must be read-only")
  const relativePath = assertIgnored(worktree, bundlePath)

  const bytes = fs.readFileSync(bundlePath)
  const bundleSha256 = sha256(bytes)
  if (bundleSha256 !== expectedBundleSha256) {
    throw new Error(`assignment bundle hash mismatch: expected ${expectedBundleSha256}, found ${bundleSha256}`)
  }
  let bundle: unknown
  try {
    bundle = JSON.parse(bytes.toString("utf8"))
  } catch (error) {
    throw new Error(`assignment bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  assertBundleEnvelope(bundle)
  return { bundle, bundlePath, relativePath, bundleSha256 }
}

function activeRebaseAllowedOptions({ includeStateHash }: { includeStateHash: boolean }): Set<string> {
  const allowed = new Set([
    "pretty",
    "worktree",
    "bundle",
    "expectedBundleSha256",
    "expectedWorktree",
    "expectedBranch",
    "expectedWorkerMode",
    "expectedDetachedHead",
    "expectedRebaseOnto",
    "expectedRebaseOrigHead",
    "expectedPlanHead",
    "expectedCheckpointRef",
    "expectedCheckpoint",
    "expectedLeaseReason",
  ])
  if (includeStateHash) {
    allowed.add("verificationMode")
    allowed.add("expectedRebaseStateSha256")
  }
  return allowed
}

function requireObjectIdOption(options: AssignmentOptions, name: string): string {
  const value = requireOption(options, name)
  if (!isObjectId(value)) {
    const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    throw new Error(`--${flag} must be a full lowercase Git object ID`)
  }
  return value
}

function activeRebaseEvidence(options: AssignmentOptions, { includeStateHash }: { includeStateHash: boolean }) {
  assertKnownOptions(options, activeRebaseAllowedOptions({ includeStateHash }))
  const worktreeInput = fs.realpathSync(path.resolve(requireOption(options, "worktree")))
  const expectedWorktree = path.resolve(requireOption(options, "expectedWorktree"))
  const execution = repositoryContext(worktreeInput)
  if (worktreeInput !== execution.root) throw new Error(`--worktree must be the Git worktree root: ${execution.root}`)
  if (expectedWorktree !== execution.root) {
    throw new Error(`active-rebase worktree mismatch: expected ${expectedWorktree}, found ${execution.root}`)
  }

  const expectedBranch = requireOption(options, "expectedBranch")
  const expectedWorkerMode = requireOption(options, "expectedWorkerMode")
  const expectedDetachedHead = requireObjectIdOption(options, "expectedDetachedHead")
  const expectedRebaseOnto = requireObjectIdOption(options, "expectedRebaseOnto")
  const expectedRebaseOrigHead = requireObjectIdOption(options, "expectedRebaseOrigHead")
  const expectedPlanHead = requireObjectIdOption(options, "expectedPlanHead")
  const expectedCheckpointRef = requireOption(options, "expectedCheckpointRef")
  const expectedCheckpoint = requireObjectIdOption(options, "expectedCheckpoint")
  const expectedLeaseReason = requireOption(options, "expectedLeaseReason")
  if (expectedWorkerMode !== "GUIDED_REPAIR") {
    throw new Error("active-rebase verification requires --expected-worker-mode GUIDED_REPAIR")
  }
  const branchMatch = expectedBranch.match(/^herder\/([^/]+)\/(\d{3,})$/)
  if (!branchMatch) throw new Error(`active-rebase verification requires an exact Herder plan branch: ${expectedBranch}`)
  const [, planName, planId] = branchMatch
  const [leaseNamespace, leasePlanName, leasePlanId, leaseRole, leaseAttempt, ...leaseTask] = expectedLeaseReason.split(":")
  const normalizedLeaseRole = leaseRole?.replace(/^plan[-_]/, "").toLowerCase()
  if (leaseNamespace !== "plan-herder"
    || leasePlanName !== planName
    || leasePlanId !== planId
    || normalizedLeaseRole !== "implementer"
    || !leaseAttempt
    || leaseTask.join(":").length === 0
    || /[\r\n]/.test(expectedLeaseReason)) {
    throw new Error("active-rebase verification requires the exact guided-repair Implementer lease")
  }
  const branchRef = `refs/heads/${expectedBranch}`
  if (git(execution.root, ["check-ref-format", branchRef], { allowFailure: true }).status !== 0) {
    throw new Error(`invalid expected plan branch: ${expectedBranch}`)
  }
  const coordinationPrefix = `refs/plan-herder/${planName}/`
  const checkpointIdentity = expectedCheckpointRef.startsWith(coordinationPrefix)
    ? parseCheckpointRefRelative(expectedCheckpointRef.slice(coordinationPrefix.length))
    : null
  if (!checkpointIdentity
    || checkpointIdentity.plan !== planId
    || git(execution.root, ["check-ref-format", expectedCheckpointRef], { allowFailure: true }).status !== 0) {
    throw new Error(`invalid expected Herder checkpoint ref: ${expectedCheckpointRef}`)
  }
  if (expectedPlanHead !== expectedRebaseOrigHead || expectedCheckpoint !== expectedRebaseOrigHead) {
    throw new Error("active-rebase plan head, original commit, and checkpoint must identify the same pre-restack commit")
  }

  const verifiedBundle = readVerifiedBundle(execution.root, options)
  const { bundle, bundlePath, relativePath, bundleSha256 } = verifiedBundle
  if (bundle.kind !== ASSIGNMENT_KIND) throw new Error("active-rebase verification requires a plan assignment bundle")
  if (bundle.plan.id !== planId) {
    throw new Error(`assignment plan mismatch: expected ${planId}, found ${bundle.plan.id}`)
  }
  if (bundle.assignment.branch !== expectedBranch) {
    throw new Error(`assignment branch mismatch: expected ${expectedBranch}, found ${bundle.assignment.branch}`)
  }

  const symbolic = git(execution.root, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true })
  if (symbolic.status === 0 || symbolic.stdout.trim()) {
    throw new Error("active-rebase verification requires Git's detached rebase HEAD")
  }
  const rebase = activeRebaseMetadata(execution.root)
  if (rebase.headName !== branchRef) {
    throw new Error(`active rebase head-name mismatch: expected ${branchRef}, found ${rebase.headName}`)
  }
  if (rebase.onto !== expectedRebaseOnto) {
    throw new Error(`active rebase onto mismatch: expected ${expectedRebaseOnto}, found ${rebase.onto}`)
  }
  if (rebase.origHead !== expectedRebaseOrigHead) {
    throw new Error(`active rebase orig-head mismatch: expected ${expectedRebaseOrigHead}, found ${rebase.origHead}`)
  }

  const detachedHead = gitValue(execution.root, "rev-parse", "HEAD")
  const planHead = gitValue(execution.root, "rev-parse", "--verify", branchRef)
  const checkpoint = gitValue(execution.root, "rev-parse", "--verify", expectedCheckpointRef)
  const origHeadRef = gitValue(execution.root, "rev-parse", "--verify", "ORIG_HEAD")
  if (detachedHead !== expectedDetachedHead) {
    throw new Error(`active rebase detached HEAD mismatch: expected ${expectedDetachedHead}, found ${detachedHead}`)
  }
  if (planHead !== expectedPlanHead) {
    throw new Error(`active rebase plan branch moved: expected ${expectedPlanHead}, found ${planHead}`)
  }
  if (checkpoint !== expectedCheckpoint) {
    throw new Error(`active rebase checkpoint mismatch: expected ${expectedCheckpoint}, found ${checkpoint}`)
  }
  if (origHeadRef !== expectedRebaseOrigHead) {
    throw new Error(`active rebase ORIG_HEAD mismatch: expected ${expectedRebaseOrigHead}, found ${origHeadRef}`)
  }
  const leaseReason = worktreeLeaseReason(execution.root)
  if (leaseReason !== expectedLeaseReason) {
    throw new Error(`active-rebase lease mismatch: expected ${expectedLeaseReason}, found ${leaseReason || "unlocked"}`)
  }

  const indexStages = gitBuffer(execution.root, ["ls-files", "--stage", "-z"])
  const conflictBytes = gitBuffer(execution.root, ["diff", "--name-only", "--diff-filter=U", "-z"])
  const conflicts = conflictBytes.toString("utf8").split("\0").filter(Boolean).sort()
  if (conflicts.length === 0) throw new Error("active-rebase verification requires preserved unresolved conflicts")
  const state = {
    schemaVersion: 1,
    worktree: execution.root,
    assignment: {
      bundlePath,
      bundleSha256,
      kind: bundle.kind,
      branch: bundle.assignment.branch,
      workerMode: expectedWorkerMode,
    },
    leaseReason,
    rebase: {
      backend: rebase.backend,
      headName: rebase.headName,
      onto: rebase.onto,
      origHead: rebase.origHead,
      metadataEntries: rebase.entries,
    },
    refs: {
      detachedHead,
      planRef: branchRef,
      planHead,
      checkpointRef: expectedCheckpointRef,
      checkpoint,
      origHeadRef,
    },
    gitState: {
      statusSha256: sha256(gitBuffer(execution.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])),
      indexStagesSha256: sha256(indexStages),
      conflicts,
      conflictsSha256: sha256(conflictBytes),
      worktreeDiffSha256: sha256(gitBuffer(execution.root, ["diff", "--binary", "--full-index", "--no-ext-diff", "--"])),
      cachedDiffSha256: sha256(gitBuffer(execution.root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--"])),
      untracked: fingerprintUntracked(execution.root),
    },
  }
  return {
    execution,
    bundle,
    bundlePath,
    relativePath,
    bundleSha256,
    state,
    rebaseStateSha256: sha256(JSON.stringify(state)),
  }
}

export function inspectActiveRebase(options: AssignmentOptions) {
  const evidence = activeRebaseEvidence(options, { includeStateHash: false })
  return {
    ok: true,
    command: "inspect-active-rebase",
    verificationMode: "active-rebase",
    scope: evidence.bundle.plan.id,
    branch: evidence.bundle.assignment.branch,
    workerMode: "GUIDED_REPAIR",
    generationBase: evidence.bundle.assignment.generationBase,
    bundlePath: evidence.bundlePath,
    relativePath: evidence.relativePath,
    bundleSha256: evidence.bundleSha256,
    snapshotSha256: evidence.bundle.snapshotSha256,
    detachedHead: evidence.state.refs.detachedHead,
    rebaseOnto: evidence.state.rebase.onto,
    rebaseOrigHead: evidence.state.rebase.origHead,
    planHead: evidence.state.refs.planHead,
    checkpointRef: evidence.state.refs.checkpointRef,
    checkpoint: evidence.state.refs.checkpoint,
    conflicts: evidence.state.gitState.conflicts,
    rebaseStateSha256: evidence.rebaseStateSha256,
  }
}

export function verifyActiveRebase(options: AssignmentOptions) {
  if (options.verificationMode !== "active-rebase") {
    throw new Error("active-rebase verification must be explicitly requested")
  }
  const expectedRebaseStateSha256 = requireOption(options, "expectedRebaseStateSha256")
  if (!isSha256(expectedRebaseStateSha256)) {
    throw new Error("--expected-rebase-state-sha256 must be a lowercase SHA-256")
  }
  const evidence = activeRebaseEvidence(options, { includeStateHash: true })
  if (evidence.rebaseStateSha256 !== expectedRebaseStateSha256) {
    throw new Error(`active rebase state mismatch: expected ${expectedRebaseStateSha256}, found ${evidence.rebaseStateSha256}`)
  }

  return {
    ok: true,
    command: "verify",
    verificationMode: "active-rebase",
    scope: evidence.bundle.plan.id,
    branch: evidence.bundle.assignment.branch,
    workerMode: "GUIDED_REPAIR",
    generationBase: evidence.bundle.assignment.generationBase,
    bundlePath: evidence.bundlePath,
    relativePath: evidence.relativePath,
    bundleSha256: evidence.bundleSha256,
    snapshotSha256: evidence.bundle.snapshotSha256,
    detachedHead: evidence.state.refs.detachedHead,
    rebaseStateSha256: evidence.rebaseStateSha256,
  }
}

function print(result: unknown, pretty = false): void {
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`)
}

function main(): void {
  let parsed: { command: AssignmentCommand; options: AssignmentOptions } | undefined
  try {
    parsed = parseArguments(process.argv.slice(2))
    const result = parsed.command === "verify"
      ? verifyAssignment(parsed.options)
      : parsed.command === "inspect-active-rebase"
        ? inspectActiveRebase(parsed.options)
        : materializeAssignment(parsed.options, { run: parsed.command === "materialize-run" })
    print(result, parsed.options.pretty)
  } catch (error) {
    print({ ok: false, error: error instanceof Error ? error.message : String(error) }, parsed?.options?.pretty)
    process.exitCode = 1
  }
}

const invokedAsScript = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) main()
