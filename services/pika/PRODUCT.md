# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **The owner (primary).** One person who runs Pi coding agents on several of their own machines and self-hosts pika in a homelab, behind a reverse proxy that terminates TLS. They come back to pika to see what their agents did, what it cost, and what is running right now.
- **Public visitors (first-class, confirmed).** People the owner sends to a published project or trajectory at `/public`. They arrive without a login, without the owner beside them, and usually without knowing Pi, and the published pages have to make sense to them on their own.

## Product Purpose

pika stores every Pi trajectory from all of the owner's machines and serves it back. The owner uses it for four jobs, about equally often (confirmed):

1. **Debug a run:** what the agent did, in what order, and where it went wrong, down to the exact request each model call received.
2. **Audit cost and effort:** tokens, prompt-cache share, cost, and time across sessions, subagent families, and Herder runs.
3. **Watch live work:** which sessions are online and busy now, and messaging any of them through relay.
4. **Share:** publish chosen projects so that strangers can replay their trajectories.

Success means the owner can answer "what happened, what did it cost, what's running" without leaving the page they're on, and a stranger can follow a published trajectory from its first prompt to its last tool call.

## Positioning

pika keeps the complete, verbatim record. Every session line is stored byte-identical (`pika export` reproduces the original JSONL), the captured provider request is kept for every model call, and subagents, workflow children, and Herder steps are linked into families across machines. One Rust binary serves the record to one owner, with no team, tenant, or vendor in between, and the same server relays messages between the owner's running sessions.

## Operating Context

- Devices upload through the pika extension; each device pairs once from the web UI and keeps a per-device token.
- Sessions come from Pi with subagents (single agents and scripted workflows), Herder runs (journal, goal, plan, steps), compactions, model switches, and images.
- The UI runs behind a reverse proxy under any base path, protected by pika's password (server-side sessions) or by the proxy.
- `/public`, `/public?project=<name>`, and `/public/s/<id>` serve published projects anonymously. Publishing exposes prompts, responses, thinking, tool inputs and outputs, images, and raw entries without redaction. Captured provider requests stay private, and the public UI has no relay or management controls.

## Capabilities and Constraints

- **Views:** filtered session list with families shown as trees; session view with timeline, ledger, and inspector, plus transcript, per-tool renderers, inline subagents, a context drawer showing exact request payloads, and replay; agent tree with timing and cost per family; Herder runs and run detail; active sessions with relay messaging; devices (pairing, renaming, revoking, browser sessions); full-text search; settings with published projects; login.
- **Terminology:** session, trajectory, turn, record, model call, tool call, subagent, family, Herder run, step, device, project, published project, relay, compaction. Record kinds: Prompt, Model call, Shell, Read & search, Write, Other tool, Subagent, Compaction.
- **Scale (from `docs/PERF.md`):** a year of data from five machines is 10,000 sessions and 2.56M entries over 40 projects and 6 models; sessions average about 256 entries, with outliers at 5,000 and 20,000; 30% of sessions are children. Tool results have a median of about 1 KiB and reach about 50 KiB. Latency targets: session list p95 < 100 ms, a 5,000-entry session p95 < 200 ms, search p95 < 300 ms.
- **Delivery:** the web UI is React, Vite, TypeScript, and Tailwind in `web/`; release builds embed `web/dist` in the binary, and one build works under any base path.
- **Themes:** light and dark both exist; the UI follows the system until the user picks one.
- **Tests:** `web/tests` (Vitest) and the end-to-end script in `e2e/` drive the UI through `data-*` attributes and accessible names; future work keeps those hooks.

## Brand Commitments

- The name is **pika**, lowercase.
- The logo is binding: a geometric pika-shaped "p" with a blue body `#4D90C2`, a coral ear `#F9856D`, a gold lower panel `#FCC64D`, and a white eye (`resource/pika-icon.svg`, `resource/pika-icon.png`). Its colors should inform the UI's system (confirmed); how they do so is a visual decision, not recorded here.

## Evidence on Hand

- Real content is the owner's own sessions on their server; none of it is in the repository.
- Realistic synthetic content: `e2e/scenario.ts` (real Pi sessions driven by the end-to-end script) and the deterministic one-year dataset from `scripts/perf.sh`.
- No user counts, testimonials, customers, or benchmarks beyond the `docs/PERF.md` targets; do not invent any.

## Product Principles

1. **The record is the product.** Show what happened completely and verbatim; never summarize away evidence the owner may need.
2. **Four jobs, one record.** Debugging, auditing, watching, and sharing are equal citizens, and none is a second-class view.
3. **Legible to strangers.** Anything the owner publishes must read without the owner there to explain it.
4. **One owner, their own data.** No team, tenant, or SaaS framing; the owner's machines, projects, and devices are the whole world.
