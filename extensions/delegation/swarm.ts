import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMode } from "./switch.ts";

const NAME = "swarm";
const SESSION_MODES = Symbol.for("pi-extensions.session-modes");
const ON_PREFIX = "Swarm mode 🐝 is on";
const ON_TEXT = `${ON_PREFIX}: the user explicitly opts in to background agents, so this session stays free to answer them and other pi sessions that message it through pika relay, which reach it only between turns. `
	+ "Work as the coordinator: run each development task that needs more than a few quick tool calls or a long command (implementation, tests, builds, benchmarks, broad research) in background agents (Agent with run_in_background: true; worker for changes and verification, recon for research), "
	+ "split into independent pieces launched together in one message, each with a self-contained prompt or inherit_context: true that names the files it owns, the files it must not touch, and the command that shows it is done. "
	+ "Track the pieces on swarm_board when it is available; agents read it and post their progress and blockers there. "
	+ 'Give concurrent writers isolation: "worktree" when their files could overlap, and apply the branches they report. '
	+ "Then end your turn at once, telling the user what is running; do not wait, sleep, or poll. An agent's completion notification starts a new turn. "
	+ "Between them, answer the user and relay messages yourself, use steer_subagent to redirect a running agent and get_subagent_result for its details. "
	+ "Keep direct tools for answers, short lookups, and small edits. Check agents' changes before reporting them. This overrides more conservative subagent guidance.";
const OFF_PREFIX = "Swarm mode is off";

const configPath = () => join(getAgentDir(), "swarm.json");

/** The default for fresh sessions (`true` when unconfigured). An invalid file falls back to `true`, with a warning when `ctx` is given. */
async function readDefault(ctx?: ExtensionContext): Promise<boolean> {
	const path = configPath();
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as { default?: unknown } | null;
		if (typeof parsed?.default === "boolean") return parsed.default;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
	}
	try { ctx?.ui.notify(`Ignoring ${path}: expected { "default": true } or { "default": false }. Using on.`, "warning"); } catch {}
	return true;
}

async function writeDefault(enabled: boolean): Promise<void> {
	const path = configPath();
	const temporary = `${path}.${randomUUID()}.tmp`;
	await mkdir(getAgentDir(), { recursive: true });
	try {
		await writeFile(temporary, `${JSON.stringify({ default: enabled })}\n`, { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** The modes each top-level session has on, shared in the process: Relay reads it, as a room's representative needs swarm mode. */
interface SessionModesRegistry {
	/** Mode names ("swarm") active on each top-level session's current branch, by session id. */
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

/** Keep "swarm" in the session's set exactly while the mode is on, and tell every listener about a change. */
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
 * `/swarm`, on by default in fresh sessions: the session coordinates background agents and stays free for its user and
 * relay messages, published in the session modes registry for relay. Returns whether swarm mode applies to a context's
 * session and branch.
 */
export function registerSwarm(pi: ExtensionAPI): (ctx: ExtensionContext) => boolean {
	const isSwarmOn = registerMode(pi, {
		name: NAME,
		description: "Toggle swarm mode 🐝, background agents so the session keeps answering: /swarm [on | off | status | default [on | off]]",
		status: "🐝 swarm",
		onPrefix: ON_PREFIX,
		onText: ON_TEXT,
		offPrefix: OFF_PREFIX,
		offText: `${OFF_PREFIX}. Ignore earlier swarm mode instructions: long tasks no longer have to run in background agents, and the standard subagent guidance applies unless another mode says otherwise.`,
		sectionText: `${ON_TEXT} A later swarm mode message overrides this.`,
		notes: {
			isOn: "Swarm mode 🐝 is on.",
			isOff: "Swarm mode is off.",
			on: "Swarm mode 🐝 on: the model runs long tasks in background agents and ends its turns, so it answers you and relay messages meanwhile. Takes effect with the next prompt; usage may increase.",
			off: "Swarm mode off. Takes effect with the next prompt.",
			alreadyOn: "Swarm mode 🐝 is already on.",
			alreadyOff: "Swarm mode is already off.",
		},
		defaults: { read: readDefault, write: writeDefault },
		onState: (ctx, active) => publish(ctx.sessionManager.getSessionId(), active),
	});
	// Only eligible sessions are ever published, so any other has nothing to remove.
	pi.on("session_shutdown", async (_event, ctx) => { publish(ctx.sessionManager.getSessionId(), false); });
	return isSwarmOn;
}
