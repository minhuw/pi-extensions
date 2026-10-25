import type { Vcs } from "../types.ts";
import { hasHerderTrailer } from "../vcs/git.ts";

/** Accepts a curated series only with the same tip tree, linear history above base, and no Herder trailers. */
export function acceptCuration(vcs: Vcs, base: string, head: string, tip: string): { ok: boolean; reason?: string } {
	if (tip === base) return { ok: false, reason: "the curator left HEAD at the base" };
	if (vcs.treeOf(tip) !== vcs.treeOf(head)) return { ok: false, reason: "the curated tip's tree differs from the verified tree" };
	for (let commit = tip; commit !== base; ) {
		const parents = vcs.parentsOf(commit);
		if (parents.length !== 1) return { ok: false, reason: parents.length ? `commit ${commit} is a merge; history above the base must be linear` : "the curated series does not descend from the base" };
		if (hasHerderTrailer(vcs.message(commit))) return { ok: false, reason: `commit ${commit} carries a Herder trailer` };
		commit = parents[0]!;
	}
	return { ok: true };
}
