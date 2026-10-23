import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Optional @aliou/pi-processes integration. This is its in-process, synchronous
// request/reply protocol (verified against 0.13.2), not a package dependency.
const CHANGED = "processes:changed";
const REQUEST_LIST = "processes:request:list";
export const PROCESS_STATUS_KEY = "pi-processes";

export function summarizeProcesses(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const counts = { running: 0, stopping: 0, stuck: 0, failed: 0, done: 0, killed: 0 };
	for (const process of value) {
		if (!process || typeof process !== "object") continue;
		switch (process.status) {
			case "running": counts.running++; break;
			case "terminating": counts.stopping++; break;
			case "terminate_timeout": counts.stuck++; break;
			case "killed": counts.killed++; break;
			case "exited":
				if (process.success === true) counts.done++;
				else counts.failed++;
				break;
		}
	}
	const parts = Object.entries(counts).filter(([, count]) => count > 0)
		.map(([label, count]) => `${count} ${label}`);
	return parts.length ? `bg ${parts.join(" · ")}` : undefined;
}

export function watchProcesses(
	events: ExtensionAPI["events"],
	publish: (status: string | undefined) => void,
): () => void {
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let previousStatus: string | undefined;
	let published = false;
	const refresh = () => {
		if (closed) return;
		clearTimeout(timer);
		timer = undefined;
		let status: string | undefined;
		let hasLiveProcesses = false;
		events.emit(REQUEST_LIST, {
			reply: (processes: unknown) => {
				if (closed) return;
				status = summarizeProcesses(processes);
				hasLiveProcesses = Array.isArray(processes) && processes.some((process) =>
					process && ["running", "terminating", "terminate_timeout"].includes(process.status));
			},
		});
		if (closed) return;
		if (!published || previousStatus !== status) {
			published = true;
			previousStatus = status;
			publish(status);
		}
		// Upstream does not broadcast transitions to terminating/terminate_timeout.
		// Reconcile metadata while jobs are live; this never starts a model turn.
		if (hasLiveProcesses) {
			timer = setTimeout(refresh, 2_000);
			timer.unref?.();
		}
	};
	const unsubscribe = events.on(CHANGED, refresh);
	refresh();
	return () => {
		closed = true;
		clearTimeout(timer);
		unsubscribe();
	};
}
