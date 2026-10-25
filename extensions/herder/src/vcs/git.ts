import type { Vcs } from "../types.ts";

/** Throws a clear error when git is missing or older than 2.38; checked once per process. */
export function requireGit(): string { throw new Error("not implemented"); }

export function openVcs(cwd: string): Vcs { throw new Error("not implemented"); }
