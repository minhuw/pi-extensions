/**
 * The bridge's view of its pane (NODE.md §4 "Pane status", §5): the root agent's state, background activities,
 * and the session, as one complete `BridgeStatus`. OSC 7501 is the daemon's primary source; this supplements it.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Activities } from "./activity.ts";
import { LIMITS, utf8Length, type BridgeStatus, type PaneSession, type PaneState } from "./protocol.ts";

/** Single-line text the daemon accepts as a label: controls removed, whitespace collapsed, cut to `max`. */
export function clean(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
	return text || undefined;
}

const absolute = (value: unknown): value is string =>
	typeof value === "string" && isAbsolute(value) && !value.includes("\0") && utf8Length(value) <= LIMITS.maxPathBytes;

function attempt<T>(read: () => T): T | undefined {
	try { return read(); } catch { return undefined; }
}

/** The session as the daemon accepts it; getters that throw (a stale context) leave fields out. */
export function describeSession(ctx: ExtensionContext | undefined): PaneSession | undefined {
	const manager = attempt(() => ctx?.sessionManager);
	const id = clean(attempt(() => manager?.getSessionId()), 160);
	const cwd = attempt(() => manager?.getCwd()) ?? attempt(() => ctx?.cwd);
	if (!id || !absolute(cwd)) return undefined;
	const session: PaneSession = { id, cwd };
	const name = clean(attempt(() => manager?.getSessionName()), 240);
	if (name) session.name = name;
	// Pi can name a transcript before it writes it; report only a file that exists.
	const file = attempt(() => manager?.getSessionFile());
	if (absolute(file) && attempt(() => statSync(file).isFile())) session.file = file;
	return session;
}

export function describeModel(ctx: ExtensionContext | undefined): string | undefined {
	const model = attempt(() => ctx?.model);
	return model ? clean(`${model.provider}/${model.id}`, 240) : undefined;
}

export class PaneStatus {
	readonly activities = new Activities();
	/** From `agent_start` to `agent_settled`; `agent_end` can precede a retry, compaction, or queued continuation. */
	parent = false;
	promptDepth = 0;

	agentStart(): void { this.parent = true; }
	agentSettled(): void { this.parent = false; }
	promptStart(): void { this.promptDepth++; }
	promptEnd(): void { if (this.promptDepth > 0) this.promptDepth--; }

	/** The root agent's state; the daemon adds activities (`activityCount`) when it merges. */
	get state(): PaneState {
		return this.promptDepth > 0 ? "waiting" : this.parent ? "busy" : "idle";
	}

	snapshot(ctx: ExtensionContext | undefined, now = Date.now()): BridgeStatus {
		const session = describeSession(ctx);
		const model = describeModel(ctx);
		return {
			state: this.state,
			activities: this.activities.entries(),
			activityCount: Math.min(this.activities.size, LIMITS.maxActivityCount),
			...(session ? { session } : {}),
			...(model ? { model } : {}),
			updatedAt: now,
		};
	}

	/** What the pane looks like once this pi is gone: idle, without activities, the session kept. */
	final(ctx: ExtensionContext | undefined, now = Date.now()): BridgeStatus {
		const session = describeSession(ctx);
		return { state: "idle", activities: [], activityCount: 0, ...(session ? { session } : {}), updatedAt: now };
	}

	clear(): void {
		this.parent = false;
		this.promptDepth = 0;
		this.activities.clear();
	}
}
