# Subagents (vendored)

Claude Code–style autonomous sub-agents for [Pi](https://pi.dev).

Vendored fork of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).
Edit source in place under `src/`.

## Upstream pin

| Field | Value |
| --- | --- |
| Package | `@tintinweb/pi-subagents` |
| Repository | https://github.com/tintinweb/pi-subagents |
| Version | **v0.14.3** |
| Tag | `v0.14.3` |
| Commit | `c10b1836256e760da75296ccd4e57a77ada1325e` |
| Vendored on | 2026-08-09 |
| Entry | [`src/index.ts`](./src/index.ts) |

Update this table when resyncing from upstream.

## Layout

```text
extensions/subagents/
  README.md   ← this file (pin, license, usage)
  LICENSE     ← upstream MIT (Copyright (c) 2026 tintinweb)
  examples/
  src/        ← extension source
```

## Install / load

```bash
pi install git:github.com/minhuw/pi-extensions
# or local:
pi install /absolute/path/to/pi-extensions
# only this extension:
pi -e ./extensions/subagents/src/index.ts
```

Do **not** also install `npm:@tintinweb/pi-subagents` in the same Pi profile.

## License

**MIT** — [`LICENSE`](./LICENSE), Copyright (c) 2026 tintinweb.

Keep the license file when distributing. Packaging notes here and monorepo
registration are under the root [pi-extensions MIT](../../LICENSE).

## Dependencies

Monorepo `package.json`: `@sinclair/typebox`, `croner`, `nanoid`.  
Peers: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`.

## Usage

- Tools: `Agent`, `get_subagent_result`, `steer_subagent`
- Command: `/agents`
- Custom types: `.pi/agents/<name>.md` (project) or global agents dir
- Built-in fleet: **`recon`** → **`worker`** → **`reviewer`** (replaces upstream Explore/Plan/general-purpose)

| Type | Job | Tools | Model defaults |
| --- | --- | --- | --- |
| `recon` | Read-only codebase recon; compressed handoff | read-only | `openai/gpt-5.6-luna`, thinking `max`, `service_tier: fast` |
| `worker` | Bounded implementation + verify | all coding tools | inherit parent |
| `reviewer` | Read-only severity-ranked review; no edits | read-only | inherit parent |

Typical handoff: recon maps the surface → worker implements → reviewer gates the diff.

Upstream package docs (pre-fork): [README v0.14.3](https://github.com/tintinweb/pi-subagents/blob/v0.14.3/README.md).

## Resync

1. Clone the new tag from https://github.com/tintinweb/pi-subagents  
2. Merge/copy `src/`, `examples/`, `LICENSE` carefully over local edits  
3. Bump monorepo deps if upstream `package.json` requires it  
4. Update the pin table above  

## Local modifications

| Change | Files | Notes |
| --- | --- | --- |
| **Service tier** | `src/service-tier.ts`, wiring in types/runner/manager/schedule/index/… | Pin OpenAI-style service tier per agent type / spawn |
| **Default fleet** | `src/default-agents.ts` (+ fallbacks in agent-types/runner/index) | Replace Explore/Plan/general-purpose with recon/worker/reviewer |

### Service tier

Frontmatter (authoritative when set):

```yaml
model: openai/gpt-5.6-luna
thinking: max
service_tier: fast   # fast|standard, or priority|default|flex|auto
```

Tool param (only if frontmatter omits `service_tier`):

```ts
Agent({ subagent_type: "scout", service_tier: "fast", prompt: "...", description: "..." })
```

Mapping: `fast` → provider `priority`, `standard` → `default`. Applied by wrapping
the child session stream (same approach as Herder). Only OpenAI-compatible APIs
(`openai-responses`, `openai-codex-responses`, `cliproxyapi-codex-responses`).
Caller-supplied unsupported tier → hard error; frontmatter on unsupported model →
warning and run without tier.
