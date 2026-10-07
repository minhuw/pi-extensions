import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RunStore } from "../src/daemon/run-store.ts";
import { grantResumeRecovery, newResumeRecovery, previewResumeRecovery, type ResumeRecovery } from "../src/core/resume-recovery.ts";
import { stableJson } from "../src/shared/protocol.ts";

/** Runs under adapter ownership and its manager queue; cancellation is read-only. */
export async function confirmResumeRecovery(directory: string, ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	settle: () => Promise<void>, assertCurrent: () => void): Promise<ResumeRecovery | undefined> {
	const read = () => {
		const store = new RunStore(directory, { readOnly: true });
		try { return { run: store.getRun(), preview: previewResumeRecovery(store) }; }
		finally { store.close(); }
	};
	assertCurrent();
	const { preview } = read();
	if (!preview) return;
	if (!ctx.hasUI) throw new Error("Interrupted resume requires host confirmation");
	const request = newResumeRecovery(preview);
	if (!(await ctx.ui.confirm("Resume interrupted Herder work?", [
		`Run ${request.runId}, generation ${request.generation}`,
		...request.targets.map(t => `${t.planId}: retry ${t.role} in a NEW session\n${t.worktree}\nKeep HEAD ${t.head}${t.infrastructureRecoveries ? `; add ${t.infrastructureRecoveries} task recovery` : ""}`),
		"Keep manager-accepted DONE tasks and ALL commits. Discard staged, unstaged, and untracked changes (including user-created untracked files) ONLY in these interrupted worktrees. Keep ignored dependency setup and .herder assignments.",
		`Additional dispatch units: ${request.amount} (only the shortage for these retries). No new scope, acceptance, safety decision, or whole-budget refill.`,
	].join("\n\n")))) throw new Error("Resume cancelled; work and effort unchanged");
	assertCurrent();
	await settle();
	assertCurrent();
	const fresh = read();
	if (!fresh.run || stableJson(fresh.preview) !== stableJson(preview)) throw new Error("Interrupted work changed during confirmation; confirm resume again");
	grantResumeRecovery(fresh.run, request);
	return request;
}
