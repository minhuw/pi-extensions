/** Derived, inspectable facts only. The immutable Markdown remains assignment authority.
 * Commands/probes are never executed here or converted into manager gate argv.
 * Source evidence, semantic sufficiency, and non-mutating invocation quality still
 * require producer/Validate/reviewer inspection of the compiled snapshot.
 */
export const PLAN_SECTIONS = [
  "Status",
  "Outcome and acceptance",
  "Boundaries",
  "Starting conditions",
  "Implementation route",
  "Verification",
  "Escalation and handoff",
] as const

export type PlanKind = "behavioral" | "mechanical" | "migration" | "spike"
export type VerificationPhase = "development" | "acceptance" | "final"
export interface AcceptanceCriterion { id: string; requiredBehavior: string; proof: string[] }
export interface PlanVerification {
  id: string
  phase: VerificationPhase
  criteria: string[]
  toolchain: string
  command: string
  expected: string
}
export interface PlanToolchain {
  id: string
  owner: string
  cwd: string
  prerequisites: string
  probe: string
  evidence: string
  source: "local" | "shared"
}
export interface PlanContract {
  metadata: {
    priority: "P1" | "P2" | "P3"
    effort: "S" | "M" | "L"
    risk: "LOW" | "MED" | "HIGH"
    dependencies: string[]
    category: string
    plannedAt: string
    kind: PlanKind
    parentObjective: string
  }
  writePaths: string[]
  dependencies: Array<{ plan: string; consumes: string }>
  acceptance: AcceptanceCriterion[]
  verification: PlanVerification[]
  toolchains: PlanToolchain[]
}

const METADATA = ["Priority", "Effort", "Risk", "Depends on", "Category", "Planned at", "Kind", "Parent objective"]
const CATEGORIES = ["feature", "bug", "security", "perf", "tests", "tech-debt", "migration", "dx", "docs", "direction"]
const ACCEPTANCE_COLUMNS = ["ID", "Required behavior", "Proof"]
const VERIFICATION_COLUMNS = ["ID", "Phase", "Criteria", "Toolchain", "Command", "Expected"]
const TOOLCHAIN_COLUMNS = ["ID", "Owner", "Cwd", "Prerequisites", "Probe", "Evidence"]
const DEPENDENCY_COLUMNS = ["Plan", "Consumes"]
const RESERVED_COLUMNS = ["required behavior", "proof", "criteria", "toolchain", "consumes", "cwd", "prerequisites", "probe"]
const MAX_CONTRACT_ROWS = 64

function fail(label: string, message: string): never {
  throw new Error(`${label}: ${message}`)
}

/** Ignore code/comments and reject raw-text HTML blocks rather than binding their examples. */
function structuralLines(text: string, label: string): string[] {
  let fence: { character: string; length: number } | null = null
  let comment = false
  const lines = text.split(/\r?\n/).map((line) => {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null
      return ""
    }
    // Preserve inline code literally (including shell comment-like text).
    let visible = ""
    let rawHtmlBlock: string | undefined
    for (let index = 0; index < line.length;) {
      if (comment) {
        const end = line.indexOf("-->", index)
        if (end < 0) break
        comment = false
        index = end + 3
      } else if (line.startsWith("<!--", index)) {
        comment = true
        index += 4
      } else if (line[index] === "`") {
        const delimiter = line.slice(index).match(/^`+/)![0]
        const end = line.indexOf(delimiter, index + delimiter.length)
        if (end >= 0) {
          visible += line.slice(index, end + delimiter.length)
          index = end + delimiter.length
        } else {
          visible += delimiter
          index += delimiter.length
        }
      } else {
        if (line[index] === "<") rawHtmlBlock ??= line.slice(index).match(/^<(pre|script|style|textarea)(?=[\s/>]|$)/i)?.[1]
        visible += line[index++]
      }
    }
    const opening = visible.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (opening) {
      if (opening[1][0] === "`" && opening[2].includes("`")) fail(label, "malformed code fence")
      fence = { character: opening[1][0], length: opening[1].length }
      return ""
    }
    if (/^(?: {4}|\t)/.test(visible)) return ""
    if (rawHtmlBlock) fail(label, `unsupported raw HTML block <${rawHtmlBlock}>; use fenced code for examples`)
    return visible
  })
  if (fence) fail(label, "unterminated code fence")
  if (comment) fail(label, "unterminated HTML comment")
  return lines
}

function nonempty(value: string): boolean {
  return value.replace(/[`*_\s]/g, "").length > 0
}

function sections(lines: string[], label: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const line of lines) {
    const heading = line.match(/^ {0,3}##(?:\s+(.+?))?\s*$/)
    if (heading) {
      const name = (heading[1] ?? "").replace(/\s+#+\s*$/, "").trim()
      if (!(PLAN_SECTIONS as readonly string[]).includes(name)) fail(label, `unexpected heading "## ${name}"`)
      if (result.has(name)) fail(label, `duplicate heading "## ${name}"`)
      result.set(name, [])
    } else if (result.size) {
      const current = [...result.values()].at(-1)!
      current.push(line)
    }
  }
  for (const heading of PLAN_SECTIONS) {
    if (!result.has(heading)) fail(label, `missing required heading "## ${heading}"`)
    if (!nonempty(result.get(heading)!.join("\n"))) fail(label, `empty section "## ${heading}"`)
  }
  if (JSON.stringify([...result.keys()]) !== JSON.stringify(PLAN_SECTIONS)) fail(label, "required sections are out of order")
  return result
}

function tableRow(line: string): string[] | null {
  const cells: string[] = []
  let cell = ""
  let separated = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === "\\" && (line[index + 1] === "|" || line[index + 1] === "\\")) {
      // GFM tables escape pipes even inside code spans. Preserve other escapes.
      const next = line[++index]
      cell += next === "|" ? next : "\\\\"
    } else if (character === "|") {
      cells.push(cell.trim())
      cell = ""
      separated = true
    } else cell += character
  }
  if (!separated) return null
  cells.push(cell.trim())
  if (line.trimStart().startsWith("|")) cells.shift()
  if (line.trimEnd().endsWith("|") && cells.at(-1) === "") cells.pop()
  return cells
}

interface Table { columns: string[]; rows: string[][] }
function tables(lines: string[], label: string): Table[] {
  const result: Table[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const columns = tableRow(lines[index])
    const separator = tableRow(lines[index + 1] ?? "")
    const isSeparator = (row: string[] | null) => row !== null && row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell))
    if (!columns || (!lines[index].trimStart().startsWith("|") && !isSeparator(separator))) continue
    if (!isSeparator(separator) || separator!.length !== columns.length) fail(label, "malformed table header or separator")
    const rows: string[][] = []
    index += 2
    for (; index < lines.length; index += 1) {
      const row = tableRow(lines[index])
      if (!row) break
      if (row.length !== columns.length || row.some((cell) => !nonempty(cell)) || isSeparator(row)) {
        fail(label, "malformed or empty table row")
      }
      rows.push(row)
    }
    if (!rows.length) fail(label, `empty table: ${columns.join(" | ")}`)
    result.push({ columns, rows })
    index -= 1
  }
  return result
}

function sameColumns(actual: string[], expected: string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function onlyTable(found: Table[], columns: string[], label: string, required = true): Table | undefined {
  const matching = found.filter((table) => sameColumns(table.columns, columns))
  if (matching.length > 1 || (required && matching.length !== 1)) {
    fail(label, `requires exactly one table with columns: ${columns.join(" | ")}`)
  }
  return matching[0]
}

function isContractTable(table: Table): boolean {
  return table.columns.some((column) => RESERVED_COLUMNS.includes(column.toLowerCase()))
    || table.rows.some((row) => /^[AVT][0-9]/.test(row[0]))
}

function checkTables(found: Table[], allowed: string[][], label: string): void {
  for (const table of found) {
    if (isContractTable(table) && !allowed.some((columns) => sameColumns(table.columns, columns))) {
      fail(label, `unexpected table columns: ${table.columns.join(" | ")}`)
    }
  }
}

function identifier(value: string, prefix: "A" | "V" | "T", label: string): string {
  if (!new RegExp(`^${prefix}[1-9][0-9]*$`).test(value) || !Number.isSafeInteger(Number(value.slice(1)))) fail(label, `invalid ${prefix} ID ${JSON.stringify(value)}`)
  return value
}

function references(value: string, prefix: "A" | "V", label: string, allowNone = false): string[] {
  if (allowNone && value === "none") return []
  const values = value.split(",")
  if (values.length > MAX_CONTRACT_ROWS) fail(label, `at most ${MAX_CONTRACT_ROWS} ${prefix} references are allowed`)
  const ids = values.map((id) => identifier(id.trim(), prefix, label))
  if (new Set(ids).size !== ids.length) fail(label, `duplicate ${prefix} reference`)
  return ids
}

function uniqueIds(rows: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>()
  for (const { id } of rows) {
    if (seen.has(id)) fail(label, `duplicate ID ${id}${id.startsWith("T") ? "; toolchains cannot shadow shared definitions" : ""}`)
    seen.add(id)
  }
}

function dependencyId(value: string, label: string): string {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail(label, `invalid numeric dependency ID ${JSON.stringify(value)}`)
  return String(Number(value)).padStart(3, "0")
}

export function parseDependencyIds(value: string, label = "Dependencies"): string[] {
  if (value === "none") return []
  const ids = value.split(",").map((id) => dependencyId(id.trim(), label))
  if (new Set(ids).size !== ids.length) fail(label, "duplicate dependency ID")
  return ids
}

/** Lexical safety only: future dependency-provided paths need not exist yet. */
export function validateRepositoryPath(value: string, { cwd = false, label = "Path" }: { cwd?: boolean; label?: string } = {}): string {
  if (cwd && value === ".") return value
  if (!value || value !== value.trim() || /^[\/~]/.test(value) || /[\\:*?\[\]{}$`%\x00-\x1f\x7f]/.test(value)
    || /[!+@]\(/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".herder")) {
    fail(label, `unsafe ${cwd ? "Cwd" : "write path"} ${JSON.stringify(value)}; use a clean exact repository-relative ${cwd ? "directory or '.'" : "file path"}`)
  }
  return value
}

function plainCode(value: string): string {
  const match = value.match(/^(`+)([\s\S]*?)\1$/)
  return match ? match[2] : value
}

function toolchains(table: Table | undefined, source: PlanToolchain["source"], label: string): PlanToolchain[] {
  if ((table?.rows.length ?? 0) > MAX_CONTRACT_ROWS) fail(label, `at most ${MAX_CONTRACT_ROWS} toolchain definitions are allowed`)
  const rows = (table?.rows ?? []).map(([id, owner, cwd, prerequisites, probe, evidence]) => ({
    id: identifier(id, "T", label), owner, cwd: validateRepositoryPath(plainCode(cwd), { cwd: true, label }), prerequisites, probe, evidence, source,
  }))
  uniqueIds(rows, label)
  return rows
}

export function parseSharedToolchains(text: string, label = "CONTEXT.md"): PlanToolchain[] {
  const found = tables(structuralLines(text, label), label)
  // Other factual tables are fine; plan-local A/V/Consumes facts cannot move here.
  checkTables(found, [TOOLCHAIN_COLUMNS], label)
  return toolchains(onlyTable(found, TOOLCHAIN_COLUMNS, label, false), "shared", label)
}

function markedParts(lines: string[], names: string[], label: string): Map<string, string[]> {
  const positions = names.map((name) => {
    const matches = lines.flatMap((line, index) => line.match(new RegExp(`^ {0,3}\\*\\*${name}\\*\\*(?::)?(?:[ \\t].*)?$`)) ? [index] : [])
    if (matches.length !== 1) fail(label, `requires exactly one **${name}** marker`)
    return matches[0]
  })
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) fail(label, `${names.join(", ")} markers are out of order`)
  return new Map(names.map((name, index) => {
    const inline = lines[positions[index]].replace(new RegExp(`^ {0,3}\\*\\*${name}\\*\\*(?::)?[ \\t]*`), "")
    const content = [inline, ...lines.slice(positions[index] + 1, positions[index + 1] ?? lines.length)]
    if (!nonempty(content.join("\n"))) fail(label, `empty **${name}**`)
    return [name, content]
  }))
}

export function parsePlanContract(text: string, { sharedToolchains = [], label = "Plan" }: { sharedToolchains?: readonly PlanToolchain[]; label?: string } = {}): PlanContract {
  const lines = structuralLines(text, label)
  const parts = sections(lines, label)
  const firstSection = lines.findIndex((line) => /^ {0,3}##\s/.test(line))
  checkTables(tables(lines.slice(0, firstSection), label), [], label)
  const get = (name: typeof PLAN_SECTIONS[number]) => parts.get(name)!
  const metadata = new Map<string, string>()
  for (const line of get("Status")) {
    const match = line.match(/^\s*[-*]\s+\*\*([^*]+)\*\*:\s*(.*?)\s*$/)
    if (!match) continue
    if (!METADATA.includes(match[1])) fail(label, `unexpected metadata "${match[1]}"`)
    if (metadata.has(match[1])) fail(label, `duplicate metadata "${match[1]}"`)
    if (!nonempty(match[2])) fail(label, `empty metadata "${match[1]}"`)
    metadata.set(match[1], match[2])
  }
  for (const field of METADATA) if (!metadata.has(field)) fail(label, `missing required metadata "${field}" in Status`)
  const field = (name: string) => metadata.get(name)!
  const choice = <T extends string>(name: string, choices: readonly T[]): T => {
    const value = field(name)
    if (!choices.includes(value as T)) fail(label, `unsupported ${name} ${JSON.stringify(value)}`)
    return value as T
  }
  const dependencies = parseDependencyIds(field("Depends on"), label)
  if (!/\bcommit\s+(?:`[a-f0-9]{7,64}`|[a-f0-9]{7,64})(?=[\s,;.]|$)/i.test(field("Planned at")) || !/\b\d{4}-\d{2}-\d{2}\b/.test(field("Planned at"))) {
    fail(label, "Planned at requires repository commit and YYYY-MM-DD evidence")
  }
  const boundaryParts = markedParts(get("Boundaries"), ["Write paths", "Out of scope"], label)
  const writePaths = [...boundaryParts.get("Write paths")!.join("\n").matchAll(/`([^`\r\n]+)`/g)]
    .map((match) => validateRepositoryPath(match[1], { label }))
  if (!writePaths.length) fail(label, "Write paths requires backticked exact repository-relative file paths")
  if (new Set(writePaths).size !== writePaths.length) fail(label, "duplicate write path")
  const startingParts = markedParts(get("Starting conditions"), ["Observed baseline", "Required starting state", "Expected dependency changes"], label)

  const sectionTables = new Map([...parts].map(([name, lines]) => [name, tables(lines, label)]))
  for (const [name, found] of sectionTables) {
    const allowed = name === "Outcome and acceptance" ? [ACCEPTANCE_COLUMNS]
      : name === "Verification" ? [VERIFICATION_COLUMNS, TOOLCHAIN_COLUMNS]
      : name === "Starting conditions" ? [DEPENDENCY_COLUMNS] : []
    checkTables(found, allowed, label)
  }
  const acceptanceTable = onlyTable(sectionTables.get("Outcome and acceptance")!, ACCEPTANCE_COLUMNS, label)!
  const verificationTable = onlyTable(sectionTables.get("Verification")!, VERIFICATION_COLUMNS, label)!
  if (acceptanceTable.rows.length > MAX_CONTRACT_ROWS || verificationTable.rows.length > MAX_CONTRACT_ROWS) fail(label, "at most 64 acceptance criteria and 64 verification rows are allowed")
  const acceptance: AcceptanceCriterion[] = acceptanceTable.rows.map(([id, requiredBehavior, proof]) => ({
    id: identifier(id, "A", label), requiredBehavior, proof: references(proof, "V", label),
  }))
  const verification: PlanVerification[] = verificationTable.rows.map(([id, phase, criteria, toolchain, command, expected]) => {
    if (!["development", "acceptance", "final"].includes(phase)) fail(label, `unknown verification phase ${JSON.stringify(phase)}`)
    return { id: identifier(id, "V", label), phase: phase as VerificationPhase, criteria: references(criteria, "A", label, true), toolchain: identifier(toolchain, "T", label), command, expected }
  })
  const localToolchains = toolchains(onlyTable(sectionTables.get("Verification")!, TOOLCHAIN_COLUMNS, label, false), "local", label)
  const combinedToolchains = [...sharedToolchains.map((entry) => ({ ...entry })), ...localToolchains]
  uniqueIds(acceptance, label)
  uniqueIds(verification, label)
  uniqueIds(combinedToolchains, label)
  if (combinedToolchains.length > MAX_CONTRACT_ROWS) fail(label, `at most ${MAX_CONTRACT_ROWS} combined toolchain definitions are allowed`)
  const criteriaById = new Map(acceptance.map((criterion) => [criterion.id, criterion]))
  const verificationById = new Map(verification.map((row) => [row.id, row]))
  const toolchainIds = new Set(combinedToolchains.map((row) => row.id))
  for (const row of verification) {
    if (!toolchainIds.has(row.toolchain)) fail(label, `${row.id} references unknown toolchain ${row.toolchain}`)
    for (const criterion of row.criteria) {
      if (!criteriaById.has(criterion)) fail(label, `${row.id} references unknown criterion ${criterion}`)
      if (!criteriaById.get(criterion)!.proof.includes(row.id)) fail(label, `${row.id}.Criteria and ${criterion}.Proof must refer back to each other`)
    }
  }
  for (const criterion of acceptance) {
    for (const proof of criterion.proof) {
      const row = verificationById.get(proof)
      if (!row) fail(label, `${criterion.id} references unknown proof ${proof}`)
      if (!row.criteria.includes(criterion.id)) fail(label, `${criterion.id}.Proof and ${proof}.Criteria must refer back to each other`)
    }
    if (!criterion.proof.some((proof) => verificationById.get(proof)!.phase === "acceptance")) fail(label, `${criterion.id} requires an acceptance-phase proof (development/final alone cannot gate completion)`)
  }

  const dependencyTables = sectionTables.get("Starting conditions")!.filter((table) => sameColumns(table.columns, DEPENDENCY_COLUMNS))
  const declaresNone = [...get("Starting conditions"), ...[...startingParts.values()].flat()]
    .some((line) => /^\s*Dependencies:\s*none\.\s*$/.test(line))
  let consumes: PlanContract["dependencies"] = []
  if (dependencies.length) {
    const table = onlyTable(dependencyTables, DEPENDENCY_COLUMNS, label)!
    consumes = table.rows.map(([plan, guarantee]) => ({ plan: dependencyId(plan, label), consumes: guarantee }))
    if (new Set(consumes.map((row) => row.plan)).size !== consumes.length) fail(label, "duplicate dependency Consumes row")
    if (JSON.stringify(consumes.map((row) => row.plan).sort()) !== JSON.stringify([...dependencies].sort())) fail(label, "dependency Consumes rows must agree exactly with declared direct dependencies")
    if (declaresNone) fail(label, "Dependencies: none contradicts declared dependencies")
  } else {
    if (dependencyTables.length) fail(label, "dependency Consumes rows require declared dependencies")
    if (!declaresNone) fail(label, "Starting conditions requires 'Dependencies: none.'")
  }
  return {
    metadata: {
      priority: choice("Priority", ["P1", "P2", "P3"]), effort: choice("Effort", ["S", "M", "L"]), risk: choice("Risk", ["LOW", "MED", "HIGH"]),
      dependencies, category: choice("Category", CATEGORIES), plannedAt: field("Planned at"), kind: choice("Kind", ["behavioral", "mechanical", "migration", "spike"]), parentObjective: field("Parent objective"),
    },
    writePaths, dependencies: consumes, acceptance, verification, toolchains: combinedToolchains,
  }
}
