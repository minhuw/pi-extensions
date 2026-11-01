/**
 * context-files.ts — AGENTS.md / CLAUDE.md loading for agents with
 * `context_files: true`.
 *
 * Mirrors pi's own discovery (the agent dir's global file first, then the cwd
 * and its ancestors, outermost first, one file per directory with the same
 * candidate names) with one difference: the walk stops at the first directory
 * that contains a `.git` entry. A linked worktree's root holds a `.git` *file*,
 * so a child working in a worktree nested inside its main checkout loads the
 * worktree's AGENTS.md and not the main checkout's.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Pi's candidate names, in its precedence order (first match per directory wins). */
const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface ContextFile {
  path: string;
  content: string;
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function loadContextFileFromDir(dir: string): ContextFile | undefined {
  for (const name of CONTEXT_FILE_NAMES) {
    const path = join(dir, name);
    try {
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      return { path, content: stripBom(readFileSync(path, "utf-8")) };
    } catch {
      // Unreadable: try the next candidate, as pi does.
    }
  }
  return undefined;
}

/** Context files for `cwd`, bounded at the nearest directory holding a `.git` entry. */
export function loadBoundedContextFiles(cwd: string, agentDir: string): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  const global = loadContextFileFromDir(resolve(agentDir));
  if (global) {
    files.push(global);
    seen.add(global.path);
  }
  const ancestors: ContextFile[] = [];
  let dir = resolve(cwd);
  for (;;) {
    const file = loadContextFileFromDir(dir);
    if (file && !seen.has(file.path)) {
      ancestors.unshift(file);
      seen.add(file.path);
    }
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...files, ...ancestors];
}
