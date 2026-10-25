import type { Vcs } from "../types.ts";

/** Accepts a curated series only with the same tip tree, linear history above base, and no Herder trailers. */
export function acceptCuration(vcs: Vcs, base: string, head: string, tip: string): { ok: boolean; reason?: string } { throw new Error("not implemented"); }
