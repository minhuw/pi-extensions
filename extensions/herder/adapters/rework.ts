import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ReworkEditBinding {
	planDirectory: string;
	planId: string;
	editToken: string;
	recoverOnFinish?: boolean;
	finishPending?: boolean;
}

export type ReworkEditOperation = "prepare_edit" | "confirm_edit" | "cancel_edit";

export function reworkBindingAfterReply(
	binding: ReworkEditBinding | undefined,
	operation: "finish_edit" | "cancel_edit" | undefined,
	reply: { planEdit?: unknown },
): ReworkEditBinding | undefined {
	return operation && !reply.planEdit ? undefined : binding;
}

export async function prepareReworkFinish(
	binding: ReworkEditBinding,
	request: { planDirectory: string; editToken?: string },
	ctx: ExtensionContext,
	runtime: {
		edit: (operation: ReworkEditOperation) => Promise<void>;
		settle: () => Promise<void>;
	},
): Promise<void> {
	if (request.planDirectory !== binding.planDirectory || request.editToken !== binding.editToken) {
		throw new Error("Herder rework finish is not bound to this exact plan directory and edit token.");
	}
	if (!ctx.hasUI) throw new Error("Herder rework requires an interactive destructive confirmation.");
	try {
		await runtime.edit("prepare_edit");
		const approved = await ctx.ui.confirm(
			`Rework Herder plan ${binding.planId}?`,
			`This target-local worker settlement and reset will stop only plan ${binding.planId}'s workers; delete that plan's exact worktree, branch, and transient refs; mark its prior attempts as superseded history; and recreate it from the current integration HEAD at round 1. Other plans and workers remain untouched.`,
		);
		if (!approved) throw new Error("Herder rework cancelled; the pre-interview graph was restored and existing execution was left untouched.");
		await runtime.edit("confirm_edit");
	} catch (error) {
		await runtime.edit("cancel_edit");
		throw error;
	}
	await runtime.settle();
}
