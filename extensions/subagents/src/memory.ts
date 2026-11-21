/**
 * memory.ts — Persistent agent memory: per-agent memory directories that persist across sessions.
 *
 * Memory scopes:
 *   - "user"    → getAgentDir()/agent-memory/{agent-name}/ (default ~/.pi/agent/agent-memory/, honors $PI_CODING_AGENT_DIR)
 *   - "project" → .pi/agent-memory/{agent-name}/
 *   - "local"   → .pi/agent-memory-local/{agent-name}/
 *
 * The user scope previously hardcoded ~/.pi/agent-memory/. That legacy location
 * is still honored (read + write) when it exists and the new location doesn't,
 * so existing memories aren't orphaned.
 */

import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MemoryScope } from "./types.js";

/** Maximum lines to read from MEMORY.md */
const MAX_MEMORY_LINES = 200;

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Returns true if the given path is a symlink (defense against symlink attacks).
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Safely read a file, rejecting symlinks (including dangling symlinks).
 * Checks lstat before reading so dangling symlinks are detected directly
 * without relying on existsSync.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
  try {
    if (lstatSync(filePath).isSymbolicLink()) return undefined;
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

type PathCheckResult =
  | { status: "ok"; exists: boolean; isDirectory: boolean }
  | { status: "symlink"; symlinkPath: string }
  | { status: "outside-root" }
  | { status: "error"; error: unknown };

/**
 * Infer the scope root for a memory directory when the caller did not supply
 * one explicitly. Recognizes the standard memory directory layouts:
 *   - `<root>/.pi/agent-memory/<agent>`
 *   - `<root>/.pi/agent-memory-local/<agent>`
 *   - `<root>/agent-memory/<agent>`
 * Falls back to `dirname(target)` so only the leaf component is inspected and
 * OS-level symlink prefixes above the root (e.g. macOS `/var` -> `/private/var`)
 * are never rejected.
 */
function inferScopeRoot(memoryDir: string): string {
  const resolved = resolve(memoryDir);
  const parent = dirname(resolved);
  const parentName = basename(parent);
  if (parentName === "agent-memory" || parentName === "agent-memory-local") {
    const grandParent = dirname(parent);
    if (basename(grandParent) === ".pi") {
      return dirname(grandParent);
    }
    if (parentName === "agent-memory") {
      return grandParent;
    }
  }
  return parent;
}

/**
 * Walk every relative path segment strictly beneath `scopeRoot` down to
 * `targetPath`, calling `lstatSync` on each segment without checking `scopeRoot`
 * itself or any OS-level symlink prefixes above it.
 *
 * Detects live and dangling symlinks at any intermediate or leaf segment before
 * any `existsSync` or filesystem mutation can short-circuit.
 */
function inspectPathBeneathRoot(targetPath: string, scopeRoot: string): PathCheckResult {
  const resolvedRoot = resolve(scopeRoot);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);

  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { status: "outside-root" };
  }

  const segments = rel === "" ? [] : rel.split(sep).filter(Boolean);
  const pathsToCheck =
    segments.length === 0
      ? [resolvedTarget]
      : segments.map((_, i) => join(resolvedRoot, ...segments.slice(0, i + 1)));

  let lastStat: ReturnType<typeof lstatSync> | undefined;
  for (const currentPath of pathsToCheck) {
    try {
      const stat = lstatSync(currentPath);
      if (stat.isSymbolicLink()) {
        return { status: "symlink", symlinkPath: currentPath };
      }
      lastStat = stat;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // This component (and therefore everything beneath it) does not exist.
        return { status: "ok", exists: false, isDirectory: false };
      }
      return { status: "error", error: err };
    }
  }

  return {
    status: "ok",
    exists: true,
    isDirectory: lastStat?.isDirectory() ?? false,
  };
}

interface ResolvedMemoryLocation {
  memoryDir: string;
  scopeRoot: string;
}

function resolveMemoryLocation(agentName: string, scope: MemoryScope, cwd: string): ResolvedMemoryLocation {
  if (isUnsafeName(agentName)) {
    throw new Error(`Unsafe agent name for memory directory: "${agentName}"`);
  }
  switch (scope) {
    case "user": {
      const agentDir = getAgentDir();
      const current = join(agentDir, "agent-memory", agentName);
      // Legacy location from when this path was hardcoded. Keep using it if it
      // already holds this agent's memory and the new location hasn't been
      // created yet — otherwise existing memories would be silently orphaned.
      const home = homedir();
      const legacy = join(home, ".pi", "agent-memory", agentName);
      const currentCheck = inspectPathBeneathRoot(current, agentDir);
      const currentMissing = currentCheck.status === "ok" && !currentCheck.exists;
      if (currentMissing) {
        const legacyCheck = inspectPathBeneathRoot(legacy, home);
        if (legacyCheck.status === "ok" && legacyCheck.exists) {
          return { memoryDir: legacy, scopeRoot: home };
        }
      }
      return { memoryDir: current, scopeRoot: agentDir };
    }
    case "project":
      return { memoryDir: join(cwd, ".pi", "agent-memory", agentName), scopeRoot: cwd };
    case "local":
      return { memoryDir: join(cwd, ".pi", "agent-memory-local", agentName), scopeRoot: cwd };
  }
}

/**
 * Resolve the memory directory path for a given agent + scope + cwd.
 * Throws if agentName contains path traversal characters.
 */
export function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string {
  return resolveMemoryLocation(agentName, scope, cwd).memoryDir;
}

/**
 * Ensure the memory directory exists, creating it if needed.
 * Refuses to create or use directories if the target or any relative component
 * beneath the scope root is a symlink (including dangling symlinks), while
 * allowing OS-level symlink prefixes above the scope root (e.g. macOS `/var`).
 */
export function ensureMemoryDir(memoryDir: string, scopeRoot?: string): void {
  const root = scopeRoot ?? inferScopeRoot(memoryDir);
  const check = inspectPathBeneathRoot(memoryDir, root);

  if (check.status === "symlink") {
    const detail =
      check.symlinkPath === resolve(memoryDir)
        ? memoryDir
        : `${memoryDir} (symlink component: ${check.symlinkPath})`;
    throw new Error(`Refusing to use symlinked memory directory: ${detail}`);
  }
  if (check.status === "outside-root") {
    throw new Error(`Memory directory escapes scope root: ${memoryDir}`);
  }
  if (check.status === "error") {
    throw check.error;
  }

  if (check.exists) {
    if (!check.isDirectory) {
      throw new Error(`Memory path exists and is not a directory: ${memoryDir}`);
    }
    return;
  }
  mkdirSync(memoryDir, { recursive: true });
}

/**
 * Read the first N lines of MEMORY.md from the memory directory, if it exists.
 * Returns undefined if no MEMORY.md exists, or if MEMORY.md or any relative
 * component beneath the scope root is a symlink (including dangling symlinks).
 */
export function readMemoryIndex(memoryDir: string, scopeRoot?: string): string | undefined {
  const root = scopeRoot ?? inferScopeRoot(memoryDir);
  const memoryFile = join(memoryDir, "MEMORY.md");
  const check = inspectPathBeneathRoot(memoryFile, root);
  if (check.status !== "ok" || !check.exists || check.isDirectory) {
    return undefined;
  }

  const content = safeReadFile(memoryFile);
  if (content === undefined) return undefined;

  const lines = content.split("\n");
  if (lines.length > MAX_MEMORY_LINES) {
    return lines.slice(0, MAX_MEMORY_LINES).join("\n") + "\n... (truncated at 200 lines)";
  }
  return content;
}

/**
 * Build the memory block to inject into the agent's system prompt.
 * Also ensures the memory directory exists (creates it if needed).
 */
export function buildMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
  const { memoryDir, scopeRoot } = resolveMemoryLocation(agentName, scope, cwd);
  // Create the memory directory so the agent can immediately write to it
  ensureMemoryDir(memoryDir, scopeRoot);

  const existingMemory = readMemoryIndex(memoryDir, scopeRoot);

  const header = `# Agent Memory

You have a persistent memory directory at: ${memoryDir}/
Memory scope: ${scope}

This memory persists across sessions. Use it to build up knowledge over time.`;

  const memoryContent = existingMemory
    ? `\n\n## Current MEMORY.md\n${existingMemory}`
    : `\n\nNo MEMORY.md exists yet. Create one at ${join(memoryDir, "MEMORY.md")} to start building persistent memory.`;

  const instructions = `

## Memory Instructions
- MEMORY.md is an index file — keep it concise (under 200 lines). Lines after 200 are truncated.
- Store detailed memories in separate files within ${memoryDir}/ and link to them from MEMORY.md.
- Each memory file should use this frontmatter format:
  \`\`\`markdown
  ---
  name: <memory name>
  description: <one-line description>
  type: <user|feedback|project|reference>
  ---
  <memory content>
  \`\`\`
- Update or remove memories that become outdated. Check for existing memories before creating duplicates.
- You have Read, Write, and Edit tools available for managing memory files.`;

  return header + memoryContent + instructions;
}

/**
 * Build a read-only memory block for agents that lack write/edit tools.
 * Does NOT create the memory directory — agents can only consume existing memory.
 */
export function buildReadOnlyMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
  const { memoryDir, scopeRoot } = resolveMemoryLocation(agentName, scope, cwd);
  const existingMemory = readMemoryIndex(memoryDir, scopeRoot);

  const header = `# Agent Memory (read-only)

Memory scope: ${scope}
You have read-only access to memory. You can reference existing memories but cannot create or modify them.`;

  const memoryContent = existingMemory
    ? `\n\n## Current MEMORY.md\n${existingMemory}`
    : `\n\nNo memory is available yet. Other agents or sessions with write access can create memories for you to consume.`;

  return header + memoryContent;
}
