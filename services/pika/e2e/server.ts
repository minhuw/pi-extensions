import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { sleep, waitFor } from "./util.ts";

export interface ServerOptions {
	bin: string;
	dataDir: string;
	port: number;
	basePath: string;
	/** Holds the running server's pid, so the script's trap can stop it on any exit. */
	pidFile: string;
	logFile: string;
}

/** The `pika serve` the script started, which the driver stops and starts again on the same port and data dir. */
export class PikaServer {
	readonly options: ServerOptions;

	constructor(options: ServerOptions) {
		this.options = options;
	}

	get url(): string { return `http://127.0.0.1:${this.options.port}${this.options.basePath}`; }

	private pid(): number | undefined {
		const text = readFileSync(this.options.pidFile, "utf8").trim();
		return text ? Number(text) : undefined;
	}

	async healthy(): Promise<boolean> {
		try {
			const response = await fetch(`${this.url}/api/health`);
			return response.status === 200;
		} catch {
			return false;
		}
	}

	async stop(): Promise<void> {
		const pid = this.pid();
		if (pid === undefined) return;
		try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
		await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 15_000, `pika ${pid} to exit`, 50);
		writeFileSync(this.options.pidFile, "");
		await waitFor(async () => !(await this.healthy()), 5_000, "the port to close");
	}

	async start(): Promise<void> {
		const { bin, dataDir, port, basePath, logFile } = this.options;
		const out = openSync(logFile, "a");
		// The password comes from PIKA_PASSWORD in the environment, as in the first start.
		const child = spawn(bin, ["serve", "--data-dir", dataDir, "--bind", `127.0.0.1:${port}`, "--base-path", basePath], {
			stdio: ["ignore", out, out], detached: false, env: process.env,
		});
		writeFileSync(this.options.pidFile, String(child.pid));
		child.unref();
		for (let attempt = 0; attempt < 200; attempt++) {
			if (await this.healthy()) return;
			if (child.exitCode !== null) break;
			await sleep(50);
		}
		throw new Error(`pika did not come back on port ${port}; see ${logFile}`);
	}
}
