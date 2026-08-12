#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readlink, realpath } from "node:fs/promises"
import type { BigIntStats } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { sha256 } from "../../shared/protocol.ts"

const TOKEN_VERSION = 1

interface CheckoutArguments {
  repo: string | null
  excludes: string[]
  expect: string | null
  pretty: boolean
  help?: boolean
}

interface GitState {
  head: string
  branch: string | null
  index: Buffer
  flags: Buffer
  status: Buffer
  dirty: Buffer
  untracked: Buffer
  dirtyPaths: string[]
  untrackedPaths: string[]
  flaggedPaths: string[]
}

interface CheckoutComponents {
  head: string
  branch: string | null
  indexSha256: string
  flagsSha256: string
  statusSha256: string
  trackedContentSha256: string
  untrackedContentSha256: string
  trackedContentCount: number
  untrackedContentCount: number
}

interface CheckoutPayload {
  version: number
  repoSha256: string
  excludesSha256: string
  components: CheckoutComponents
}

export interface SnapshotCheckoutInput {
  repo: string
  excludes?: string[]
  expect?: string | null
}

function fail(message: string): never {
  throw new Error(message)
}

function takeValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) fail(`${name} requires a value`)
  return value
}

function parseArguments(argv: string[]): CheckoutArguments {
  const options: CheckoutArguments = { repo: null, excludes: [], expect: null, pretty: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--pretty") options.pretty = true
    else if (["--repo", "--exclude", "--expect"].includes(argument)) {
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === "--repo") options.repo = value
      else if (argument === "--exclude") options.excludes.push(value)
      else options.expect = value
    } else if (["--help", "-h"].includes(argument)) options.help = true
    else fail(`Unknown argument: ${argument}`)
  }
  if (!options.help && !options.repo) fail("--repo is required")
  return options
}

function usage(): string {
  return "Usage: checkout-state.ts --repo <repository-root> [--exclude <path>]... [--expect <state-token>] [--pretty]\n"
}

function runGit(repoRoot: string, args: string[], { allowStatus = [] }: { allowStatus?: number[] } = {}) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) fail(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0 && (result.status === null || !allowStatus.includes(result.status))) {
    const details = result.stderr?.length ? result.stderr : (result.stdout || Buffer.alloc(0))
    fail(`git ${args.join(" ")} failed: ${Buffer.from(details).toString("utf8").trim()}`)
  }
  return result
}

function splitNul(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean)
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function resolveExcludes(repoRoot: string, values: string[]): Promise<string[]> {
  const excludes: string[] = []
  for (const value of values) {
    const candidate = path.resolve(repoRoot, value)
    const canonical = await realpath(candidate)
    if (!isInside(repoRoot, canonical)) fail(`--exclude must resolve inside the repository: ${candidate}`)
    excludes.push(path.relative(repoRoot, canonical).split(path.sep).join("/"))
  }
  return [...new Set(excludes)].sort()
}

function pathspecs(excludes: string[]): string[] {
  return ["--", ".", ...excludes.map((entry) => `:(top,exclude,literal)${entry}`)]
}

function gitState(repoRoot: string, excludes: string[]): GitState {
  const specs = pathspecs(excludes)
  const head = runGit(repoRoot, ["rev-parse", "HEAD"]).stdout.toString("utf8").trim()
  const branchResult = runGit(repoRoot, ["symbolic-ref", "-q", "HEAD"], { allowStatus: [1] })
  const branch = branchResult.status === 0 ? branchResult.stdout.toString("utf8").trim() : null
  const index = runGit(repoRoot, ["ls-files", "--stage", "-z", ...specs]).stdout
  const flags = runGit(repoRoot, ["ls-files", "-v", "-z", ...specs]).stdout
  const status = runGit(repoRoot, [
    "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none", ...specs,
  ]).stdout
  const dirty = runGit(repoRoot, [
    "diff-files", "--name-only", "-z", "--diff-filter=ACDMRTUXB", ...specs,
  ]).stdout
  const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...specs]).stdout
  return {
    head,
    branch,
    index,
    flags,
    status,
    dirty,
    untracked,
    dirtyPaths: splitNul(dirty),
    untrackedPaths: splitNul(untracked),
    flaggedPaths: splitNul(flags)
      .filter((record) => record[0] !== "H")
      .map((record) => record.slice(2)),
  }
}

function gitStateSignature(state: GitState): string {
  return sha256(Buffer.concat([
    Buffer.from(`${state.head}\0${state.branch ?? ""}\0`),
    state.index,
    state.flags,
    state.status,
    state.dirty,
    state.untracked,
  ]))
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

async function hashRegularFile(file: string, before: BigIntStats): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolve)
  })
  const after = await lstat(file, { bigint: true })
  if (!sameStat(before, after)) fail(`Checkout path changed while hashing: ${file}`)
  return hash.digest("hex")
}

async function pathRecord(repoRoot: string, relative: string): Promise<Record<string, string | number>> {
  const file = path.join(repoRoot, relative)
  let before: BigIntStats
  try {
    before = await lstat(file, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: relative, type: "missing" }
    throw error
  }
  const mode = Number(before.mode & 0o7777n)
  if (before.isFile()) {
    return { path: relative, type: "file", mode, sha256: await hashRegularFile(file, before) }
  }
  if (before.isSymbolicLink()) {
    const target = await readlink(file)
    const after = await lstat(file, { bigint: true })
    if (!sameStat(before, after)) fail(`Checkout symlink changed while hashing: ${file}`)
    return { path: relative, type: "symlink", mode, targetSha256: sha256(target) }
  }
  if (before.isDirectory()) {
    fail(`Checkout guard cannot safely fingerprint a dirty tracked directory or submodule: ${file}`)
  }
  fail(`Checkout guard does not support this path type: ${file}`)
}

async function contentManifest(repoRoot: string, paths: string[]): Promise<{ count: number; sha256: string }> {
  const records: Record<string, string | number>[] = []
  for (const relative of [...new Set(paths)].sort()) records.push(await pathRecord(repoRoot, relative))
  return {
    count: records.length,
    sha256: sha256(JSON.stringify(records)),
  }
}

function stablePayload(repoRoot: string, excludes: string[], state: GitState, tracked: { count: number; sha256: string }, untracked: { count: number; sha256: string }): CheckoutPayload {
  const components = {
    head: state.head,
    branch: state.branch,
    indexSha256: sha256(state.index),
    flagsSha256: sha256(state.flags),
    statusSha256: sha256(state.status),
    trackedContentSha256: tracked.sha256,
    untrackedContentSha256: untracked.sha256,
    trackedContentCount: tracked.count,
    untrackedContentCount: untracked.count,
  }
  return {
    version: TOKEN_VERSION,
    repoSha256: sha256(repoRoot),
    excludesSha256: sha256(JSON.stringify(excludes)),
    components,
  }
}

function encodeToken(payload: CheckoutPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

function decodeToken(value: string): CheckoutPayload {
  let parsed: CheckoutPayload
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  } catch {
    fail("--expect is not a valid checkout state token")
  }
  if (parsed?.version !== TOKEN_VERSION || !parsed.components || typeof parsed.repoSha256 !== "string") {
    fail("--expect uses an unsupported or malformed checkout state token")
  }
  return parsed
}

function changedComponents(expected: CheckoutPayload, current: CheckoutPayload): string[] {
  const changes: string[] = []
  if (expected.repoSha256 !== current.repoSha256) changes.push("repository")
  if (expected.excludesSha256 !== current.excludesSha256) changes.push("exclusions")
  const keys = new Set([...Object.keys(expected.components), ...Object.keys(current.components)])
  for (const key of keys) {
    const component = key as keyof CheckoutComponents
    if (expected.components[component] !== current.components[component]) changes.push(key)
  }
  return changes
}

export async function snapshotCheckout(input: SnapshotCheckoutInput) {
  const repoCandidate = path.resolve(input.repo)
  const repoRoot = await realpath(repoCandidate)
  const actualRoot = await realpath(runGit(repoRoot, ["rev-parse", "--show-toplevel"]).stdout.toString("utf8").trim())
  if (repoRoot !== actualRoot) fail(`--repo must be the Git repository root: ${actualRoot}`)
  const excludes = await resolveExcludes(repoRoot, input.excludes || [])

  const before = gitState(repoRoot, excludes)
  const trackedPaths = [...new Set([...before.dirtyPaths, ...before.flaggedPaths])]
  const tracked = await contentManifest(repoRoot, trackedPaths)
  const untracked = await contentManifest(repoRoot, before.untrackedPaths)
  const after = gitState(repoRoot, excludes)
  if (gitStateSignature(before) !== gitStateSignature(after)) {
    fail("Checkout changed while its preservation snapshot was being captured")
  }

  const payload = stablePayload(repoRoot, excludes, before, tracked, untracked)
  const stateToken = encodeToken(payload)
  const fingerprint = sha256(JSON.stringify(payload))
  const summary = {
    head: before.head,
    branch: before.branch,
    trackedContentCount: tracked.count,
    untrackedContentCount: untracked.count,
  }
  if (!input.expect) {
    return { ok: true, mode: "capture", repoRoot, excludes, fingerprint, stateToken, summary }
  }

  const expected = decodeToken(input.expect)
  const changes = changedComponents(expected, payload)
  return {
    ok: changes.length === 0,
    mode: "verify",
    repoRoot,
    excludes,
    fingerprint,
    stateToken,
    expectedFingerprint: sha256(JSON.stringify(expected)),
    changedComponents: changes,
    summary,
  }
}

function print(result: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`)
}

async function main(argv: string[]): Promise<void> {
  const options = parseArguments(argv)
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  const result = await snapshotCheckout({ repo: options.repo!, excludes: options.excludes, expect: options.expect })
  print(result, options.pretty)
  if (!result.ok) process.exitCode = 2
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    print({ ok: false, mode: "error", error: error instanceof Error ? error.message : String(error) }, process.argv.includes("--pretty"))
    process.exitCode = 1
  }
}
