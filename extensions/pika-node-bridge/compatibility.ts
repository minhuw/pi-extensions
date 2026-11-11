/**
 * One bridge per pane (after `extensions/orca-bridge/compatibility.ts`). In-process child sessions (subagents,
 * Herder steps) load extensions again on the same `globalThis`, so a process-global registry keeps only the
 * first; child pi processes inherit the environment, so `PIKA_NODE_BRIDGE_OWNER` names the live owner pid.
 */
import { PANE_ENV, SOCKET_ENV } from "./protocol.ts";

const OWNER_REGISTRY = Symbol.for("pi-extensions.pika-node-bridge.owners");
export const OWNER_ENV = "PIKA_NODE_BRIDGE_OWNER";
type Registry = Map<string, object>;
export type Activation = { mode: "active"; socket: string; pane: string; release(): void } | { mode: "inactive"; reason: string };

function ownerAlive(value: string): boolean {
	const pid = Number(value);
	if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as { code?: string } | null)?.code !== "ESRCH"; }
}

export function activate(): Activation {
	const socket = process.env[SOCKET_ENV];
	const pane = process.env[PANE_ENV];
	if (!socket?.trim() || !pane?.trim()) return { mode: "inactive", reason: `${SOCKET_ENV} or ${PANE_ENV} is absent` };
	const self = String(process.pid);
	const previous = process.env[OWNER_ENV];
	if (previous && previous !== self && ownerAlive(previous)) return { mode: "inactive", reason: "pane belongs to another live process" };
	let registry = Reflect.get(globalThis, OWNER_REGISTRY) as Registry | undefined;
	if (!(registry instanceof Map)) {
		registry = new Map();
		Reflect.set(globalThis, OWNER_REGISTRY, registry);
	}
	if (registry.has(pane)) return { mode: "inactive", reason: "bridge already active for this pane" };
	const owner = {};
	registry.set(pane, owner);
	process.env[OWNER_ENV] = self;
	return {
		mode: "active",
		socket,
		pane,
		release() {
			if (registry.get(pane) !== owner) return;
			registry.delete(pane);
			if (!registry.size && Reflect.get(globalThis, OWNER_REGISTRY) === registry) Reflect.deleteProperty(globalThis, OWNER_REGISTRY);
			if (process.env[OWNER_ENV] === self) {
				if (previous === undefined) delete process.env[OWNER_ENV];
				else process.env[OWNER_ENV] = previous;
			}
		},
	};
}
