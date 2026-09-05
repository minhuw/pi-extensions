import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import { parsePlanContract, parseSharedToolchains, validateRepositoryPath, PLAN_SECTIONS } from "../../../src/core/plan-contract.ts"

const acceptance = `| ID | Required behavior | Proof |
| --- | --- | --- |
| A1 | Preserve the exact source bytes during inspection | V1 |`
const verification = `| ID | Phase | Criteria | Toolchain | Command | Expected |
| --- | --- | --- | --- | --- | --- |
| V1 | acceptance | A1 | T1 | \`npm run test:herder\` | exit 0; source-preservation cases pass |`
const toolchain = `| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
| --- | --- | --- | --- | --- | --- |
| T1 | npm project scripts | . | Node >=22.19; locked dependencies installed | \`node --version\` | \`package.json\`; \`package-lock.json\`; AGENTS.md |`
const dependency = `| Plan | Consumes |
| --- | --- |
| 002 | Upstream has introduced the additive inspection API, preserving old callers |`
const source = `# Plan 001: Preserve source bytes

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-15
- **Kind**: behavioral
- **Parent objective**: Keep source-preserving inspections reliable

## Outcome and acceptance

Binding decision: reading source must preserve its bytes.

${acceptance}

## Boundaries

**Write paths**:
- \`src/inspect.ts\`
- \`tests/inspect.test.ts\`

**Out of scope**:
- Source writers. Preserve inspect callers and review direct inspection tests.

## Starting conditions

**Observed baseline**:
The current readSource anchor exposes the source bytes.

**Required starting state**:
The same byte-preservation invariant holds at execution time.

**Expected dependency changes**:
Dependencies: none.

## Implementation route

Suggested: characterize readSource in src/inspect.ts, then implement A1 and prove it with V1.

## Verification

${verification}

${toolchain}

## Escalation and handoff

Stop if source ownership changes. Report environment/command/cwd failures without guessing.
Provide unchanged source bytes to downstream callers; keep integration usable. Defer writer changes.
`

function replaced(before: string, after: string): string {
  assert.ok(source.includes(before), `unknown replacement ${before}`)
  return source.replace(before, after)
}
function rejects(text: string, expected: RegExp): void {
  assert.throws(() => parsePlanContract(text), expected)
}

test("parses stable IDs and preserves command/probe evidence without making executable gates", () => {
  const contract = parsePlanContract(source)
  assert.deepEqual(contract.metadata, {
    priority: "P1", effort: "S", risk: "LOW", dependencies: [], category: "tests",
    plannedAt: "commit `abc1234`, 2026-07-15", kind: "behavioral", parentObjective: "Keep source-preserving inspections reliable",
  })
  assert.deepEqual(contract.acceptance, [{ id: "A1", requiredBehavior: "Preserve the exact source bytes during inspection", proof: ["V1"] }])
  assert.deepEqual(contract.writePaths, ["src/inspect.ts", "tests/inspect.test.ts"])
  assert.deepEqual(contract.dependencies, [])
  assert.deepEqual(contract.verification, [{ id: "V1", phase: "acceptance", criteria: ["A1"], toolchain: "T1", command: "`npm run test:herder`", expected: "exit 0; source-preservation cases pass" }])
  assert.equal(contract.toolchains[0].source, "local")
  assert.equal(contract.toolchains[0].probe, "`node --version`")
  assert.equal(contract.toolchains[0].cwd, ".")
  assert.equal(Object.hasOwn(contract.verification[0], "argv"), false)
  // The parser stores even shell text literally; it grants no execution authority.
  const shell = "`printf x \\| cat; $(not-a-real-command); <!-- shell text -->`"
  assert.equal(parsePlanContract(replaced("`npm run test:herder`", shell)).verification[0].command, shell.replace("\\|", "|"))
})

test("accepts non-contiguous stable IDs, all phases, and non-criterion diagnostics", () => {
  const text = source.replaceAll("A1", "A27").replaceAll("V1", "V42").replaceAll("T1", "T9")
    .replace("\n| V42 |", "\n| V2 | development | none | T9 | `npm run typecheck` | exit 0 |\n| V42 |")
    .replace("\n\n" + toolchain.replaceAll("T1", "T9"), "\n| V64 | final | none | T9 | `npm test` | exit 0 |\n\n" + toolchain.replaceAll("T1", "T9"))
  assert.deepEqual(parsePlanContract(text).verification.map((row) => [row.id, row.phase, row.criteria]), [
    ["V2", "development", []], ["V42", "acceptance", ["A27"]], ["V64", "final", []],
  ])
})

test("requires exactly seven unique nonempty ordered real sections", () => {
  for (const heading of PLAN_SECTIONS) {
    rejects(replaced(`## ${heading}`, `<!-- ## ${heading} -->`), /missing required heading/)
    rejects(replaced(`## ${heading}`, `\`\`\`md\n## ${heading}\n\`\`\``), /missing required heading/)
    rejects(replaced(`## ${heading}`, `~~~md\n## ${heading}\n~~~`), /missing required heading/)
    rejects(replaced(`## ${heading}`, `    ## ${heading}`), /missing required heading/)
    rejects(replaced(`## ${heading}`, `## ${heading}\n\n## ${heading}`), /duplicate heading/)
    const empty = source.replace(new RegExp(`(## ${heading}\\n)[\\s\\S]*?(?=\\n## |$)`), "$1\n<!-- empty -->\n```\nexample only\n```\n")
    rejects(empty, /empty section/)
  }
  rejects(source + "\n## Git workflow\nLegacy boilerplate", /unexpected heading/)
  rejects(source.replace("## Status", "## temporary").replace("## Boundaries", "## Status").replace("## temporary", "## Boundaries"), /out of order/)
  rejects(source + "\n```\n", /unterminated code fence/)
  rejects(source + "\n<!--", /unterminated HTML comment/)
  assert.doesNotThrow(() => parsePlanContract(source + "\n```md\n## Status\n" + acceptance + "\n```\n"))
  assert.doesNotThrow(() => parsePlanContract(source.replaceAll("## ", "  ## ")))
})

test("rejects missing, duplicate, empty, malformed, misplaced and unsupported metadata", () => {
  for (const [before, after, error] of [
    ["- **Kind**: behavioral", "", /missing required metadata/],
    ["- **Kind**: behavioral", "- **Kind**: behavioral\n- **Kind**: spike", /duplicate metadata/],
    ["- **Parent objective**: Keep source-preserving inspections reliable", "- **Parent objective**:", /empty metadata/],
    ["- **Kind**: behavioral", "- Kind: behavioral", /missing required metadata/],
    ["- **Kind**: behavioral", "```\n- **Kind**: behavioral\n```", /missing required metadata/],
    ["- **Priority**: P1", "- **Priority**: P4", /unsupported Priority/],
    ["- **Effort**: S", "- **Effort**: XL", /unsupported Effort/],
    ["- **Risk**: LOW", "- **Risk**: HUGE", /unsupported Risk/],
    ["- **Kind**: behavioral", "- **Kind**: coding", /unsupported Kind/],
    ["- **Category**: tests", "- **Category**: arbitrary", /unsupported Category/],
    ["commit `abc1234`, 2026-07-15", "unknown baseline", /Planned at/],
  ] as const) rejects(replaced(before, after), error)
  rejects(source.replace("- **Kind**: behavioral\n", "") + "\n- **Kind**: behavioral", /missing required metadata/)
  rejects(replaced("- **Kind**: behavioral", "- **Kind**: behavioral\n- **Review budget**: legacy"), /unexpected metadata/)
})

test("A/V/T tables reject missing, empty, duplicate, malformed, fenced and misplaced definitions", () => {
  for (const table of [acceptance, verification, toolchain]) {
    rejects(replaced(table, "No table."), /requires exactly one table|unknown toolchain/)
    rejects(replaced(table, table.split("\n").slice(0, 2).join("\n")), /empty table/)
    rejects(replaced(table, `${table}\n\n${table}`), /requires exactly one table/)
    rejects(replaced(table, table.replace("---", "--")), /malformed table/)
    rejects(replaced(table, table.replace("| ID |", "| Identifier |")), /unexpected table columns/)
    rejects(replaced(table, table.replace("\n| ---", "\n| --- | ---")), /malformed table/)
    rejects(replaced(table, `${table}\n| too | few |`), /malformed or empty table row/)
    rejects(replaced(table, `${table}\n${table.split("\n")[2]}`), /duplicate ID/)
    for (const fence of ["```", "~~~"]) rejects(replaced(table, `${fence}md\n${table}\n${fence}`), /requires exactly one table|unknown toolchain/)
    rejects(source.replace(table, "No table.") + "\n" + table, /unexpected table columns/)
    rejects(replaced("## Status", `${table}\n\n## Status`), /unexpected table columns/)
  }
  for (const [before, after] of [
    ["| A1 | Preserve", "| A0 | Preserve"], ["| V1 | acceptance", "| V01 | acceptance"], ["| T1 | npm", "| T0 | npm"],
    ["| Preserve the exact source bytes during inspection |", "| |"], ["| `npm run test:herder` |", "| `` |"],
    ["| exit 0; source-preservation cases pass |", "| |"], ["| npm project scripts |", "| |"],
    ["| Node >=22.19; locked dependencies installed |", "| |"], ["| `node --version` |", "| |"],
    ["| `package.json`; `package-lock.json`; AGENTS.md |", "| |"],
  ]) rejects(replaced(before, after), /invalid [AVT] ID|malformed or empty table row/)
})

test("rejects raw HTML wrappers around local and shared A/V/T tables", () => {
  for (const tag of ["pre", "script", "style", "textarea"]) {
    for (const opening of [`<${tag}>`, `<${tag}/>`, `   <${tag.toUpperCase()} class="example">`, `<${tag}\nclass="example">`]) {
      for (const table of [acceptance, verification, toolchain]) {
        const wrapped = `${opening}\n${table}\n</${tag}>`
        rejects(replaced(table, wrapped), /unsupported raw HTML block/)
        assert.throws(() => parseSharedToolchains(wrapped), /unsupported raw HTML block/)
      }
    }
  }
})

test("preserves HTML literals and redirections in inline code and nonbinding examples", () => {
  for (const tag of ["pre", "script", "style", "textarea"]) {
    for (const delimiter of ["`", "``"]) {
      const command = `${delimiter}printf '<${tag}>' < input > output${delimiter}`
      assert.equal(parsePlanContract(replaced("`npm run test:herder`", command)).verification[0].command, command)
      assert.equal(parseSharedToolchains(toolchain.replace("`node --version`", command))[0].probe, command)
    }
    const example = `<${tag}>\n${acceptance}\n${verification}\n${toolchain}\n</${tag}>`
    for (const ignored of [
      `\`\`\`html\n${example}\n\`\`\``,
      `~~~html\n${example}\n~~~`,
      `\`\`\`html <${tag}>\n${example}\n\`\`\``,
      `<!--\n${example}\n-->`,
      example.split("\n").map((line) => `    ${line}`).join("\n"),
    ]) {
      assert.deepEqual(parsePlanContract(source + "\n" + ignored), parsePlanContract(source))
      assert.deepEqual(parseSharedToolchains(ignored), [])
    }
  }
})

test("fails closed on dangling, duplicate, non-reciprocal and invalid A/V/T references", () => {
  for (const [before, after, error] of [
    ["inspection | V1 |", "inspection | V9 |", /refer back|unknown proof/],
    ["inspection | V1 |", "inspection | V1, V1 |", /duplicate V reference/],
    ["inspection | V1 |", "inspection | none |", /invalid V ID/],
    ["inspection | V1 |", "inspection | V1, |", /invalid V ID/],
    ["| acceptance | A1 |", "| acceptance | A9 |", /unknown criterion/],
    ["| acceptance | A1 |", "| acceptance | A1, A1 |", /duplicate A reference/],
    ["| acceptance | A1 |", "| acceptance | none |", /refer back/],
    ["| A1 | T1 |", "| A1 | T2 |", /unknown toolchain/],
    ["| A1 | T1 |", "| A1 | T1, T2 |", /invalid T ID/],
    ["| acceptance |", "| later |", /unknown verification phase/],
    ["| acceptance |", "| final |", /acceptance-phase proof/],
    ["| acceptance |", "| development |", /acceptance-phase proof/],
  ] as const) rejects(replaced(before, after), error)
  rejects(replaced(verification, verification + "\n| V2 | final | A1 | T1 | `npm test` | exit 0 |"), /refer back/)
  const multiple = replaced(verification, verification + "\n| V2 | final | A1 | T1 | `npm test` | exit 0 |").replace("inspection | V1 |", "inspection | V1, V2 |")
  assert.deepEqual(parsePlanContract(multiple).acceptance[0].proof, ["V1", "V2"])
})

test("bounds acceptance and verification tables at 64 rows", () => {
  const many = (count: number) => source.replace(acceptance, acceptance.split("\n").slice(0, 2).join("\n") + "\n" + Array.from({ length: count }, (_, i) => `| A${i + 1} | observable ${i} | V${i + 1} |`).join("\n"))
    .replace(verification, verification.split("\n").slice(0, 2).join("\n") + "\n" + Array.from({ length: count }, (_, i) => `| V${i + 1} | acceptance | A${i + 1} | T1 | command ${i} | observation ${i} |`).join("\n"))
  assert.equal(parsePlanContract(many(64)).acceptance.length, 64)
  rejects(many(65), /at most 64/)
})

test("safe write/cwd paths are lexical and need not exist before dependencies integrate", () => {
  for (const unsafe of ["/tmp/out", "../out", "src/../../out", "./src/out", "src/../out", "src//out", "src/", "src/*", "src/?.ts", "src/[ab].ts", "src/{a,b}.ts", "src/!(a).ts", "src/+(a).ts", "src/@(a).ts", "C:/out", "C:\\out", "\\\\server\\out", "~/out", "$HOME/out", "src/%2e%2e/out", "src/\u0000out", ".git/config", ".herder/execution.sqlite3", " src/out"]) {
    assert.throws(() => validateRepositoryPath(unsafe), /unsafe write path/, unsafe)
    assert.throws(() => validateRepositoryPath(unsafe, { cwd: true }), /unsafe Cwd/, unsafe)
    rejects(replaced("src/inspect.ts", unsafe), /unsafe write path/)
    rejects(replaced("| . |", `| \`${unsafe}\` |`), /unsafe Cwd|malformed/)
  }
  assert.throws(() => validateRepositoryPath("."), /unsafe write path/)
  assert.equal(validateRepositoryPath(".", { cwd: true }), ".")
  for (const clean of ["new/module.ts", "AGENTS.md", "LICENSE", "src/file with spaces.ts"]) assert.equal(validateRepositoryPath(clean), clean)
  assert.equal(parsePlanContract(replaced("| . |", "| future/package |" )).toolchains[0].cwd, "future/package")
  rejects(replaced("- `src/inspect.ts`", "- `src/inspect.ts`\n- `src/inspect.ts`"), /duplicate write path/)
  rejects(source.replace("- `src/inspect.ts`", "").replace("- `tests/inspect.test.ts`", "No writes listed"), /requires backticked/)
  assert.deepEqual(parsePlanContract(replaced("- Source writers.", "- `/outside/scope` Source writers.")).writePaths, ["src/inspect.ts", "tests/inspect.test.ts"])
})

test("starting-state markers and direct dependency consumes agree, without claiming upstream changes already exist", () => {
  const dependent = source.replace("- **Depends on**: none", "- **Depends on**: 2").replace("Dependencies: none.", dependency)
  assert.deepEqual(parsePlanContract(dependent).dependencies, [{ plan: "002", consumes: "Upstream has introduced the additive inspection API, preserving old callers" }])
  assert.deepEqual(parsePlanContract(dependent).metadata.dependencies, ["002"])
  rejects(dependent.replace("| 002 |", "| 003 |"), /agree exactly/)
  rejects(dependent.replace("| 002 |", "| plan-002.md |"), /invalid numeric dependency/)
  rejects(dependent.replace(dependency, dependency + "\n| 2 | Another guarantee |"), /duplicate dependency Consumes/)
  rejects(dependent.replace(dependency, dependency + "\n| 003 | Undeclared guarantee |"), /agree exactly/)
  rejects(dependent.replace("Upstream has introduced the additive inspection API, preserving old callers", ""), /empty table row/)
  rejects(dependent.replace(dependency, "No table."), /requires exactly one table/)
  rejects(replaced("Dependencies: none.", dependency), /require declared dependencies/)
  rejects(dependent.replace("- **Depends on**: 2", "- **Depends on**: 2, 002"), /duplicate dependency ID/)
  rejects(dependent.replace("- **Depends on**: 2", "- **Depends on**: herder-plans/002-*.md"), /invalid numeric dependency/)
  rejects(dependent.replace(dependency, "Dependencies: none.\n" + dependency), /contradicts/)
  assert.doesNotThrow(() => parsePlanContract(dependent.replace(dependency, "Expected API.").replace("**Required starting state**:", dependency + "\n\n**Required starting state**:")))
  rejects(replaced("Dependencies: none.", "Nothing."), /Dependencies: none/)
  for (const marker of ["Write paths", "Out of scope", "Observed baseline", "Required starting state", "Expected dependency changes"]) {
    rejects(replaced(`**${marker}**:`, `~~${marker}~~:`), /requires exactly one/)
    rejects(replaced(`**${marker}**:`, `**${marker}**:\n\n**${marker}**:`), /requires exactly one/)
  }
})

test("shared toolchains compose once, with no local shadowing even for identical definitions", () => {
  const shared = parseSharedToolchains("# Shared context\n\n" + toolchain)
  assert.equal(shared[0].source, "shared")
  const local = source.replace(toolchain, "Toolchains are defined in shared context.")
  const contract = parsePlanContract(local, { sharedToolchains: shared })
  assert.deepEqual(contract.toolchains, shared)
  assert.notEqual(contract.toolchains[0], shared[0])
  assert.throws(() => parsePlanContract(source, { sharedToolchains: shared }), /duplicate ID T1/)
  assert.throws(() => parseSharedToolchains(toolchain + "\n\n" + toolchain), /requires exactly one table/)
  assert.throws(() => parseSharedToolchains(toolchain + "\n" + toolchain.split("\n")[2]), /duplicate ID/)
  assert.throws(() => parseSharedToolchains(toolchain.replace("| Owner |", "| Manager |")), /unexpected table columns/)
  assert.throws(() => parseSharedToolchains(toolchain.replace("| . |", "| ../package |")), /unsafe Cwd/)
  assert.deepEqual(parseSharedToolchains("```md\n" + toolchain + "\n```"), [])
  assert.deepEqual(parseSharedToolchains("<!--\n" + toolchain + "\n-->"), [])
  assert.throws(() => parsePlanContract(local, { sharedToolchains: [] }), /unknown toolchain/)
  const distinct = parsePlanContract(source.replaceAll("T1", "T2"), { sharedToolchains: shared })
  assert.deepEqual(distinct.toolchains.map((row) => [row.id, row.source]), [["T1", "shared"], ["T2", "local"]])
  assert.deepEqual(parseSharedToolchains("| Fact | Evidence |\n| --- | --- |\n| Package | package.json |"), [])
})

test("legacy plan headings and branch boilerplate cannot substitute for V2 structure", () => {
  rejects("# Plan 001: Legacy\n\n## Status\n- **Kind**: behavioral\n\n## Why this matters\nOld intent", /unexpected heading/)
  rejects(replaced("## Implementation route", "## Git workflow"), /unexpected heading/)
  assert.doesNotThrow(() => parsePlanContract(source), "V2 does not require a literal Branch instruction")
})


test("accepts inline starting facts and dependency declarations throughout Starting conditions", () => {
  const inline = source.replace("**Observed baseline**:\nThe", "**Observed baseline**: The")
    .replace("**Required starting state**:\nThe", "**Required starting state**: The")
    .replace("**Expected dependency changes**:\nDependencies", "**Expected dependency changes**: Dependencies")
  assert.doesNotThrow(() => parsePlanContract(inline))
  assert.doesNotThrow(() => parsePlanContract(inline.replace("**Required starting state**: The", "Dependencies: none.\n\n**Required starting state**: The").replace("**Expected dependency changes**: Dependencies: none.", "**Expected dependency changes**: None.")))
  assert.doesNotThrow(() => parsePlanContract(source.replace("**Observed baseline**:", "Dependencies: none.\n\n**Observed baseline**:").replace("**Expected dependency changes**:\nDependencies: none.", "**Expected dependency changes**: None.")))
  assert.throws(() => parsePlanContract(inline.replace("**Expected dependency changes**: Dependencies: none.", "**Expected dependency changes**:")), /empty/)
})

test("supports SHA-256 evidence and non-contract contextual prose tables", () => {
  assert.doesNotThrow(() => parsePlanContract(replaced("abc1234", "a".repeat(64))))
  rejects(replaced("abc1234", "a".repeat(65)), /Planned at/)
  rejects(replaced("abc1234", "123456"), /Planned at/)
  for (const heading of PLAN_SECTIONS) {
    assert.doesNotThrow(() => parsePlanContract(replaced(`## ${heading}`, `## ${heading}\n\n| ID | Fact |\n| --- | --- |\n| baseline | Inspected source |`)))
  }
  assert.deepEqual(parseSharedToolchains("| ID | Fact |\n| --- | --- |\n| baseline | Inspected source |"), [])
  rejects(replaced("A1 | Preserve", "A9007199254740992 | Preserve"), /invalid A ID/)
  rejects(replaced("inspection | V1 |", `inspection | ${Array.from({ length: 65 }, (_, index) => `V${index + 1}`).join(", ")} |`), /at most 64 V references/)
  const definitions = toolchain.split("\n").slice(0, 2).join("\n") + "\n" + Array.from({ length: 65 }, (_, index) => toolchain.split("\n")[2].replace("T1", `T${index + 1}`)).join("\n")
  rejects(replaced(toolchain, definitions), /at most 64 (combined )?toolchain/)
  assert.throws(() => parseSharedToolchains(definitions), /at most 64 toolchain/)
  const shared64 = parseSharedToolchains(definitions.replace(/\n\| T65 \|[^\n]+$/, ""))
  assert.throws(() => parsePlanContract(source.replaceAll("T1", "T66"), { sharedToolchains: shared64 }), /at most 64 combined toolchain/)
})

test("the actual documented local template compiles with its inline facts and dependency guarantee", () => {
  const template = fs.readFileSync(new URL("../../../skills/plans/references/plan-template.md", import.meta.url), "utf8")
  const local = template.match(/```markdown\n(# Plan [\s\S]*?)\n```/)
  assert.ok(local, "canonical template must contain its local Markdown example")
  const contract = parsePlanContract(local[1])
  assert.equal(contract.metadata.category, "bug")
  assert.deepEqual(contract.metadata.dependencies, ["001"])
  assert.equal(contract.dependencies[0].plan, "001")
  assert.ok(contract.dependencies[0].consumes.includes("readOrders"))
  assert.deepEqual(contract.acceptance[0].proof, ["V2"])
  assert.equal(contract.verification.find((row) => row.id === "V2")?.phase, "acceptance")
})
