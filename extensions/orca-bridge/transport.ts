import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function endpoint(env: NodeJS.ProcessEnv = process.env): { port: number; token: string; env: string; version: string } | undefined {
	const file: Record<string, string> = Object.create(null);
	try {
		if (env.ORCA_AGENT_HOOK_ENDPOINT) {
			// Small local configuration, re-read for every request to survive Orca restart.
			const stat = statSync(env.ORCA_AGENT_HOOK_ENDPOINT);
			if (!stat.isFile() || stat.size > 16384) return;
			for (const line of readFileSync(env.ORCA_AGENT_HOOK_ENDPOINT, "utf8").split(/\r?\n/)) {
				const match = /^(?:set\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
				if (match) file[match[1]!] = match[2]!;
			}
		}
	} catch { /* Missing endpoint files fall back to inherited coordinates. */ }
	const value = (key: string): string => file[key] || env[key] || "";
	const rawPort = value("ORCA_AGENT_HOOK_PORT");
	const port = Number(rawPort);
	const token = value("ORCA_AGENT_HOOK_TOKEN");
	if (!env.ORCA_PANE_KEY?.trim() || !/^\d{1,5}$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535 || !token.trim() || /[\r\n]/.test(token)) return;
	return { port, token, env: value("ORCA_AGENT_HOOK_ENV"), version: value("ORCA_AGENT_HOOK_VERSION") };
}

/** Read afresh at send time: Pi can publish a transcript path before creating it. */
export function sessionMetadata(ctx: ExtensionContext | undefined): Record<string, string> {
	try {
		const manager = ctx?.sessionManager;
		const file = manager?.getSessionFile();
		if (typeof file !== "string" || !isAbsolute(file) || !statSync(file).isFile()) return {};
		const id = manager?.getSessionId();
		return { session_file: file, ...(typeof id === "string" && id ? { session_id: id } : {}) };
	} catch { return {}; }
}

export type Hook = { hook_event_name: string; [key: string]: unknown };
/** One active request and one replaceable pending status; no retry backlog. */
export class HookTransport {
	lastResult = "not sent";
	private pending: Hook | undefined;
	private running: Promise<void> | undefined;
	private cancel: (() => void) | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;
	constructor(private metadata: () => Record<string, string>) {}
	post(hook: Hook): void {
		if (this.closed) return;
		this.pending = hook;
		this.drain();
	}
	private drain(): void {
		if (this.running || this.closed || !this.pending) return;
		const hook = this.pending;
		this.pending = undefined;
		this.running = this.send(hook).finally(() => {
			this.running = undefined;
			this.drain();
		});
	}
	private async send(hook: Hook): Promise<void> {
		const coords = endpoint();
		if (!coords) { this.lastResult = "endpoint unavailable"; return; }
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let finish: (result: string) => void = () => {};
		const interrupted = new Promise<string>(resolve => { finish = resolve; });
		this.cancel = () => { finish("cancelled"); controller.abort(); };
		timer = setTimeout(() => { finish("timeout"); controller.abort(); }, 1000);
		timer.unref?.();
		try {
			const result = await Promise.race([
				fetch(`http://127.0.0.1:${coords.port}/hook/pi`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Orca-Agent-Hook-Token": coords.token },
					body: JSON.stringify({
						paneKey: process.env.ORCA_PANE_KEY,
						launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || "",
						tabId: process.env.ORCA_TAB_ID || "",
						worktreeId: process.env.ORCA_WORKTREE_ID || "",
						env: coords.env,
						version: coords.version,
						payload: { ...this.metadata(), ...hook },
					}),
					signal: controller.signal,
				}).then(response => `HTTP ${response.status}${response.ok ? " OK" : " error"}`, () => "network error"),
				interrupted,
			]);
			this.lastResult = result;
		} catch { this.lastResult = "transport error"; }
		finally { clearTimeout(timer); this.cancel = undefined; }
	}
	/** Cancel obsolete work before the final, bounded completion post. */
	close(final?: Hook): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.pending = undefined;
		this.cancel?.();
		this.closing = (async () => {
			await this.running;
			if (final) await this.send(final);
		})();
		return this.closing;
	}
}
