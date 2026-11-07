# Council

Use `/council <topic>` or the `council` tool to convene a three-model, read-only technical council for difficult architectural, design, and tradeoff decisions. Council replaces the single `expert` subagent with a structured two-round deliberation across three frontier models from distinct model families.

The collection loads this extension automatically after Subagents; use `/reload` after installing or updating it.

```text
/council                                show usage and the three pinned council advisors
/council <topic or design question>     instruct the main session to convene the council and synthesize the result
```

## Pinned Council Advisors

The council's three advisor definitions live in `extensions/council/agents/` and are loaded by Subagents with `model_visible: false` and `isolation: off`:

| Member ID | Agent definition | Pinned model | Thinking | Tools |
| --- | --- | --- | --- | --- |
| `argon` | `council-argon` | `magpie/gemini-4-argon` | `high` | `read, bash, grep, find, ls` (read-only) |
| `astra` | `council-astra` | `magpie/gpt-6-astra` | `xhigh` | `read, bash, grep, find, ls` (read-only) |
| `opus` | `council-opus` | `magpie/claude-opus-5-5` | `high` | `read, bash, grep, find, ls` (read-only) |

Because `model_visible: false` is set on all three definitions, ordinary `Agent` calls, nested subagent tools, `@type` mentions, and workflows cannot spawn them directly or fall back to them. They are spawned exclusively over Subagents' cross-extension RPC (`subagents:rpc:spawn` and `subagents:rpc:send`, protocol >= 3). Raw `model` overrides on the `council` tool are rejected so the panel's model diversity is always preserved.

## Two-Round Deliberation Flow

```ts
council({
  topic: "Design the retry and idempotency contract for batch ingestion",
  paths: ["src/ingest/batch.ts", "src/ingest/types.ts"],
  rounds: 2,
  members: ["argon", "astra", "opus"]
})
```

| Parameter | Description |
| --- | --- |
| `topic` | Required non-empty design question, architecture problem, or technical tradeoff. |
| `paths` | Optional list of repository files or directories for advisors to inspect first. |
| `rounds` | `1` (independent proposals only) or `2` (independent proposals + anonymized peer cross-examination). Defaults to `2`. |
| `members` | Optional subset of `["argon", "astra", "opus"]` with at least 2 distinct members. Defaults to all three. |

1. **Round 1 — Independent Proposals:** `council` verifies Subagents RPC protocol `>= 3` (`subagents:rpc:ping`), then spawns the selected `council-<member>` agents in parallel via `subagents:rpc:spawn` (`notifyParent: false`, `retain: rounds === 2`, `isBackground: true`, `bypassQueue: true`). Each advisor inspects the codebase with read-only tools and produces a structured proposal (`### 1. Proposed Design / API Contract`, `### 2. Key Tradeoffs & Assumptions`, `### 3. Edge Cases & Failure Modes`).
2. **Round 2 — Anonymized Cross-Examination:** When `rounds` is `2`, each surviving advisor session is resumed in parallel via `subagents:rpc:send` with the other advisors' Round 1 proposals labeled only as `Peer A` and `Peer B`. Each advisor responds with `### 1. Adopt`, `### 2. Critique`, and `### 3. Revised Design & Verdict` (`Stance: converged` or `Stance: tradeoff`).
3. **Completion & Resilience:** Completion events are consumed synchronously via `subagents:rpc:consume` so background notifications never interrupt the parent turn. If one member fails while at least two succeed, deliberation completes with the surviving members and reports the failure. If the caller aborts via `AbortSignal`, active council subagents are stopped immediately via `subagents:rpc:stop`.

## Bias Controls

Multi-LLM deliberation is vulnerable to brand bias, position bias, verbosity bias, and sycophantic herding. Council mitigates all four structurally:

- **Identity blinding:** Peer proposals in Round 2 are labeled `Peer A` and `Peer B`, and any self-referential model or agent identifiers are scrubbed before cross-examination.
- **Counterbalanced position-swap:** `rotatePeersForMember` assigns peer labels in cyclic order starting at `(selfIndex + 1) % N`. In a three-member council `[M0, M1, M2]`, `M0` sees `(Peer A = M1, Peer B = M2)`, `M1` sees `(Peer A = M2, Peer B = M0)`, and `M2` sees `(Peer A = M0, Peer B = M1)` — every proposal is evaluated once in first position and once in second position.
- **Verbosity normalization & anti-herding rubric:** Round 2 explicitly instructs advisors to judge proposals strictly on `file:line` codebase evidence and architectural simplicity, ignoring response length, formatting polish, or rhetorical confidence, and to refuse majority herding when codebase evidence contradicts a claim.
- **Stake-free parent synthesis:** The parent session did not write any of the proposals in Round 1 or Round 2, so it adjudicates the returned report without self-preference bias.

## Development

```bash
npm run test:council
npm run typecheck
```
