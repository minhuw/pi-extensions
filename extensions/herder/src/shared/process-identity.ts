import fs from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

export function nativeProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

/** Native birth identity, never a command-name heuristic. Failure is deliberately fatal. */
export function nativeProcessIdentity(pid: number): string {
	if (process.platform === "linux") {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (!ticks || !/^\d+$/.test(ticks)) throw new Error("Cannot read Pi process start ticks");
		return `linux:${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
	}
	if (process.platform === "darwin") {
		const birth = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8", timeout: 2_000, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C" },
		}).trim();
		if (!birth) throw new Error("Cannot read Pi process birth identity");
		return `darwin:${birth}`;
	}
	throw new Error("Safe Pi process identity is unsupported on this platform; exit the owning Pi once.");
}

