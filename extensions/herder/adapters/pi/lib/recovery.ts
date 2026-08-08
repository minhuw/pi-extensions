import type { TerminalEvent } from "../../../src/shared/protocol.ts";

export interface ActivePiAction {
	actionId: string;
	hostHandle?: string;
}

export function interruptedPiWorkers(
	active: readonly ActivePiAction[],
	hasWorker: (handle: string) => boolean,
): TerminalEvent[] {
	const missing = active.filter((item): item is ActivePiAction & { hostHandle: string } => Boolean(item.hostHandle) && !hasWorker(item.hostHandle!));
	const foreign = missing.find((item) => !item.hostHandle.startsWith("pi-worker:"));
	if (foreign) throw new Error(`Active action ${foreign.actionId} belongs to an incompatible Pi worker engine (${foreign.hostHandle}).`);
	return missing.map((item) => ({
		actionId: item.actionId,
		hostHandle: item.hostHandle,
		interrupted: true,
		error: "Pi host restarted before its in-process worker completed",
	}));
}
