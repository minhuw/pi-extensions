# Simplification Playbook

Use this playbook to find codebase-wide reductions that preserve supported behavior. Simplicity is not a line-count contest. Prefer fewer independent concepts, execution paths, states, dependencies, public knobs, ownership boundaries, and places that must change together.

A simplification finding requires both a demonstrated maintenance cost and evidence that the proposed reduction is safe. Close remaining purpose and reachability questions during the audit. If the repository still cannot prove safety, keep the complexity or route the product question to Grill; do not emit an investigation finding or plan.

---

## Evidence ladder

Use the strongest available evidence and state gaps explicitly:

1. **Contract evidence** — public API docs, schemas, types, CLI help, compatibility policy, ADRs, support windows, or accepted product/domain documents.
2. **Behavior evidence** — focused tests, integration tests, fixtures, snapshots with reviewed meaning, and executable examples.
3. **Reachability evidence** — imports, callers, registrations, manifests, routes, plugin tables, reflection/dynamic-loading configuration, package exports, and deployment entry points.
4. **History evidence** — commit messages, blame, rollout/removal commits, deprecation dates, and recent convergence on a replacement.
5. **Operational evidence** — repository-owned telemetry queries, rollout records, or usage reports when available. Absence of such evidence is not proof of no users.

Static search alone is insufficient when a framework uses reflection, naming conventions, generated registration, runtime imports, external consumers, or published package entry points. Name those uncertainty sources.

For every candidate, answer:

- What purpose does this code serve today?
- Who can reach or depend on it, including external or dynamic callers?
- Which behavior must remain identical?
- What concrete maintenance burden does the current shape impose?
- What will disappear, converge, narrow, or become local?
- What check proves both preservation and completeness?

---

## 1. Dead and obsolete surface

Look for maintained code with no supported path to execution or use:

- unreferenced private modules, exports, parameters, branches, handlers, commands, routes, assets, and configuration keys;
- commented-out implementations, abandoned experiments, and TODO scaffolding whose intended feature no longer exists;
- fully rolled-out feature flags and old branches after repository-defined exit criteria are satisfied;
- deprecated aliases, adapters, formats, endpoints, and compatibility shims past an explicit support window;
- unused dependencies, duplicate packages, scripts, CI jobs, fixtures, examples, and manifest entries;
- fallback code for runtimes or platforms the repository no longer supports; and
- stale migration helpers after all supported data or callers use the new representation.

### Required proof

- Trace package exports, dynamic registrations, framework conventions, CLI entry points, and deployment configuration—not only textual imports.
- Check tests and docs for externally supported behavior.
- Use history to distinguish abandoned code from a temporarily dormant or staged rollout path.
- For published libraries, treat exported API as reachable unless an explicit breaking-change decision exists.
- For flags or compatibility layers, identify the repository's removal criterion and evidence that it is met.

If a candidate looks dead, finish the reachability trace in this session. If external or dynamic reachability still cannot be closed (published API, unknown consumers, reflection you cannot exhaust), keep it or ask Grill about deprecation; do not plan a research task.

---

## 2. Duplicate behavior and competing paths

Find cases where one rule or capability is maintained in multiple places:

- near-identical business rules, validation, serialization, parsing, error mapping, or state transitions;
- old and new implementations both kept alive after callers have mostly converged;
- copied helpers/components that have drifted or require lockstep fixes;
- several adapters around the same dependency or protocol;
- parallel configuration systems, error models, data-fetching approaches, or command paths; and
- multiple dependencies or tools solving the same repository need.

A duplicate is high-value when a routine change must be repeated, copies have already diverged, or tests prove the same contract several times.

### Prefer

- the repository's current, supported, and best-tested implementation as the canonical path;
- migration of bounded caller cohorts followed by deletion of the redundant path;
- one owner for a domain rule rather than a new generic framework; and
- consolidation that improves locality and removes concepts, not merely moves duplication behind an extra layer.

### Reject

- superficially similar code with different volatility, ownership, security, performance, or compatibility constraints;
- tiny readable repetition where abstraction would increase coupling or parameterization; and
- a "shared" helper that must accept many mode flags to cover unrelated behavior.

---

## 3. Unearned abstraction and indirection

Question layers whose maintenance cost exceeds the variability they isolate:

- pass-through wrappers that add no policy, translation, lifecycle, observability, or stable boundary;
- interfaces, base classes, factories, registries, plugin systems, strategy objects, or generic type machinery with one real implementation and no supported extension case;
- configuration knobs, optional parameters, hooks, and callbacks with no current caller or requirement;
- generalized frameworks built for one concrete workflow;
- adapter chains where each hop only renames values;
- helper layers that force readers to jump across files without hiding meaningful complexity; and
- abstractions whose callers still know and branch on implementation details.

Apply the **deletion test**: if the layer vanished, would policy become clearer and more local without spreading knowledge or coupling? If yes, it may be shallow indirection. If removing it would duplicate rules, expose volatile dependencies, weaken a security boundary, or erase a useful test seam, keep it.

Do not assume "one implementation" is enough to remove an interface. Boundaries may earn their keep through package ownership, dependency inversion, platform separation, lifecycle control, or a stable public contract. Verify the reason.

---

## 4. Control flow, data flow, and hidden behavior

Look for code that is difficult because too many paths or implicit relationships must be remembered:

- deeply nested branches, repeated condition trees, fallback ladders, and exception-driven normal flow;
- booleans or options whose combinations create invalid or untested states;
- duplicated state that can be derived from one source of truth;
- mutation through arguments or shared objects with unclear ownership;
- functions whose names/signatures hide I/O, caching, events, persistence, or other side effects;
- initialization or call-order dependencies not represented in the API;
- repeated scans or conversions that obscure the actual data transformation;
- broad functions coordinating unrelated responsibilities; and
- complex expressions, nested ternaries, metaprogramming, or regex/operator tricks that require decoding.

Useful reductions include guard clauses, explicit state types, a single source of truth, named domain operations, clearer side-effect boundaries, and removal of impossible branches. The target is fewer paths and assumptions, not fewer physical lines.

Avoid replacing straightforward code with dense pipelines, clever expressions, reflection, or generic dispatch. Expansion can be a simplification when it makes behavior obvious.

---

## 5. Module shape and ownership

Assess whether code is split or combined at the wrong boundaries:

- oversized modules with several unrelated reasons to change;
- junk-drawer utility modules with high fan-in and no coherent owner;
- one concern scattered across many tiny files, requiring navigation to understand a simple flow;
- circular dependencies or repeated cross-layer reach-through;
- UI, transport, persistence, and domain rules mixed so every change touches all of them; and
- package boundaries that expose internals or force duplicated adapters.

A split is worthwhile only when it creates a cohesive owner, isolates volatility, shortens the review path, or lets changes stay local. A consolidation is worthwhile when tiny fragments always move together and the extra boundaries add no independent contract.

Do not recommend file splitting by line threshold. Splitting can increase total surface and navigation cost. Name the resulting responsibilities, contracts, and direction of dependency.

---

## 6. Public, configuration, dependency, and type surface

Every supported choice creates maintenance work. Look for surface that has no current requirement:

- exported symbols or package entry points used only internally;
- CLI flags, environment variables, config keys, feature toggles, and constructor options with no supported caller;
- duplicate aliases and compatibility names;
- dependency wrappers that expose the entire third-party API instead of the subset the repository uses;
- broad union types, optional fields, generics, or overloads introduced for hypothetical cases;
- several libraries for one concern; and
- configuration values that are constant in all repository-owned environments.

Narrowing public surface can be breaking even when repository-local search finds no caller. Require explicit evidence of ownership and compatibility. If external usage cannot be known, keep the surface or route deprecation to Grill rather than silent removal.

Prefer deleting unused choices, deriving values, and keeping concrete types until real variants exist. Do not erase domain types that prevent invalid states or make contracts clearer merely to reduce declarations.

---

## 7. Compatibility, migrations, and legacy paths

Legacy code is removable only when its transition contract is complete. Inspect:

- old schema readers/writers, protocol versions, aliases, shims, polyfills, and fallback formats;
- dual-write or dual-read paths;
- deprecated endpoint or command routing;
- version gates and platform branches;
- migration scripts and temporary repair tools; and
- feature flags tied to rollout stages.

Require evidence for:

- the supported minimum version/platform/schema;
- all in-repository callers and data having migrated;
- external support/deprecation commitments;
- rollback expectations;
- tests that pin the retained behavior; and
- a completeness check showing the old path is gone.

When migration and cleanup cannot safely land together, shape ordered plans with a gate-passing intermediate state. Do not call temporary duplication a simplification until the cleanup node is explicit and executable.

---

## 8. Tests, tooling, CI, and documentation surface

Find maintenance duplication outside production code:

- several test helpers or fixtures expressing the same setup differently;
- tests duplicated across layers without distinct risk coverage;
- brittle snapshots or exhaustive mocks that obscure the behavior they protect;
- overlapping scripts, CI jobs, linters, formatters, generators, or release paths;
- stale docs/examples for removed behavior; and
- checked-in generated artifacts whose source-of-truth or regeneration path is unclear.

Preserve independent coverage of meaningful boundaries. Deleting a unit test because an end-to-end test exists may slow feedback or hide the failure location; deleting an integration test because a unit test exists may remove contract coverage. State the unique risk each retained layer covers.

Prefer one documented source of truth and nonredundant checks with distinct risks. Discover canonical invocations through repository scripts, pyproject/uv, Nix, lockfiles, CI, and instructions—not binary presence. Record owner/cwd, non-mutating probe, prerequisites, and source evidence; setup failure/wrong invocation is not a code finding. Do not ad hoc install/download tools or assume ambient HOME. Existing final-manager npm-only locked preparation is not planner setup authority. Never edit generated output directly when the generator owns it; plan the source or generator change and its regeneration proof. Keep tests/docs with the invariant unless they provide a separately useful, gate-passing prerequisite.

---

## 9. Balance check: complexity that earns its keep

Actively look for false positives. Keep complexity when it provides demonstrated value through:

- security, authorization, validation, auditability, or failure isolation;
- backwards compatibility still inside its support window;
- platform/runtime differences the project actively supports;
- concurrency, idempotency, retries, transactions, or resource cleanup;
- performance behavior backed by measurements or architecture constraints;
- a stable package/public boundary or ownership seam;
- domain types and named operations that prevent invalid states;
- a useful abstraction over several genuinely varying implementations; or
- explicitness that makes code easier to review than a shorter alternative.

Also detect over-simplification already present: duplicated domain rules that need one owner, giant functions created by inlining everything, raw primitives replacing meaningful types, or compressed code whose intent is hidden. The recommendation may be "keep" or "introduce one small abstraction" when that reduces total cognitive load. The command's goal is maintainability, not deletion at any cost.

---

## Exclusions and low-signal items

Do not report these unless tied to a concrete, repeated maintenance cost:

- formatting, import order, stylistic consistency, or subjective naming preferences;
- one-off verbose code that is already obvious;
- small helpers merely because they have one caller;
- arbitrary file-size thresholds;
- speculative performance micro-optimizations;
- generated, vendored, fixture, or migration-history code that is intentionally immutable;
- unsupported claims that an abstraction is "over-engineered"; or
- broad rewrites whose reduction cannot be verified in small passes.

"Could be cleaner" is not evidence. Name what becomes cheaper, what disappears, and how safety is proven.

---

## Finding format

Every audit pass returns findings in this exact shape:

```markdown
### [SIM-NN] Imperative reduction title

- **Kind**: DELETE | CONSOLIDATE | FLATTEN | NARROW | REHOME
- **Evidence**: `path/file.ts:123` — verified fact. Repeat for 2–5 strongest locations and name relevant symbols/callers.
- **Current purpose**: Why this code exists today, including accepted boundaries or the best-supported explanation from history.
- **Maintenance cost**: The concrete burden: duplicate fixes, broad change surface, extra states, dependency/API support, navigation, or regression risk.
- **Simplification proof**: Evidence that the reduction is safe; identify dynamic/external reachability checked and any remaining unknowns.
- **Preserved contract**: Observable behavior, public API, data compatibility, security property, or operational invariant that must not change.
- **Reduction sketch**: What disappears, converges, narrows, or becomes local. A suggested route, not an extra binding design constraint or full implementation plan.
- **Net effect**: Expected reduction in concepts, branches/states, dependencies, APIs, files-to-change, or approximate LOC when defensible.
- **Verification**: Focused positive checks plus a negative completeness check; name characterization prerequisites.
- **Effort**: S (hours) | M (day-ish) | L (multi-day), including tests and migration work.
- **Risk**: LOW | MED | HIGH — what could regress and why.
- **Confidence**: HIGH | MED — confidence in both the problem and the safety proof. Do not return LOW as a finding: finish the investigation, then either raise confidence, keep the complexity, or route a product question to Grill.
```

Unresolved leads are not findings. If an audit pass cannot close purpose or reachability, list a one-line lead (`path:line` + open question) for the parent session. The parent investigates before Confirm. Leads never become plans. Resolve facts and confirm material decisions before drafting; STOP conditions cannot hide unknown starting contracts. Use seven V2 sections without generic Git/test/review boilerplate. A rows bind preservation/reduction, V rows distinguish development/acceptance/final proof, and T rows identify evidence-backed toolchains. Every criterion needs acceptance proof before dependents start. Separate observed purpose/baseline from required starting state and expected dependency edits; label patch directions as suggested.

## Prioritization rubric

Rank by **maintenance leverage = durable maintained surface removed or localized ÷ total change effort**, discounted by regression risk and uncertainty.

Tiebreakers:

1. Characterization tests tied to selected, already-bounded reductions—or a concrete fix for broken or missing verification infrastructure—come first.
2. Proven deletion of an entire path, dependency, flag family, or duplicate implementation outranks cosmetic control-flow cleanup.
3. Prefer reductions with a small semantic boundary and strong positive plus negative verification.
4. Prefer convergence on an existing repository standard over introducing a new pattern.
5. A high-risk broad rewrite ranks below a sequence of safe caller migrations and cleanup.
6. "Keep as designed" and "not worth doing" are valid outcomes; record the reason so the same false positive is not rediscovered.
