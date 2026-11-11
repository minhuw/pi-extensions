import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMode } from "./switch.ts";

const NAME = "alwayson";
const SESSION_MODES = Symbol.for("pi-extensions.session-modes");
const ON_PREFIX = "Always-on mode 📡 is on";
const ON_TEXT = `${ON_PREFIX}: the user wants this session to stay responsive to them and to other pi sessions that message it through pika relay, which reach it only between turns, and explicitly opts in to background agents. `
	+ "Run every development task that needs more than a few quick tool calls or a long command (implementation, tests, builds, benchmarks, broad research) in a background agent: Agent with run_in_background: true, worker for changes and verification, recon for research, "
	+ "with a self-contained prompt or inherit_context: true. Then end your turn at once, telling the user what is running; do not wait, sleep, or poll. An agent's completion notification starts a new turn. "
	+ "Between them, answer the user and relay messages yourself, and use steer_subagent to redirect a running agent and get_subagent_result for its details. "
	+ 'Give concurrent writers isolation: "worktree" when their files could overlap, and apply the branches they report. '
	+ "Keep direct tools for answers, short lookups, and small edits. Check agents' changes before reporting them. This overrides more conservative subagent guidance.";
const OFF_PREFIX = "Always-on mode is off";

/** The modes each top-level session has on, shared in the process: Relay reads it, as a room's representative needs always-on mode. */
interface SessionModesRegistry {
	/** Mode names ("alwayson") active on each top-level session's current branch, by session id. */
	modes: Map<string, Set<string>>;
	/** Called with a session id whenever its set changes. */
	listeners: Set<(sessionId: string) => void>;
}

/** The registry, created here unless its reader came first. */
function sessionModes(): SessionModesRegistry {
	const shared = globalThis as Record<symbol, unknown>;
	let registry = shared[SESSION_MODES] as SessionModesRegistry | undefined;
	if (!registry) {
		registry = { modes: new Map(), listeners: new Set() };
		shared[SESSION_MODES] = registry;
	}
	return registry;
}

/** Keep "alwayson" in the session's set exactly while the mode is on, and tell every listener about a change. */
function publish(sessionId: string, active: boolean): void {
	const registry = sessionModes();
	const modes = registry.modes.get(sessionId);
	if (active === (modes?.has(NAME) ?? false)) return;
	if (active) {
		if (modes) modes.add(NAME);
		else registry.modes.set(sessionId, new Set([NAME]));
	} else if (modes) {
		modes.delete(NAME);
		if (modes.size === 0) registry.modes.delete(sessionId);
	}
	for (const listener of [...registry.listeners]) {
		try {
			const result: unknown = listener(sessionId);
			// An async listener's rejection would otherwise go unhandled.
			if (result instanceof Promise) result.catch(() => {});
		} catch {}
	}
}

/**
 * `/alwayson`: long tasks go to background agents so the session stays free for its user and relay messages, published
 * in the session modes registry for relay.
 */
export function registerAlwaysOn(pi: ExtensionAPI): void {
	registerMode(pi, {
		name: NAME,
		description: "Toggle always-on mode 📡, long tasks in background agents so the session keeps answering: /alwayson [on | off | status]",
		status: "📡 alwayson",
		onPrefix: ON_PREFIX,
		onText: ON_TEXT,
		offPrefix: OFF_PREFIX,
		offText: `${OFF_PREFIX}. Ignore earlier always-on mode instructions: long tasks no longer have to run in background agents, and the standard subagent guidance applies unless another mode says otherwise.`,
		sectionText: `${ON_TEXT} A later always-on mode message overrides this.`,
		notes: {
			isOn: "Always-on mode 📡 is on.",
			isOff: "Always-on mode is off.",
			on: "Always-on mode 📡 on: the model runs long tasks in background agents and ends its turns, so it answers you and relay messages meanwhile. Takes effect with the next prompt; usage may increase.",
			off: "Always-on mode off. Takes effect with the next prompt.",
			alreadyOn: "Always-on mode 📡 is already on.",
			alreadyOff: "Always-on mode is already off.",
		},
		onState: (ctx, active) => publish(ctx.sessionManager.getSessionId(), active),
	});
	// Only eligible sessions are ever published, so any other has nothing to remove.
	pi.on("session_shutdown", async (_event, ctx) => { publish(ctx.sessionManager.getSessionId(), false); });
}
