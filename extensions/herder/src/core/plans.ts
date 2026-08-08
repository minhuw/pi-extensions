#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  executionReport,
  initializeExecutionStore,
  readRunConfiguration,
  readUsageState,
  recordRunConfiguration,
  recordUsageRecord,
  usageReport,
  type RunConfigurationInput,
  type UsageRecordInput,
} from "../daemon/execution-store.ts"

const DEFAULT_PLAN_DIR = "herder-plans"
const TERMINAL = new Set(["DONE", "REJECTED"])
const ACTIONABLE = new Set(["TODO", "IN PROGRESS", "BLOCKED"])
const SUPPORTED_STATUSES = new Set([...TERMINAL, ...ACTIONABLE])
const REQUIRED_PLAN_HEADINGS = [
  "Status",
  "Why this matters",
  "Current state",
  "Commands you will need",
  "Scope",
  "Git workflow",
  "Steps",
  "Test plan",
  "Done criteria",
  "STOP conditions",
  "Maintenance notes",
]
const REQUIRED_PLAN_METADATA = ["Priority", "Effort", "Risk", "Depends on", "Category", "Planned at"]
const SHAPE_PLAN_HEADINGS = ["Dependency contract", "Review map"]
const SHAPE_PLAN_METADATA = ["Kind", "Parent objective"]
const PLAN_KINDS = new Set(["behavioral", "mechanical", "migration", "spike"])
const SHARED_CONTEXT_FILE = "CONTEXT.md"
const MAX_PLAN_WORDS = 1200
const MAX_SHARED_CONTEXT_WORDS = 1600
const FIRE_BRANCH_INSTRUCTION = "use the exact branch/worktree assigned by Herder Fire; never create or switch branches."
const REQUIRED_INDEX_HEADERS = ["plan", "title", "priority", "effort", "depends on", "status"]

export type PlanStatus = "TODO" | "IN PROGRESS" | "DONE" | "BLOCKED" | "REJECTED"

export interface PlanRecord {
  id: string
  title: string
  priority: string
  effort: string
  dependencies: string[]
  status: PlanStatus
  statusDetail: string
  file: string
  kind: string | null
  parentObjective: string | null
  inScopePaths: string[]
  planWords: number
  planLines: number
  shapeIssues: string[]
  shapeReady: boolean
}

export interface PlanGraph {
  planDir: string
  readme: string
  counts: { total: number; done: number; rejected: number; actionable: number }
  plans: PlanRecord[]
  ready: string[]
  inProgress: string[]
  blocked: string[]
  waiting: Array<{ id: string; unsatisfied: string[]; rejected: string[] }>
  waves: string[][]
  complete: boolean
  contextFile: string | null
  contextWords: number
  contextIssues: string[]
  shapeReady: boolean
  overlaps: Array<{ plans: [string, string]; paths: string[]; ordered: boolean }>
  warnings: string[]
}

interface IndexTable {
  header: string[]
  normalized: string[]
  rows: Array<{ cells: string[]; lineIndex: number }>
  lines: string[]
}

interface PlanFileDetails {
  dependencies: string[]
  text: string
  kind: string | null
  parentObjective: string | null
  inScopePaths: string[]
  planWords: number
  planLines: number
  shapeIssues: string[]
}

function fail(message: string): never {
  throw new Error(message)
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes("|")) return null
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  return body.split("|").map((cell) => cell.trim())
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim()
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
}

function canonicalId(value: unknown, context = "plan ID"): string {
  const match = String(value).match(/\b(\d+)\b/)
  if (!match) fail(`Cannot find a numeric plan ID in ${context}: ${JSON.stringify(value)}`)
  const numeric = Number.parseInt(match[1]!, 10)
  if (!Number.isSafeInteger(numeric)) fail(`Invalid plan ID in ${context}: ${JSON.stringify(value)}`)
  return String(numeric).padStart(3, "0")
}

function parseDependencies(value: unknown): string[] {
  const plain = String(value)
    .replace(/<!--.*?-->/g, " ")
    .replace(/[`*_]/g, " ")
    .trim()
  if (!plain || /^(?:none|n\/a|na|—|-|–)$/i.test(plain)) return []
  const ids = [...plain.matchAll(/\b\d+\b/g)].map((match) => canonicalId(match[0], "dependency"))
  if (ids.length === 0) fail(`Cannot parse dependencies: ${JSON.stringify(value)}`)
  return [...new Set(ids)]
}

function parseStatus(value: unknown, id: string): { status: PlanStatus; statusDetail: string } {
  const normalized = String(value).replace(/[`*_]/g, "").trim()
  const match = normalized.match(/^(TODO|IN\s+PROGRESS|DONE|BLOCKED|REJECTED)\b(?:\s*[:—–-]\s*|\s+)?(.*)$/i)
  if (!match) fail(`Plan ${id} has unsupported status: ${JSON.stringify(value)}`)
  const status = match[1]!.toUpperCase().replace(/\s+/g, " ") as PlanStatus
  const statusDetail = match[2]!.trim()
  if (statusDetail && !new Set(["BLOCKED", "REJECTED"]).has(status)) {
    fail(`Plan ${id} may include a status detail only when BLOCKED or REJECTED`)
  }
  if (!statusDetail && new Set(["BLOCKED", "REJECTED"]).has(status)) {
    fail(`Plan ${id} must explain why it is ${status}`)
  }
  return { status, statusDetail }
}

function extractLink(value: unknown): string | null {
  const match = String(value).match(/\[[^\]]+\]\(([^)]+)\)/)
  return match ? match[1].trim().replace(/^<|>$/g, "") : null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function wordCount(value: unknown): number {
  const trimmed = String(value).trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function resolvePlanFile(planDir: string, planCell: string, id: string): string {
  const link = extractLink(planCell)
  if (link) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("#")) {
      fail(`Plan ${id} must link to a local Markdown file, not ${JSON.stringify(link)}`)
    }
    const withoutFragment = link.split("#", 1)[0]
    const resolved = path.resolve(planDir, decodeURIComponent(withoutFragment))
    if (!isInside(planDir, resolved) || path.extname(resolved).toLowerCase() !== ".md") {
      fail(`Plan ${id} link escapes the plan directory or is not Markdown: ${JSON.stringify(link)}`)
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      fail(`Plan ${id} file does not exist: ${resolved}`)
    }
    if (!new RegExp(`^${id}-.*\\.md$`, "i").test(path.basename(resolved))) {
      fail(`Plan ${id} link must target an ${id}-*.md file: ${resolved}`)
    }
    const realPlanDir = fs.realpathSync(planDir)
    const realResolved = fs.realpathSync(resolved)
    if (!isInside(realPlanDir, realResolved)) {
      fail(`Plan ${id} resolves outside the plan directory through a symlink: ${resolved}`)
    }
    return resolved
  }

  const matches = fs.readdirSync(planDir)
    .filter((name) => name !== "README.md" && new RegExp(`^${id}-.*\\.md$`, "i").test(name))
    .map((name) => path.join(planDir, name))
  if (matches.length !== 1) {
    fail(`Plan ${id} must resolve to exactly one ${id}-*.md file; found ${matches.length}`)
  }
  const resolved = matches[0]
  if (!fs.statSync(resolved).isFile() || !isInside(fs.realpathSync(planDir), fs.realpathSync(resolved))) {
    fail(`Plan ${id} resolves outside the plan directory or is not a file: ${resolved}`)
  }
  return resolved
}

function sectionText(text: string, heading: string): string {
  const match = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "im").exec(text)
  if (!match) return ""
  const tail = text.slice(match.index + match[0].length)
  const next = tail.search(/^##\s+/m)
  return next === -1 ? tail : tail.slice(0, next)
}

function extractInScopePaths(text: string): string[] {
  const scope = sectionText(text, "Scope")
  const inScope = scope.match(/\*\*In scope\*\*[^\n]*([\s\S]*?)(?=\*\*Out of scope\*\*|$)/i)?.[1] ?? ""
  const paths: string[] = []
  for (const match of inScope.matchAll(/`([^`\r\n]+)`/g)) {
    const candidate = match[1].trim()
    if (!candidate || /\s(?:--?|&&|\|)\s/.test(candidate) || /[()]$/.test(candidate)) continue
    if (!candidate.includes("/") && !/^[\w@.-]+\.[A-Za-z0-9*{}_-]+$/.test(candidate)) continue
    paths.push(candidate)
  }
  return [...new Set(paths)]
}

function parsePlanFile(file: string, id: string): PlanFileDetails {
  const text = fs.readFileSync(file, "utf8")
  const title = text.match(/^#\s+Plan\s+(\d+)\b/i)
  if (!title || canonicalId(title[1], "plan title") !== id) {
    fail(`Plan ${id} must start with a matching "# Plan ${id}:" title: ${file}`)
  }
  for (const heading of REQUIRED_PLAN_HEADINGS) {
    if (!new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "im").test(text)) {
      fail(`Plan ${id} is missing required heading "## ${heading}": ${file}`)
    }
  }
  const metadata = new Map<string, string>()
  for (const field of REQUIRED_PLAN_METADATA) {
    const match = text.match(new RegExp(`^\\s*[-*]\\s+\\*\\*${escapeRegex(field)}\\*\\*:\\s*(.+?)\\s*$`, "im"))
    if (!match) fail(`Plan ${id} is missing required metadata "- **${field}**:": ${file}`)
    metadata.set(field, match[1])
  }
  for (const field of SHAPE_PLAN_METADATA) {
    const match = text.match(new RegExp(`^\\s*[-*]\\s+\\*\\*${escapeRegex(field)}\\*\\*:\\s*(.+?)\\s*$`, "im"))
    if (match) metadata.set(field, match[1])
  }
  const workflowHeading = /^##\s+Git workflow\s*$/im.exec(text)
  const workflowTail = text.slice(workflowHeading!.index + workflowHeading![0].length)
  const nextHeadingOffset = workflowTail.search(/^##\s+/m)
  const workflow = nextHeadingOffset === -1 ? workflowTail : workflowTail.slice(0, nextHeadingOffset)
  const branchInstructions = [...text.matchAll(/^\s*[-*]\s+Branch:\s*(.+?)\s*$/gim)]
  const workflowBranchInstructions = [...workflow.matchAll(/^\s*[-*]\s+Branch:\s*(.+?)\s*$/gim)]
  if (branchInstructions.length !== 1 || workflowBranchInstructions.length !== 1) {
    fail(`Plan ${id} must contain exactly one "- Branch:" instruction in "## Git workflow": ${file}`)
  }
  if (workflowBranchInstructions[0]![1]!.trim() !== FIRE_BRANCH_INSTRUCTION) {
    fail(`Plan ${id} must delegate branch ownership to Herder Fire with "- Branch: ${FIRE_BRANCH_INSTRUCTION}": ${file}`)
  }
  const shapeIssues: string[] = []
  for (const field of SHAPE_PLAN_METADATA) {
    if (!metadata.has(field)) shapeIssues.push(`missing metadata "${field}"`)
  }
  for (const heading of SHAPE_PLAN_HEADINGS) {
    if (!new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "im").test(text)) {
      shapeIssues.push(`missing heading "## ${heading}"`)
    }
  }
  const kind = metadata.has("Kind") ? metadata.get("Kind")!.trim().toLowerCase() : null
  if (kind && !PLAN_KINDS.has(kind)) {
    fail(`Plan ${id} has unsupported Kind ${JSON.stringify(metadata.get("Kind"))}: ${file}`)
  }
  const inScopePaths = extractInScopePaths(text)
  if (inScopePaths.length === 0) shapeIssues.push("has no machine-readable backticked in-scope paths")
  const planWords = wordCount(text)
  const planLines = text.split(/\r?\n/).length
  if (planWords > MAX_PLAN_WORDS) {
    shapeIssues.push(`has ${planWords} words; compact subplans must stay at or below ${MAX_PLAN_WORDS}`)
  }
  return {
    dependencies: parseDependencies(metadata.get("Depends on")),
    text,
    kind,
    parentObjective: metadata.get("Parent objective")?.trim() || null,
    inScopePaths,
    planWords,
    planLines,
    shapeIssues,
  }
}

function findIndexTable(markdown: string, readme: string): IndexTable {
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = parseTableRow(lines[index])
    const separator = parseTableRow(lines[index + 1])
    if (!header || !separator || !isSeparatorRow(separator)) continue
    const normalized = header.map(normalizeHeader)
    if (!REQUIRED_INDEX_HEADERS.every((name) => normalized.includes(name))) continue

    const rows: IndexTable["rows"] = []
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = parseTableRow(lines[rowIndex])
      if (!cells || cells.length < header.length) break
      rows.push({ cells: cells.slice(0, header.length), lineIndex: rowIndex })
    }
    return { header, normalized, rows, lines }
  }
  fail(`${readme} has no Markdown table containing the required columns: Plan, Title, Priority, Effort, Depends on, Status`)
}

function detectCycle(plansById: Map<string, PlanRecord>): string[] | null {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  function visit(id: string): string[] | null {
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    if (visited.has(id)) return null
    visiting.add(id)
    stack.push(id)
    for (const dependency of plansById.get(id)!.dependencies) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
    return null
  }

  for (const id of plansById.keys()) {
    const cycle = visit(id)
    if (cycle) return cycle
  }
  return null
}

function buildWaves(plans: PlanRecord[]): string[][] {
  const remaining = new Map(plans.map((plan) => [plan.id, new Set(plan.dependencies)]))
  const waves: string[][] = []
  while (remaining.size > 0) {
    const wave = [...remaining.entries()]
      .filter(([, dependencies]) => [...dependencies].every((dependency) => !remaining.has(dependency)))
      .map(([id]) => id)
      .sort()
    if (wave.length === 0) fail("Cannot build dependency waves; the graph contains a cycle")
    waves.push(wave)
    for (const id of wave) remaining.delete(id)
  }
  return waves
}

function transitiveDependencies(plansById: Map<string, PlanRecord>): Map<string, Set<string>> {
  const memo = new Map<string, Set<string>>()
  const collect = (id: string): Set<string> => {
    const cached = memo.get(id)
    if (cached) return cached
    const dependencies = new Set<string>()
    for (const dependency of plansById.get(id)?.dependencies ?? []) {
      dependencies.add(dependency)
      for (const transitive of collect(dependency)) dependencies.add(transitive)
    }
    memo.set(id, dependencies)
    return dependencies
  }
  for (const id of plansById.keys()) collect(id)
  return memo
}

function sharedContextPath(planDir: string): string | null {
  const file = path.join(planDir, SHARED_CONTEXT_FILE)
  if (!fs.existsSync(file)) return null
  if (!fs.statSync(file).isFile()) fail(`${file} must be a regular Markdown file`)
  const realPlanDir = fs.realpathSync(planDir)
  const realFile = fs.realpathSync(file)
  if (!isInside(realPlanDir, realFile)) fail(`${file} resolves outside the plan directory`)
  return file
}

export function buildGraph(inputDir = DEFAULT_PLAN_DIR): PlanGraph {
  const planDir = path.resolve(inputDir)
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) {
    fail(`Plan directory does not exist: ${planDir}`)
  }
  const readme = path.join(planDir, "README.md")
  if (!fs.existsSync(readme) || !fs.statSync(readme).isFile()) {
    fail(`Plan directory has no README.md: ${planDir}`)
  }

  const contextFile = sharedContextPath(planDir)
  const contextText = contextFile ? fs.readFileSync(contextFile, "utf8") : ""
  const contextWords = wordCount(contextText)
  const contextIssues = contextWords > MAX_SHARED_CONTEXT_WORDS
    ? [`Shared context has ${contextWords} words; keep it at or below ${MAX_SHARED_CONTEXT_WORDS}`]
    : []
  const table = findIndexTable(fs.readFileSync(readme, "utf8"), readme)
  const column = Object.fromEntries(table.normalized.map((name, index) => [name, index])) as Record<string, number>
  const plans: PlanRecord[] = []
  const seen = new Set<string>()

  for (const row of table.rows) {
    const id = canonicalId(row.cells[column.plan!], "Plan column")
    if (seen.has(id)) fail(`Duplicate plan ID in ${readme}: ${id}`)
    seen.add(id)
    const file = resolvePlanFile(planDir, row.cells[column.plan!]!, id)
    const indexDependencies = parseDependencies(row.cells[column["depends on"]!])
    const parsedPlan = parsePlanFile(file, id)
    const fileDependencies = parsedPlan.dependencies
    if (JSON.stringify([...indexDependencies].sort()) !== JSON.stringify([...fileDependencies].sort())) {
      fail(`Plan ${id} dependency mismatch: README has [${indexDependencies.join(", ")}], file has [${fileDependencies.join(", ")}]`)
    }
    const parsedStatus = parseStatus(row.cells[column.status!], id)
    plans.push({
      id,
      title: column.title === undefined ? "" : row.cells[column.title]!.replace(/[`*_]/g, "").trim(),
      priority: column.priority === undefined ? "" : row.cells[column.priority]!.trim(),
      effort: column.effort === undefined ? "" : row.cells[column.effort]!.trim(),
      dependencies: indexDependencies,
      status: parsedStatus.status,
      statusDetail: parsedStatus.statusDetail,
      file,
      kind: parsedPlan.kind,
      parentObjective: parsedPlan.parentObjective,
      inScopePaths: parsedPlan.inScopePaths,
      planWords: parsedPlan.planWords,
      planLines: parsedPlan.planLines,
      shapeIssues: parsedPlan.shapeIssues,
      shapeReady: parsedPlan.shapeIssues.length === 0,
    })
  }

  const filesById = new Map<string, string[]>()
  for (const name of fs.readdirSync(planDir).filter((entry) => /^\d{3,}-.*\.md$/i.test(entry))) {
    const id = canonicalId(name, "numbered plan filename")
    const entries = filesById.get(id) ?? []
    entries.push(name)
    filesById.set(id, entries)
  }
  for (const [id, names] of filesById) {
    if (names.length > 1) fail(`Multiple numbered plan files use ID ${id}: ${names.join(", ")}`)
    if (!seen.has(id)) fail(`Numbered plan file is missing from ${readme}: ${names[0]}`)
  }

  plans.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
  const plansById = new Map(plans.map((plan) => [plan.id, plan]))
  for (const plan of plans) {
    for (const dependency of plan.dependencies) {
      if (!plansById.has(dependency)) fail(`Plan ${plan.id} depends on unknown plan ${dependency}`)
      if (dependency === plan.id) fail(`Plan ${plan.id} depends on itself`)
    }
  }

  const cycle = detectCycle(plansById)
  if (cycle) fail(`Dependency cycle: ${cycle.join(" -> ")}`)

  const warnings: string[] = []
  warnings.push(...contextIssues)
  for (const plan of plans) {
    if (plan.status === "DONE") {
      const unfinished = plan.dependencies.filter((id) => plansById.get(id)!.status !== "DONE")
      if (unfinished.length > 0) warnings.push(`Plan ${plan.id} is DONE but dependencies are not DONE: ${unfinished.join(", ")}`)
    }
    for (const issue of plan.shapeIssues) warnings.push(`Plan ${plan.id} shape: ${issue}`)
  }

  const dependenciesByPlan = transitiveDependencies(plansById)
  const overlaps: PlanGraph["overlaps"] = []
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    const left = plans[leftIndex]
    const leftPaths = new Set(left.inScopePaths)
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const right = plans[rightIndex]
      const paths = right.inScopePaths.filter((candidate) => leftPaths.has(candidate))
      if (paths.length === 0) continue
      const ordered = dependenciesByPlan.get(left.id)!.has(right.id)
        || dependenciesByPlan.get(right.id)!.has(left.id)
      overlaps.push({ plans: [left.id, right.id], paths, ordered })
      if (!ordered) {
        warnings.push(`Plans ${left.id} and ${right.id} have unordered overlapping in-scope paths: ${paths.join(", ")}`)
      }
    }
  }

  const ready: string[] = []
  const waiting: PlanGraph["waiting"] = []
  for (const plan of plans) {
    if (!ACTIONABLE.has(plan.status)) continue
    const unsatisfied = plan.dependencies.filter((id) => plansById.get(id)!.status !== "DONE")
    const rejected = unsatisfied.filter((id) => plansById.get(id)!.status === "REJECTED")
    if (plan.status === "TODO" && unsatisfied.length === 0) ready.push(plan.id)
    else if (unsatisfied.length > 0) waiting.push({ id: plan.id, unsatisfied, rejected })
  }

  return {
    planDir,
    readme,
    counts: {
      total: plans.length,
      done: plans.filter((plan) => plan.status === "DONE").length,
      rejected: plans.filter((plan) => plan.status === "REJECTED").length,
      actionable: plans.filter((plan) => ACTIONABLE.has(plan.status)).length,
    },
    plans,
    ready,
    inProgress: plans.filter((plan) => plan.status === "IN PROGRESS").map((plan) => plan.id),
    blocked: plans.filter((plan) => plan.status === "BLOCKED").map((plan) => plan.id),
    waiting,
    waves: buildWaves(plans),
    complete: plans.every((plan) => TERMINAL.has(plan.status)),
    contextFile,
    contextWords,
    contextIssues,
    shapeReady: contextIssues.length === 0 && plans.every((plan) => plan.shapeReady),
    overlaps,
    warnings,
  }
}

function runGit(startDir: string, args: string[], { allowFailure = false }: { allowFailure?: boolean } = {}) {
  const result = spawnSync("git", ["-C", startDir, ...args], { encoding: "utf8" })
  if (result.error) fail(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

interface RepositoryContext { repoRoot: string; planDir: string; relative: string; excludeFile: string; ignorePattern: string }

function repoContext(planDir: string): RepositoryContext {
  const start = fs.existsSync(planDir) ? planDir : path.dirname(planDir)
  const repoRoot = runGit(start, ["rev-parse", "--show-toplevel"]).stdout.trim()
  const resolvedRoot = fs.realpathSync(repoRoot)
  const resolvedPlanDir = fs.existsSync(planDir) ? fs.realpathSync(planDir) : path.resolve(planDir)
  if (!isInside(resolvedRoot, resolvedPlanDir)) {
    fail(`Plan directory must be inside the Git repository: ${resolvedPlanDir}`)
  }
  const relative = path.relative(resolvedRoot, resolvedPlanDir).split(path.sep).join("/")
  const excludeResult = runGit(resolvedRoot, ["rev-parse", "--git-path", "info/exclude"])
  const excludeValue = excludeResult.stdout.trim()
  const excludeFile = path.isAbsolute(excludeValue) ? excludeValue : path.resolve(resolvedRoot, excludeValue)
  return { repoRoot: resolvedRoot, planDir: resolvedPlanDir, relative, excludeFile, ignorePattern: `/${relative}/` }
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
}

function addLocalIgnore(context: RepositoryContext): boolean {
  const lines = readLines(context.excludeFile)
  if (lines.includes(context.ignorePattern)) return false
  fs.mkdirSync(path.dirname(context.excludeFile), { recursive: true })
  const existing = fs.existsSync(context.excludeFile) ? fs.readFileSync(context.excludeFile, "utf8").replace(/\s*$/, "") : ""
  const prefix = existing ? `${existing}\n\n` : ""
  fs.writeFileSync(context.excludeFile, `${prefix}# Herder local coordination plans\n${context.ignorePattern}\n`)
  return true
}

function removeLocalIgnore(context: RepositoryContext): boolean {
  if (!fs.existsSync(context.excludeFile)) return false
  const original = fs.readFileSync(context.excludeFile, "utf8")
  const lines = original.split(/\r?\n/)
  const filtered = lines.filter((line, index) => {
    if (line === context.ignorePattern) return false
    if (line === "# Herder local coordination plans" && lines[index + 1] === context.ignorePattern) return false
    return true
  })
  const next = `${filtered.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "")}\n`
  if (next === original) return false
  fs.writeFileSync(context.excludeFile, next)
  return true
}

function ensureRuntimeIgnore(planDir: string): boolean {
  const file = path.join(planDir, ".gitignore")
  const pattern = ".herder/"
  const lines = readLines(file)
  if (lines.includes(pattern)) return false
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\s*$/, "") : ""
  fs.writeFileSync(file, `${existing ? `${existing}\n` : ""}${pattern}\n`)
  return true
}

function initialReadme(): string {
  return `# Herder Plans

Implementation plans managed by Herder. Each plan snapshot must be self-contained, semantically bounded, and safe to execute from a fresh integration commit. Producers may place verified facts shared by multiple plans in \`CONTEXT.md\`; the Plans manager composes that file into every immutable snapshot.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|

Status values: TODO | IN PROGRESS | DONE | BLOCKED — <reason> | REJECTED — <reason>

## Dependency notes

Add one line for each non-obvious dependency.

## Considered and rejected

Record rejected requests, alternatives, or findings here so later planning does not repeat them.
`
}

export function initPlanDir(inputDir = DEFAULT_PLAN_DIR, { track = false }: { track?: boolean } = {}) {
  const planDir = path.resolve(inputDir)
  fs.mkdirSync(planDir, { recursive: true })
  const context = repoContext(planDir)
  const readme = path.join(planDir, "README.md")
  const createdReadme = !fs.existsSync(readme)
  if (createdReadme) fs.writeFileSync(readme, initialReadme())
  const ignoreChanged = track ? removeLocalIgnore(context) : addLocalIgnore(context)
  const runtimeIgnoreChanged = track ? ensureRuntimeIgnore(planDir) : false
  const execution = initializeExecutionStore(planDir)
  return { planDir, readme, createdReadme, tracking: track ? "tracked" : "local", ignoreChanged, runtimeIgnoreChanged, execution }
}

export function setTracking(inputDir = DEFAULT_PLAN_DIR, track: boolean) {
  const planDir = path.resolve(inputDir)
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) fail(`Plan directory does not exist: ${planDir}`)
  const context = repoContext(planDir)
  if (track) {
    return {
      planDir,
      tracking: "tracked",
      ignoreChanged: removeLocalIgnore(context),
      runtimeIgnoreChanged: ensureRuntimeIgnore(planDir),
    }
  }
  const tracked = runGit(context.repoRoot, ["ls-files", "--", context.relative], { allowFailure: true }).stdout.trim().split(/\r?\n/).filter(Boolean)
  return {
    planDir,
    tracking: "local",
    ignoreChanged: addLocalIgnore(context),
    warning: tracked.length > 0 ? `${tracked.length} tracked plan file(s) remain tracked until removed from the Git index` : "",
  }
}

export interface PlanSnapshot {
  planDir: string
  readme: string
  plan: PlanRecord
  planText: string
  sourcePlanText: string
  contextText: string
  snapshotSha256: string
  snapshotInputs: Array<{ kind: string; file: string; sha256: string }>
  indexText: string
}

function createPlanSnapshot(graph: PlanGraph, plan: PlanRecord, contextText: string, indexText: string): PlanSnapshot {
  const sourcePlanText = fs.readFileSync(plan.file, "utf8")
  const planText = contextText
    ? `<!-- herder-snapshot:shared-context -->\n${contextText.trim()}\n\n<!-- herder-snapshot:local-plan -->\n${sourcePlanText.trim()}\n`
    : sourcePlanText
  const snapshotInputs = [
    ...(graph.contextFile ? [{
      kind: "shared-context",
      file: graph.contextFile,
      sha256: sha256(contextText),
    }] : []),
    {
      kind: "plan",
      file: plan.file,
      sha256: sha256(sourcePlanText),
    },
  ]
  return {
    planDir: graph.planDir,
    readme: graph.readme,
    plan,
    planText,
    sourcePlanText,
    contextText,
    snapshotSha256: sha256(planText),
    snapshotInputs,
    indexText,
  }
}

export function snapshotPlansFromGraph(graph: PlanGraph): PlanSnapshot[] {
  const contextText = graph.contextFile ? fs.readFileSync(graph.contextFile, "utf8") : ""
  const indexText = fs.readFileSync(graph.readme, "utf8")
  return graph.plans.map((plan) => createPlanSnapshot(graph, plan, contextText, indexText))
}

export function snapshotPlanFromGraph(graph: PlanGraph, inputId: unknown): PlanSnapshot {
  const id = canonicalId(inputId)
  const plan = graph.plans.find((candidate) => candidate.id === id)
  if (!plan) fail(`Plan ${id} is not indexed in ${graph.readme}`)
  const contextText = graph.contextFile ? fs.readFileSync(graph.contextFile, "utf8") : ""
  return createPlanSnapshot(graph, plan, contextText, fs.readFileSync(graph.readme, "utf8"))
}

export function snapshotPlan(inputDir = DEFAULT_PLAN_DIR, inputId: unknown): PlanSnapshot {
  return snapshotPlanFromGraph(buildGraph(inputDir), inputId)
}

export function getShapeReport(inputDir = DEFAULT_PLAN_DIR) {
  const graph = buildGraph(inputDir)
  return {
    planDir: graph.planDir,
    contextFile: graph.contextFile,
    contextWords: graph.contextWords,
    contextIssues: graph.contextIssues,
    shapeReady: graph.shapeReady,
    plans: graph.plans.map((plan) => ({
      id: plan.id,
      kind: plan.kind,
      parentObjective: plan.parentObjective,
      inScopePaths: plan.inScopePaths,
      planWords: plan.planWords,
      planLines: plan.planLines,
      shapeReady: plan.shapeReady,
      issues: plan.shapeIssues,
    })),
    overlaps: graph.overlaps,
    warnings: graph.warnings.filter((warning) => warning.includes(" shape:")
      || warning.includes("overlapping in-scope paths")
      || warning.startsWith("Shared context has ")),
  }
}

function formatStatus(status: PlanStatus, detail: string): string {
  if (!SUPPORTED_STATUSES.has(status)) fail(`Unsupported status: ${JSON.stringify(status)}`)
  if (detail && !new Set(["BLOCKED", "REJECTED"]).has(status)) {
    fail(`Only BLOCKED and REJECTED may include a status detail`)
  }
  if (!detail && new Set(["BLOCKED", "REJECTED"]).has(status)) {
    fail(`${status} requires a one-line status detail`)
  }
  if (/[\r\n|]/.test(detail)) fail("Status detail must be one line and cannot contain a table separator")
  return detail ? `${status} — ${detail}` : status
}

export function projectStatuses(inputDir = DEFAULT_PLAN_DIR, projected: Array<{ id: unknown; status: unknown; detail?: unknown }> = []) {
  const planDir = path.resolve(inputDir)
  const readme = path.join(planDir, "README.md")
  if (!fs.existsSync(readme) || !fs.statSync(readme).isFile()) fail(`Plan directory has no README.md: ${planDir}`)
  const byId = new Map(projected.map((entry) => {
    const id = canonicalId(entry.id)
    const status = String(entry.status).trim().toUpperCase().replace(/\s+/g, " ") as PlanStatus
    if (!SUPPORTED_STATUSES.has(status)) fail(`Unsupported projected status: ${JSON.stringify(entry.status)}`)
    return [id, formatStatus(status, String(entry.detail ?? "").trim())]
  }))
  if (byId.size !== projected.length) fail("Projected lifecycle contains duplicate plan IDs")
  const markdown = fs.readFileSync(readme, "utf8")
  const table = findIndexTable(markdown, readme)
  const column = Object.fromEntries(table.normalized.map((name, index) => [name, index])) as Record<string, number>
  const indexed = new Set(table.rows.map((row) => canonicalId(row.cells[column.plan!], "Plan column")))
  for (const id of byId.keys()) if (!indexed.has(id)) fail(`Projected lifecycle contains unknown plan ${id}`)
  for (const row of table.rows) {
    const id = canonicalId(row.cells[column.plan!], "Plan column")
    const status = byId.get(id)
    if (!status) continue
    row.cells[column.status!] = status
    table.lines[row.lineIndex] = `| ${row.cells.join(" | ")} |`
  }
  const nextMarkdown = table.lines.join("\n")
  if (nextMarkdown !== markdown) {
    const temporary = `${readme}.herder-tmp-${process.pid}`
    fs.writeFileSync(temporary, nextMarkdown)
    fs.renameSync(temporary, readme)
  }
  return { planDir, projected: [...byId.keys()].sort() }
}

export function recordUsage(inputDir = DEFAULT_PLAN_DIR, input: UsageRecordInput = {}) {
  const graph = buildGraph(inputDir)
  const requestedPlan = String(input.plan ?? "").trim()
  if (!requestedPlan) fail("Plan cannot be empty")
  const plan = requestedPlan.toUpperCase() === "RUN" ? "RUN" : canonicalId(requestedPlan)
  if (plan !== "RUN" && !graph.plans.some((candidate) => candidate.id === plan)) {
    fail(`Plan ${plan} is not indexed in ${graph.readme}`)
  }
  const stored = recordUsageRecord(graph.planDir, { ...input, plan })
  return {
    planDir: graph.planDir,
    readme: graph.readme,
    database: stored.database,
    recorded: stored.recorded,
    record: stored.record,
    usage: usageReport(stored.records),
  }
}

export function getUsageReport(inputDir = DEFAULT_PLAN_DIR) {
  const graph = buildGraph(inputDir)
  const state = readUsageState(graph.planDir)
  return { planDir: graph.planDir, readme: graph.readme, ...state, ...usageReport(state.records) }
}

export function bindRunProfile(inputDir = DEFAULT_PLAN_DIR, input: RunConfigurationInput = {}) {
  const graph = buildGraph(inputDir)
  return recordRunConfiguration(graph.planDir, input)
}

export function getRunProfile(inputDir = DEFAULT_PLAN_DIR) {
  const graph = buildGraph(inputDir)
  return { planDir: graph.planDir, readme: graph.readme, ...readRunConfiguration(graph.planDir) }
}

export function getExecutionReport(inputDir = DEFAULT_PLAN_DIR, inputPlan = "RUN") {
  const graph = buildGraph(inputDir)
  const requested = String(inputPlan ?? "RUN").trim()
  const plan = requested.toUpperCase() === "RUN" ? "RUN" : canonicalId(requested)
  const planRecord = plan === "RUN" ? null : graph.plans.find((candidate) => candidate.id === plan)
  if (plan !== "RUN" && !planRecord) fail(`Plan ${plan} is not indexed in ${graph.readme}`)
  const state = readUsageState(graph.planDir)
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
    ...executionReport(state.records, plan),
  }
}

function usage(): string {
  return [
    "Usage:",
    "  herder-plans init [plan-dir] [--track] [--pretty]",
    "  herder-plans validate [plan-dir] [--pretty]",
    "  herder-plans shape [plan-dir] [--pretty]",
    "  herder-plans status [plan-dir] [--pretty]",
    "  herder-plans ready [plan-dir] [--pretty]",
    "  herder-plans snapshot <plan-id> [plan-dir] [--pretty]",
    "  herder-plans record-usage <plan-id|RUN> <role> [plan-dir] --attempt <id> --model <model> --effort <effort> --outcome <outcome> [--input-tokens <n|unknown>] [--cached-input-tokens <n|unknown>] [--output-tokens <n|unknown>] [--reasoning-tokens <n|unknown>] [--source <host-source|unknown>] [--round <1..6>] [--generation <id>] [--harness <name>] [--service-tier <tier>] [--started-at <iso>] [--finished-at <iso>] [--duration-ms <n>] [--pretty]",
    "  herder-plans bind-profile [plan-dir] --profile <name> --profile-sha256 <hash> --host pi --roles-json <json> [--pretty]",
    "  herder-plans profile [plan-dir] [--pretty]",
    "  herder-plans usage [plan-dir] [--pretty]",
    "  herder-plans report <plan-id|RUN> [plan-dir] [--pretty]",
    "  herder-plans track [plan-dir] [--pretty]",
    "  herder-plans untrack [plan-dir] [--pretty]",
  ].join("\n")
}

function takeFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index === -1) return null
  if (index === args.length - 1) fail(`${name} requires a value`)
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}

function main(argv: string[]): void {
  const args = [...argv]
  const pretty = args.includes("--pretty")
  const track = args.includes("--track")
  for (const flag of ["--pretty", "--track"]) {
    let index
    while ((index = args.indexOf(flag)) !== -1) args.splice(index, 1)
  }
  const usageOptions = {
    attempt: takeFlag(args, "--attempt"),
    model: takeFlag(args, "--model"),
    effort: takeFlag(args, "--effort"),
    outcome: takeFlag(args, "--outcome"),
    inputTokens: takeFlag(args, "--input-tokens"),
    cachedInputTokens: takeFlag(args, "--cached-input-tokens"),
    outputTokens: takeFlag(args, "--output-tokens"),
    reasoningTokens: takeFlag(args, "--reasoning-tokens"),
    source: takeFlag(args, "--source"),
    round: takeFlag(args, "--round"),
    generation: takeFlag(args, "--generation"),
    harness: takeFlag(args, "--harness"),
    serviceTier: takeFlag(args, "--service-tier"),
    startedAt: takeFlag(args, "--started-at"),
    finishedAt: takeFlag(args, "--finished-at"),
    durationMs: takeFlag(args, "--duration-ms"),
  }
  const profileOptions = {
    profile: takeFlag(args, "--profile"),
    profileSha256: takeFlag(args, "--profile-sha256"),
    host: takeFlag(args, "--host"),
    roles: takeFlag(args, "--roles-json"),
  }
  const hasUsageOptions = Object.values(usageOptions).some((value) => value !== null)
  const hasProfileOptions = Object.values(profileOptions).some((value) => value !== null)
  const unknown = args.filter((argument) => argument.startsWith("--"))
  if (unknown.length > 0) fail(`Unknown option: ${unknown[0]}\n${usage()}`)

  const command = args.shift()
  let result: unknown
  if (command === "init") {
    if (args.length > 1 || hasUsageOptions || hasProfileOptions) fail(usage())
    result = initPlanDir(args[0] ?? DEFAULT_PLAN_DIR, { track })
  } else if (command === "validate" || command === "status") {
    if (args.length > 1 || track || hasUsageOptions || hasProfileOptions) fail(usage())
    result = buildGraph(args[0] ?? DEFAULT_PLAN_DIR)
  } else if (command === "shape") {
    if (args.length > 1 || track || hasUsageOptions || hasProfileOptions) fail(usage())
    result = getShapeReport(args[0] ?? DEFAULT_PLAN_DIR)
  } else if (command === "ready") {
    if (args.length > 1 || track || hasUsageOptions || hasProfileOptions) fail(usage())
    const graph = buildGraph(args[0] ?? DEFAULT_PLAN_DIR)
    result = {
      planDir: graph.planDir,
      ready: graph.ready,
      inProgress: graph.inProgress,
      blocked: graph.blocked,
      waiting: graph.waiting,
      complete: graph.complete,
    }
  } else if (command === "snapshot") {
    if (args.length < 1 || args.length > 2 || track || hasUsageOptions || hasProfileOptions) fail(usage())
    result = snapshotPlan(args[1] ?? DEFAULT_PLAN_DIR, args[0]!)
  } else if (command === "record-usage") {
    if (args.length < 2 || args.length > 3 || track
      || hasProfileOptions || !usageOptions.attempt || !usageOptions.model || !usageOptions.effort || !usageOptions.outcome) fail(usage())
    result = recordUsage(args[2] ?? DEFAULT_PLAN_DIR, {
      plan: args[0],
      role: args[1],
      ...usageOptions,
    })
  } else if (command === "usage") {
    if (args.length > 1 || track || hasUsageOptions || hasProfileOptions) fail(usage())
    result = getUsageReport(args[0] ?? DEFAULT_PLAN_DIR)
  } else if (command === "report") {
    if (args.length < 1 || args.length > 2 || track || hasUsageOptions || hasProfileOptions) fail(usage())
    result = getExecutionReport(args[1] ?? DEFAULT_PLAN_DIR, args[0]!)
  } else if (command === "bind-profile") {
    if (args.length > 1 || track || hasUsageOptions
      || !profileOptions.profile || !profileOptions.profileSha256 || !profileOptions.host || !profileOptions.roles) fail(usage())
    result = bindRunProfile(args[0] ?? DEFAULT_PLAN_DIR, profileOptions)
  } else if (command === "profile") {
    if (args.length > 1 || track || hasUsageOptions || hasProfileOptions) fail(usage())
    result = getRunProfile(args[0] ?? DEFAULT_PLAN_DIR)
  } else if (command === "track" || command === "untrack") {
    if (args.length > 1 || track || hasUsageOptions || hasProfileOptions) fail(usage())
    result = setTracking(args[0] ?? DEFAULT_PLAN_DIR, command === "track")
  } else {
    fail(usage())
  }

  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`herder-plans: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
