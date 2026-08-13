/**
 * Keep Orca's pane in the running state while Herder or subagents work
 * after the parent Pi turn has settled.
 *
 * Orca's injected `orca-agent-status` only forwards root `agent_start` /
 * `agent_end`. Child sessions load no extensions, and the parent becomes
 * idle as soon as Fire or Agent returns. This coordinator re-posts the
 * same loopback hook events Orca already understands.
 */

type Source = "herder" | "subagents";
type Action = "start" | "end" | null;

export interface OrcaBusyContext {
	isIdle(): boolean;
	ui?: { setTitle?(title: string): void };
}

const HOOK_POST_TIMEOUT_MS = 1000;
const TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function present(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function orcaBusyAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return present(env.ORCA_PANE_KEY) && (present(env.ORCA_AGENT_HOOK_PORT) || present(env.ORCA_AGENT_HOOK_ENDPOINT));
}

export class OrcaBusyGate {
	herder = false;
	subagents = false;
	held = false;

	want(): boolean {
		return this.herder || this.subagents;
	}

	set(source: Source, active: boolean, parentIdle: boolean): Action {
		if (source === "herder") this.herder = active;
		else this.subagents = active;
		return this.transition(parentIdle);
	}

	onParentSettled(parentIdle: boolean): Action {
		if (this.want() && parentIdle) {
			this.held = true;
			return "start";
		}
		return this.transition(parentIdle);
	}

	private transition(parentIdle: boolean): Action {
		const want = this.want();
		if (want && parentIdle && !this.held) {
			this.held = true;
			return "start";
		}
		if (!want && this.held && parentIdle) {
			this.held = false;
			return "end";
		}
		return null;
	}
}

function readEndpointFile(path: string): Record<string, string> {
	try {
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const out: Record<string, string> = {};
		for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
			const match = /^(?:set\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
			if (match) out[match[1]!] = match[2]!.replace(/\r$/, "");
		}
		return out;
	} catch {
		return {};
	}
}

function hookCoords(env: NodeJS.ProcessEnv = process.env): { port?: string; token?: string } {
	const file = present(env.ORCA_AGENT_HOOK_ENDPOINT) ? readEndpointFile(env.ORCA_AGENT_HOOK_ENDPOINT) : {};
	return {
		port: file.ORCA_AGENT_HOOK_PORT || env.ORCA_AGENT_HOOK_PORT,
		token: file.ORCA_AGENT_HOOK_TOKEN || env.ORCA_AGENT_HOOK_TOKEN,
	};
}

async function postHook(eventName: string, extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const coords = hookCoords(env);
	const paneKey = env.ORCA_PANE_KEY;
	if (!coords.port || !coords.token || !present(paneKey)) return;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HOOK_POST_TIMEOUT_MS);
	timer.unref?.();
	try {
		await fetch(`http://127.0.0.1:${coords.port}/hook/pi`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Orca-Agent-Hook-Token": coords.token,
			},
			body: JSON.stringify({
				paneKey,
				launchToken: env.ORCA_AGENT_LAUNCH_TOKEN || "",
				tabId: env.ORCA_TAB_ID || "",
				worktreeId: env.ORCA_WORKTREE_ID || "",
				env: env.ORCA_AGENT_HOOK_ENV || "",
				version: env.ORCA_AGENT_HOOK_VERSION || "",
				payload: { hook_event_name: eventName, ...extra },
			}),
			signal: controller.signal,
		});
	} catch {
		/* Orca absence must never fail Herder or subagents. */
	} finally {
		clearTimeout(timer);
	}
}

function activityLabel(gate: OrcaBusyGate): string {
	if (gate.herder && gate.subagents) return "Herder + subagents";
	if (gate.herder) return "Herder";
	return "subagents";
}

export class OrcaBusyCoordinator {
	readonly gate = new OrcaBusyGate();
	private titleTimer: ReturnType<typeof setInterval> | undefined;
	private titleFrame = 0;
	private lastTitle: ((title: string) => void) | undefined;

	set(source: Source, active: boolean, ctx: OrcaBusyContext | undefined): void {
		if (!ctx || !orcaBusyAvailable()) return;
		this.apply(this.gate.set(source, active, safeIdle(ctx)), ctx);
	}

	onParentSettled(ctx: OrcaBusyContext | undefined): void {
		if (!ctx || !orcaBusyAvailable()) return;
		this.apply(this.gate.onParentSettled(safeIdle(ctx)), ctx);
	}

	private apply(action: Action, ctx: OrcaBusyContext): void {
		if (action === "start") {
			const label = activityLabel(this.gate);
			void postHook("agent_start", { source: "pi-extensions", activity: label });
			void postHook("tool_execution_start", { tool_name: this.gate.herder ? "herder" : "Agent", tool_input: { activity: label } });
			this.startTitle(ctx, label);
		} else if (action === "end") {
			void postHook("tool_execution_end", { tool_name: "herder" });
			void postHook("agent_end", { source: "pi-extensions" });
			this.stopTitle(ctx);
		}
	}

	private startTitle(ctx: OrcaBusyContext, label: string): void {
		const setTitle = ctx.ui?.setTitle;
		if (!setTitle) return;
		this.stopTitle(ctx);
		this.lastTitle = setTitle;
		const cwd = process.cwd().split(/[\\/]/).filter(Boolean).at(-1) || process.cwd();
		this.titleTimer = setInterval(() => {
			const frame = TITLE_FRAMES[this.titleFrame % TITLE_FRAMES.length];
			this.titleFrame += 1;
			try { setTitle(`${frame} π ${label} - ${cwd}`); } catch { /* title is best-effort */ }
		}, 80);
		this.titleTimer.unref?.();
	}

	private stopTitle(ctx: OrcaBusyContext): void {
		if (this.titleTimer) {
			clearInterval(this.titleTimer);
			this.titleTimer = undefined;
		}
		this.titleFrame = 0;
		const setTitle = ctx.ui?.setTitle ?? this.lastTitle;
		this.lastTitle = undefined;
		if (!setTitle) return;
		const cwd = process.cwd().split(/[\\/]/).filter(Boolean).at(-1) || process.cwd();
		try { setTitle(`π - ${cwd}`); } catch { /* title is best-effort */ }
	}
}

function safeIdle(ctx: OrcaBusyContext): boolean {
	try { return ctx.isIdle(); } catch { return true; }
}

export const orcaBusy = new OrcaBusyCoordinator();
