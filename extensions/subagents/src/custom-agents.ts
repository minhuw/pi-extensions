/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/, plus the shared .agents/agents/ workspace) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations, plus any installed pi package that declares them (see package-resources.ts).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseAgentDefinition, parseAgentFrontmatter } from "./agent-definitions.js";
export { parseAgentFrontmatter } from "./agent-definitions.js";
import {
  isPackageResourceExcluded,
  MAX_PACKAGE_RESOURCE_BYTES,
  packageAgentDirs,
  packageAgentFiles,
} from "./package-resources.js";
import type { AgentConfig } from "./types.js";

/** Where an agent file was found. Widens `AgentConfig.source` for the loader. */
type AgentSource = "project" | "global" | "package";

/** Answers whether a `!` entry in some package manifest excludes this path. */
type Excluder = (path: string) => boolean;

/**
 * Overrides for the package tier. The gate and project-trust state normally come
 * from the session values in package-resources.ts, so these exist for tests and
 * for a caller that has to pin a scan it already performed.
 */
export interface LoadCustomAgentsOptions {
  /** Explicit package directories, bypassing discovery. */
  packageDirs?: string[];
  /** Explicit package files, bypassing discovery. */
  packageFiles?: string[];
  /** Explicit `!` exclusion predicate, bypassing discovery. */
  packageExcluded?: Excluder;
}

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project:   <cwd>/.pi/agents/*.md (authoritative — also where /agents writes)
 *   2. Workspace: <cwd>/.agents/agents/*.md (shared cross-tool .agents workspace, read-only)
 *   3. Global:    $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *   4. Package:   paths declared by an installed pi package (read-only)
 *
 * Project-level agents override global ones with the same name. On a name clash
 * between the two project locations, .pi/agents wins — .pi stays the project
 * authority; .agents/agents is an additional read location.
 * Any name is allowed — names matching defaults (e.g. "recon") override them.
 *
 * Package agents load *first*, so everything the user or project wrote outranks
 * them. That is what makes them safe to adopt: a package can offer a `reviewer`,
 * and a `.pi/agents/reviewer.md` silently takes it back. It mirrors pi's own
 * resource precedence, where package-provided skills rank below every user and
 * project one, and Claude Code's, where a plugin agent is the lowest tier.
 *
 * An agent's type comes from its frontmatter `name:`, falling back to the
 * filename — Claude Code's rule, where "the filename doesn't have to match".
 * Because the type is now declared rather than derived from a unique path, two
 * files can claim the same one; the later load wins, as it always has for a
 * filename clash, and `warnSkippedOverride` reports the substitution.
 */
export function loadCustomAgents(
  cwd: string,
  strict = false,
  opts: LoadCustomAgentsOptions = {},
): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), "agents");
  const workspaceProjectDir = join(cwd, ".agents", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const pkgDirs = opts.packageDirs ?? packageAgentDirs(cwd);
  const pkgFiles = opts.packageFiles ?? packageAgentFiles(cwd);
  // `!./agents/wip.md` alongside `./agents` excludes one file out of a directory
  // that is only enumerated here, so the check has to run per file.
  const excluded: Excluder = opts.packageExcluded ?? (path => isPackageResourceExcluded(path, cwd, "agents"));

  const agents = new Map<string, AgentConfig>();
  for (const dir of pkgDirs) loadFromDir(dir, agents, "package", strict, excluded); // lowest priority
  for (const file of pkgFiles) loadOneFile(file, agents, "package", strict);
  loadFromDir(globalDir, agents, "global", strict);
  loadFromDir(workspaceProjectDir, agents, "project", strict); // shared workspace
  loadFromDir(projectDir, agents, "project", strict);          // highest priority (overwrites)

  warnedLastLoad = warnedThisLoad;
  warnedThisLoad = new Set();
  return agents;
}

/** Load agent configs from a directory into the map, skipping any `excluded` path. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: AgentSource,
  strict: boolean,
  excluded?: Excluder,
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const path = join(dir, file);
    if (excluded?.(path)) continue;
    loadOneFile(path, agents, source, strict);
  }
}

/**
 * Load one agent file into the map.
 *
 * Split out of `loadFromDir` because a package manifest may name an individual
 * `.md` rather than a directory, and because the size guard below has to apply
 * to both paths.
 */
function loadOneFile(path: string, agents: Map<string, AgentConfig>, source: AgentSource, strict: boolean): void {
  const filenameType = basename(path, ".md");

  // Package files are third-party content read on every `Agent` call, so a
  // pathological one is skipped rather than pulled into the session. Claude
  // Code applies the same 1 MB ceiling to plugin-provided agents. Local files
  // are the user's own and stay unbounded, as they always have been.
  if (source === "package" && !withinSizeLimit(path)) {
    warnIfNew(`Skipping package agent ${path}: not a regular file, or larger than ${MAX_PACKAGE_RESOURCE_BYTES} bytes.`);
    return;
  }

  // `strict` is deliberately not passed for a package file. Failing activation
  // over a broken agent file is right for a checked-in `.pi/agents/` — the point
  // is that a repo's own file cannot silently fall through to a same-named one
  // elsewhere. A file inside a third-party package is not the user's to fix, and
  // one bad `.md` in any installed package would otherwise stop pi from
  // starting at all. Warn and skip, as for a non-strict local file.
  const parsed = readAgentFile(path, strict && source !== "package");
  if (!parsed) {
    warnSkippedOverride(filenameType, agents);
    return;
  }
  const { frontmatter: fm, body } = parsed;

  const config = parseAgentDefinition(fm, body, { filename: filenameType, sourcePath: path, source }, warnIfNew);
  if (config) agents.set(config.name, config);
}

/**
 * True when `path` is a regular file within the package-resource size ceiling.
 *
 * Only applied to package-provided files: they arrive from a third party and are
 * re-read on every `Agent` call, so a 500 MB `.md` — or a fifo that never ends —
 * must not be reachable from a spawn. A stat failure counts as "not within",
 * because the alternative is reading something we could not describe.
 */
function withinSizeLimit(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= MAX_PACKAGE_RESOURCE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Read and parse one agent file, or warn and return undefined for the caller to
 * skip. One bad file must not take the whole extension down with it — an
 * unparseable `.md` used to abort activation, so pi exited before the TUI.
 *
 * The path is as much of the fix as the recovery: a bare YAML error ("line 2,
 * column 14") is unactionable when agents come from three directories at once,
 * and the only other symptom is `Unknown agent type`, which reads like a typo.
 *
 * Under `strict` the same failure rethrows, still naming the path, so callers
 * that opted into failing closed stop rather than run a substituted agent.
 */

function readAgentFile(path: string, strict: boolean): { frontmatter: Record<string, unknown>; body: string } | undefined {
  try {
    return parseAgentFrontmatter<Record<string, unknown>>(readFileSync(path, "utf-8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (strict) throw new Error(`${path}: ${reason}`);
    warnIfNew(`Skipping agent file ${path}: ${reason}`);
    return undefined;
  }
}

/**
 * A skipped file that was overriding an already-loaded agent leaves the name
 * pointing at a *different* file — its own prompt, model and tools. Nothing
 * downstream can flag that: unlike an unknown type, the `Agent` call succeeds.
 */
function warnSkippedOverride(name: string, agents: Map<string, AgentConfig>): void {
  const surviving = agents.get(name);
  // Nothing shadowed, or what it shadowed is disabled: dispatch refuses the type
  // either way (see resolveEnabledTypeIn), so there is no substitution to report.
  if (!surviving?.sourcePath || surviving.enabled === false) return;
  warnIfNew(`Agent "${name}" now loads from ${surviving.sourcePath} instead`);
}

let warnedLastLoad = new Set<string>();
let warnedThisLoad = new Set<string>();

/**
 * Agents reload on activation and again on every `Agent` call, so an unchanged
 * problem would re-warn all session — over a painted TUI, since pi does not
 * redirect console output. Compare against the previous load rather than every
 * load ever, so a file that is fixed and then broken again still reports.
 */
function warnIfNew(message: string): void {
  warnedThisLoad.add(message);
  if (warnedLastLoad.has(message)) return;
  console.warn(`[pi-subagents] ${message}`);
}
