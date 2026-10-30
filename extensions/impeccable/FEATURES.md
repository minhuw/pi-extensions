# Feature, prerequisite and evidence map

This map covers the complete pinned skill 4.8.0 / engine 0.1.18 integration. Start with the [installation and usage guide](README.md). Entries below identify retained operations and evidence, not a claim that every playbook was exercised against a paid model or every platform.

## Evidence key

| Mark | Actual scope / command |
| --- | --- |
| C | `npm run test:impeccable:contracts`: real Pi resource loading, all command metadata/prompts and argument expansion, reference/role completeness, 63 pristine vendor hashes and deterministic regeneration. |
| R | `npm run test:impeccable`: offline adapter/protocol-double tests plus real Pi TUI/RPC transport and Subagents children on scripted/faux models. Includes C; tests policies, failure states, ownership and lifecycle. |
| P | `npm run test:impeccable:package`: actual npm tarball and extracted byte/hash/license checks, guarded relocated Pi activation and all 26 prompt expansions, trusted local executable relocation. No managed native download. |
| N | Native portion of `npm run test:impeccable:e2e`, also `npm run test:impeccable:engine`: checksum-verified engine doctor/context parity, migrations/selection and actual native live protocol with authenticated injected test events. |
| B | Browser portion of `npm run test:impeccable:e2e`: actual native detector, direction page/Chromium DOM answer, Pi source/context mutations and live browser Go/variants/accept/discard/reload/recovery/cleanup. Foundations alone: `npm run test:impeccable:visual-foundations`. Catalog/model content and variants are **SIMULATED**. |
| I | Complete inherited playbook/native operation retained; source/contract coverage establishes availability, not observed execution of every workflow or fidelity gate. |

The combined E2E gate requires all six tests with no skipped/empty phase. The observed browser host is macOS arm64, engine 0.1.18, Chromium 141.0.7390.37. Local static HTML live acceptance/discard recovery is observed. Other frameworks/platforms, paid image services and aesthetic quality are not certified. Strict collection checking additionally requires `npm run typecheck` and `npm test`; see [all six checks](README.md#checks-and-evidence).

## Every command-metadata entry

Each row has a native `/design-<name>` prompt and is also available as `/impeccable <name> [arguments]`, `/design <name> [arguments]`, or a request routed by the discovered `impeccable` skill. The reference column links the complete playbook. These are **skill commands**, not a list of engine CLI verbs. All rows have C/R/P routing/resource evidence; I indicates retained workflow scope. B/N are added only where the relevant operation was actually observed, not as proof of the entire command.

Common prerequisites: a named project/surface, accessible source and truthful context. Editing requires normal Pi write tools and reading the craft floor. Rendered verification requires a runnable app/browser or disclosed fresh screenshot/golden fallback; native work requires the appropriate platform tooling. Capability absence is reported. Refinements preserve incumbent identity and scope.

| Entry | Reference and purpose | Prerequisites / applicability / adaptation | Evidence |
| --- | --- | --- | --- |
| `/design-craft` | [craft](skills/impeccable/reference/craft.md): deprecated new-work alias | New surface/replacement request; routes to complete new-work rather than a separate builder. | C/R/P/I; B direction components |
| `/design-init` | [init](skills/impeccable/reference/init.md): capture PRODUCT.md | Actual product answers; records platform and confirmed build-path preference. Distinct from native engine init. | C/R/P/I; R questions |
| `/design-document` | [document](skills/impeccable/reference/document.md): capture built visual system | Existing code/tokens/visual authority; canonical documenter, DESIGN.md and design sidecar. | C/R/P/I; R role packets |
| `/design-extract` | [extract](skills/impeccable/reference/extract.md): reusable tokens/components | Existing repeated patterns and bounded write scope; preserve behavior. | C/R/P/I |
| `/design-live` | [live](skills/impeccable/reference/live.md), [setup](skills/impeccable/reference/live-setup.md): browser element selection | Runnable web app, injection/CSP/native helper prerequisites and browser; transport owned by the Pi session. | C/R/P/N/B |
| `/design-generate` | [generate](skills/impeccable/reference/generate.md): named-element variants | Same live prerequisites; target/count/action packet, no manual selection needed. Owner handles native generate wait/replies. | C/R/P/N/B |
| `/design-adapt` | [adapt](skills/impeccable/reference/adapt.md), [native](skills/impeccable/reference/adapt.native.md) | Target device/platform and actual responsive/device captures; native vocabulary retained. | C/R/P/I |
| `/design-animate` | [animate](skills/impeccable/reference/animate.md): purposeful motion | Interactive source and motion/reduced-motion verification; retains live parameter path. | C/R/P/I |
| `/design-audit` | [audit](skills/impeccable/reference/audit.md), [native](skills/impeccable/reference/audit.native.md) | Accessibility/performance/responsive evidence; native tooling on iOS/Android. Web detector skip is not native success. | C/R/P/I; B detector only |
| `/design-bolder` | [bolder](skills/impeccable/reference/bolder.md): amplify timid UI | Incumbent scope/world constraints; live variants optional. In an open direction round “bolder” is re-roll steering. | C/R/P/I |
| `/design-clarify` | [clarify](skills/impeccable/reference/clarify.md): labels/copy/errors | Real product facts, user language and states; no invented commercial claims. | C/R/P/I |
| `/design-colorize` | [colorize](skills/impeccable/reference/colorize.md): purposeful color | Existing palette/color space, contrast and state checks; live parameter path retained. | C/R/P/I |
| `/design-critique` | [critique](skills/impeccable/reference/critique.md): scored UX review | Captures/source/detector inputs; separate independent assessments, critique storage and honest fallback. | C/R/P/I; R independent packets |
| `/design-delight` | [delight](skills/impeccable/reference/delight.md): memorable details | Product/visitor mode and working interaction evidence; preserve usability. | C/R/P/I |
| `/design-distill` | [distill](skills/impeccable/reference/distill.md): remove complexity | Existing tasks/content/behavior and explicit scope; preserves essential function. | C/R/P/I |
| `/design-harden` | [harden](skills/impeccable/reference/harden.md): production edge cases | Real errors, localization, overflow, loading/empty/permission states; verify applicable states. | C/R/P/I |
| `/design-onboard` | [onboard](skills/impeccable/reference/onboard.md): first-run/activation | Actual user journey, first-run/empty states and product value. | C/R/P/I |
| `/design-layout` | [layout](skills/impeccable/reference/layout.md): hierarchy/spacing/rhythm | Target sizes/content ranges and rendered evidence; native conventions where applicable. | C/R/P/I |
| `/design-optimize` | [optimize](skills/impeccable/reference/optimize.md): UI performance | Runnable target and meaningful measurements; disclose unavailable instrumentation. | C/R/P/I |
| `/design-overdrive` | [overdrive](skills/impeccable/reference/overdrive.md): ambitious effects | Compatible mode, capability/performance budget and accessibility; not permission to replace product truth. | C/R/P/I |
| `/design-polish` | [polish](skills/impeccable/reference/polish.md): finish pass | Existing UI, incumbent identity and rendered checks. Writer continues to own `/polish`. | C/R/P/I |
| `/design-quieter` | [quieter](skills/impeccable/reference/quieter.md): reduce overstimulation | Preserve identity and function; interpret restraint through visitor mode. | C/R/P/I |
| `/design-shape` | [shape](skills/impeccable/reference/shape.md): confirmed UX/UI plan | Actual discovery answers and direction decisions; stops before code, direction-contract persistence or implementation. | C/R/P/I; R questions |
| `/design-typeset` | [typeset](skills/impeccable/reference/typeset.md): typography | Available fonts, hierarchy, language/size/loading constraints and rendered legibility. | C/R/P/I |

## Routing, authority and supporting references

| Entry / reference | Prerequisites and retained operation | Pi adaptation / evidence |
| --- | --- | --- |
| `/impeccable`, `/design`, normal skill discovery; [routing](skills/impeccable/reference/routing.md), [SKILL.md](skills/impeccable/SKILL.md) | Freeform new work, replacement, refinement or workflow questions; no-argument menu asks rather than auto-runs. | Portable skill location, literal native arguments; all 26 prompts loaded/expanded. C/R/P |
| [new-work](skills/impeccable/reference/new-work.md) | PRODUCT truth, incumbent evidence, explicit preserve/expand/replace decision; context/init, directions, choice, brief, build, review and documentation. | Genuine decision/approval, no assumed fallback answer; actual PRODUCT preservation/DESIGN/brief writes in B, full workflow I/C/R. |
| [visualize](skills/impeccable/reference/visualize.md), [craft-floor](skills/impeccable/reference/craft-floor.md) | Image capability for comp-led work, true content, equal-fidelity options, prompt sidecars, approved comp; code-led contract where applicable. | Native image preference and API fallback retained; missing image capability disclosed. C/R/I; no paid-image/fidelity proof. |
| [mode-persuade](skills/impeccable/reference/mode-persuade.md), [mode-operate](skills/impeccable/reference/mode-operate.md), [mode-read](skills/impeccable/reference/mode-read.md), [operate](skills/impeccable/reference/operate.md) | Surface-specific Persuade/Experience, Operate, Read constraints; mode stored in surface brief. | Complete upstream ambition/native-control restrictions retained; C/I. |
| [iOS](skills/impeccable/reference/ios.md), [Android](skills/impeccable/reference/android.md) | Native build tools and simulator/emulator/device captures; adaptive requires both. | No web detector clean claim for native skips; C/R/I, no all-OS device certification. |
| [region-map](skills/impeccable/reference/region-map.md), [component-review](skills/impeccable/reference/component-review.md), [mode-read](skills/impeccable/reference/mode-read.md) | Region/spec mapping, rendered component decisions, document-specific behavior and evidence. | Complete references retained, native question/role adapters apply; C/I. |

## Roles and independent assessments

All four canonical source roles are retained in pristine vendor storage and exposed as complete adapted [role texts](skills/impeccable/reference/agents). Frontmatter model/effort is provenance, not fleet configuration. Existing Agent policies/models remain authoritative; no global fleet install or scripted-workflow opt-in changes occur.

| Role / entry | Required packet / applicability | Mapping, ceiling and evidence |
| --- | --- | --- |
| `impeccable_delegate` asset-producer | [Complete role](skills/impeccable/reference/agents/impeccable-asset-producer.md), product/direction, visualize/mode rules, references, frame and distinct asset output path; native image tool preferred. | Existing `worker`, 24 turns; generic fallback retained, Codex-only image block compiled out. C/R/P/I; no paid image claim. |
| documenter | [Complete role](skills/impeccable/reference/agents/impeccable-documenter.md), project/artifact, PRODUCT, direction contract, document reference and write boundary. | `worker`, 30 turns; new worlds need DESIGN.md plus design.json, ordinary extensions preserve incumbent artifacts. C/R/P/I. |
| finish-reviewer | [Complete role](skills/impeccable/reference/agents/impeccable-finish-reviewer.md), request/answers, captures, contract, findings, comp/boards/build spec/diffs or native reference as applicable. | Supplied-evidence `reviewer`, 30 turns; fresh review has no browser, missing captures limit verdict. Continuations hand off before unguardable dispatch. C/R/P/I. |
| manual-edit-applier | [Complete role](skills/impeccable/reference/agents/impeccable-manual-edit-applier.md), exact native edit packet, source boundary and deadline/output contract. | `worker`, 12 turns; only parent owns native replies. C/R/P; actual child boundary edit retained as partial and next-turn edit prevented in R. |
| Critique Assessment A / B | Separate complete critique packets, no sibling conclusions, fresh context; source/captures/browser/detector capabilities as needed. | Read-only A uses `reviewer`; browser A and detector/browser B use `worker`; 30 turns each. C/R/I; packet independence is not paid-model review quality evidence. |

Foreground calls request `inherit_context:false`, `isolated:false` and exact role soft budget, retaining extension/MCP tools. Progress cancels at the ceiling before another tool turn; boundary output can remain partial. `wrapped-up`, `partial`, `cancelled`, `active`, `unavailable`, `handoff` and `unresolved` are distinct. Executed results require evidence assessment, not inline whole-role replay. Background IDs must be managed/retrieved before dependent work. Only established no-child unavailability permits disclosed [degraded role paths](skills/impeccable/reference/degraded); an inline assessment is never independent. SDK capability/policy failures and nested Agent APIs are disclosed with complete main-session packets. R includes real children, soft-limit steering, substitution/error artifacts, cancellation and background result retrieval.

## Native engine and management surface

Use `impeccable_run` with direct `argv` (verb first), or ask `/impeccable` to follow the relevant playbook. Read native help/schema before constructing payloads. Supporting scripts/launchers remain installed and portable. Managed execution verifies the pinned engine; a deliberate `IMPECCABLE_BIN` override is trusted/unverified. Auxiliary operations retain native semantics rather than becoming extra prompt-template commands.

| Entry / reference | Prerequisites / applicability | Adaptation and evidence |
| --- | --- | --- |
| `context`, `signals`, `context-signals`; [Setup](skills/impeccable/SKILL.md#setup) | Existing project/cwd, selected source or app; product/design/brief/platform context. | Installed paths and managed engine; no fabricated missing context; N parity, R/P relocation, I for other signal shapes. |
| `surface-brief`, `palette`, `critique-storage` | Valid targets and native argument/payload schema; surface contracts, palette and durable review history. | Upstream storage/ownership retained; C/I, B actual brief write/read. |
| `concept-seed`, `serve-question`; [new-work](skills/impeccable/reference/new-work.md) | Network catalog when available; valid seed/catalog IDs and page payload, real user choice. | Browser page and supported question fallback; B real native ledger/DOM/ANSWER with SIMULATED catalog, R unavailable/partial question paths. |
| `component-review`; [component-review](skills/impeccable/reference/component-review.md) | Component snapshots/candidates, valid page payload and actual review decisions. | Upstream page retained; questions/delegation adapters apply, C/R/I; no full browser component-review claim. |
| `build-phase`, `comp-spec`, `comp-diff`, `font-match`; [new-work](skills/impeccable/reference/new-work.md), [visualize](skills/impeccable/reference/visualize.md), [region-map](skills/impeccable/reference/region-map.md) | Approved comp where comp-led; measured spec/regions, matching viewport captures and available fonts. | Native gates/numeric fidelity and code-led route retained, C/I; no claim every gate passed in E2E. |
| `capture-server` and canonical browser helper scripts | Runnable app, browser/capture capability, matching viewport/source evidence. | Retained support scripts; tool discovery reports candidates/unknowns. C/P/I; B Chromium/static HTML is narrower than all capture integrations. |
| `generate-image`, `embed-prompt`; [visualize](skills/impeccable/reference/visualize.md) | Prefer harness image tool; native fallback OPENAI_API_KEY at api.openai.com/v1, valid paths/ref images, provenance sidecars and approval. | Native generic fallback/provenance retained. C/R/I; fake image is synthetic test-only, no paid-image proof. |
| `detect`, `ignore`, `ignores`, `hook`, `hook-before-edit`, `hooks`, `hook-admin`; [hooks](skills/impeccable/reference/hooks.md) | Detector config/rules/files; automatic hooks require project opt-in and local consent. Native platforms may be inapplicable. | Real upstream detector, supported edit envelopes, safe config/ignore CRUD, dedup/one continuation and temporary state ownership. R protocol/lifecycle, B actual finding/dedup/correction. |
| `doctor` / `doctor --fix`; [doctor](skills/impeccable/reference/doctor.md) | Accessible project, explicit valid target for targeted repair, valid native artifacts/config. | Genuine stdout/findings/migrations, separate Pi metadata; validated mutating scope, targetless workspace semantics. R/N. |
| `pin`, `unpin`; [skill controls](skills/impeccable/SKILL.md) | Public command discovery, owned destination; `pin pin <command>` / `pin unpin <command>`, optional `--project` or `--user`, then `/reload`. | Owns only marked native prompts, refuses conflicts (including Writer `/polish`), non-owned files/symlinks. Session `.pi/prompts` or agent prompts directory; R real pin/reload/symlink/conflict evidence. |
| `/i`, `teach`, deprecated `craft`, short pin/unpin and `hook-admin` aliases | `/i` requires discovered `/impeccable` and no existing `/i`; teach routes to init playbook, craft to ordinary new work. | Safe compatibility routes, no shadowed commands or invented reference files. C/R/P. |
| `telemetry off|on|status` | Deliberate user choice; network catalog behavior and user/shared/local config precedence. | Native CLI changes USER telemetry config, off anywhere wins; environment opt-outs and exact endpoints in [guide](README.md#browser-image-and-catalog-prerequisites). I; no personal config mutation required by checks. |
| `install`, `update`, `link`, skill distribution routes | Repository maintainer upgrade with provenance/license/manifest/roles/metadata review. | Redirect to [repository-managed upgrades](README.md#repository-managed-upgrades), deterministic transform and all six gates; no foreign harness install/native binary commit. C/R/P. |

## Live auxiliaries and lifecycle

| Entry / reference | Prerequisites / applicability | Adaptation and evidence |
| --- | --- | --- |
| `impeccable_live start|generate`, `/design-live`, `/design-generate`; [live](skills/impeccable/reference/live.md), [setup](skills/impeccable/reference/live-setup.md), [generate](skills/impeccable/reference/generate.md) | Configured runnable web surface, native helper/auth/roots agreement, CSP/injection and browser. | Lazy session owner, prompt return, no competing model Bash poll; R/N/B. |
| Owner-only boot, `live-generate`, `live-poll`, `live-server`, completion transport | Exclusive physical-project lease, exact persisted session/branch, supported native protocol. | Raw runner hands off to owner; exact event/token and business ack, no journal edits. R/N/B. |
| Native live source/scaffold/manual-edit/variant/status/resume auxiliaries | Follow native help/playbook and canonical source/config/journal state; required tools and write boundary. | Non-owner auxiliary verbs retain managed execution. Parent owns poll/reply/complete. R/I; B actual preflight scaffold, source variants and mounts. |
| `impeccable_live status|reply|resume|stop`; immediate `/impeccable-live status|stop|resume` | Current owner/session, matching pending ID/token for reply; genuine publication and separate terminal verification. | Exact-session recovery, no repeated Go or acknowledged work; stale tokens rejected. R/N/B. |
| Generate/steer, accept/discard, manual apply, prefetch, mount failure, timeout/exit, carbonize cleanup | Native event payload and acknowledgement schema; manual deadlines relative to receipt, evidence for source/cleanup. | Full R protocol shapes; B observes generate/mount/accept/discard and recovery, N native transport. Other shapes retain R/I rather than equivalent browser proof. |
| Abort, input, reload, switch/fork/branch, unresolved settlement, shutdown | Active owner or recoverable state; branch/session identity authoritative. | Invalidate delivery, stop owned children/timers only, preserve pending source/journal; do not kill borrowed helpers/app servers. R broad lifecycle, N/B actual recovery/owned PID exit and borrowed/app/browser survival. |

Normal activation, `npm ci` and safe checks download no engine/browser. Explicit N/B checks isolate homes/config/credentials and fail missing prerequisites; their private browser provisioner is test infrastructure. No paid model, real image service, universal framework/OS compatibility or aesthetic compliance claim follows from simulated content and protocol coverage.
