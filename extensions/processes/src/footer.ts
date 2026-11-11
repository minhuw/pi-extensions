// Answers statusline-footer's process protocol (the one @aliou/pi-processes defined): it emits REQUEST_LIST with a
// synchronous `reply` and refreshes on CHANGED. Statuses are mapped onto that protocol's vocabulary.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessInfo, ProcessManager } from "./types.ts";

export const CHANGED = "processes:changed";
export const REQUEST_LIST = "processes:request:list";

export type FooterStatus = "running" | "terminating" | "exited" | "killed";

export function footerProcess(process: ProcessInfo): Omit<ProcessInfo, "status"> & { status: FooterStatus; success: boolean } {
	switch (process.status) {
		case "starting":
		case "running":
		case "ready":
			return { ...process, status: "running", success: false };
		case "stopping":
			return { ...process, status: "terminating", success: false };
		case "exited":
			return { ...process, status: "exited", success: process.exitCode === 0 };
		case "stopped":
			return { ...process, status: "killed", success: false };
	}
}

/** Serves list requests from `manager()` until the returned function is called. */
export function serveFooter(events: ExtensionAPI["events"], manager: () => ProcessManager | undefined): () => void {
	return events.on(REQUEST_LIST, (data) => {
		const { reply } = data as { reply?: unknown };
		if (typeof reply !== "function") throw new Error(`${REQUEST_LIST} needs a reply function.`);
		reply((manager()?.list() ?? []).filter((process) => !process.attached).map(footerProcess));
	});
}

export function announceChange(events: ExtensionAPI["events"]): void {
	events.emit(CHANGED, {});
}
