import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { groupAlive, signalGroup, spawnWatchdog } from "../../src/core/group.ts";

async function until(condition: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return true;
}

const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

it("kills the group once the owner process dies", async () => {
	const group = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	const owner = spawn("sleep", ["0.3"], { stdio: "ignore" });
	try {
		const watchdog = spawnWatchdog(owner.pid!, group.pid!);
		expect(groupAlive(group.pid!)).toBe(true);
		await once(owner, "exit");
		expect(await until(() => !groupAlive(group.pid!), 3000)).toBe(true);
		expect(await until(() => !pidAlive(watchdog.pid!), 3000)).toBe(true);
	} finally {
		signalGroup(group.pid!, "SIGKILL");
		owner.kill("SIGKILL");
	}
});

it("exits on its own once the group is gone while the owner lives", async () => {
	const group = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	try {
		const watchdog = spawnWatchdog(process.pid, group.pid!);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(pidAlive(watchdog.pid!)).toBe(true);
		signalGroup(group.pid!, "SIGKILL");
		expect(await until(() => !pidAlive(watchdog.pid!), 3000)).toBe(true);
	} finally {
		signalGroup(group.pid!, "SIGKILL");
	}
});
