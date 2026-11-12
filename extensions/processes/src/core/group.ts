import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** True while any member of process group `pgid` exists (EPERM still means it exists). */
export function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

/** Signals process group `pgid`; false when it no longer exists. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

/** Polls every 100 ms until the group is gone or `ms` elapse; true when gone. */
export async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (groupAlive(pgid)) {
		if (Date.now() >= deadline) return false;
		await delay(100);
	}
	return true;
}

/** SIGTERM, then SIGKILL after `graceMs`, then one more second before declaring the group stuck. */
export async function terminateGroup(pgid: number, graceMs: number): Promise<"terminated" | "killed" | "stuck"> {
	signalGroup(pgid, "SIGTERM");
	if (await waitGroupGone(pgid, graceMs)) return "terminated";
	signalGroup(pgid, "SIGKILL");
	return (await waitGroupGone(pgid, 1000)) ? "killed" : "stuck";
}

// $1: owner pid, $2: process group id. Exits once the group is gone; kills it if the owner dies first.
// No `--` before the negative pid: dash (Debian's /bin/sh) rejects it, which made the loop exit at once.
const WATCHDOG = `while kill -0 "-$2" 2>/dev/null; do
	if ! kill -0 "$1" 2>/dev/null; then kill -KILL "-$2" 2>/dev/null; exit 0; fi
	sleep 1
done`;

/**
 * Starts a detached `/bin/sh` that SIGKILLs group `pgid` if `ownerPid` dies while the
 * group is alive, so a crashed Pi leaves no orphaned servers.
 */
export function spawnWatchdog(ownerPid: number, pgid: number) {
	const child = spawn("/bin/sh", ["-c", WATCHDOG, "processes-watchdog", String(ownerPid), String(pgid)], { detached: true, stdio: "ignore" });
	child.on("error", (error) => {
		throw new Error(`Process watchdog for group ${pgid} failed: ${error.message}`);
	});
	child.unref();
	return child;
}
