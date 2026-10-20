/** Compatibility with Orca's installed Pi status extension. No installed-module imports. */
const OWNER_REGISTRY = Symbol.for("pi-extensions.orca-bridge.owners");
type Registry = Map<string, object>;
interface ManagedRoster { active: Set<string>; onEvent: (...args: unknown[]) => unknown }
export type Activation = { mode: "managed" | "standalone"; release(): void } | { mode: "inactive"; reason: string };

function ownerAlive(value: string): boolean {
	const pid = Number(value);
	if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as { code?: string } | null)?.code !== "ESRCH"; }
}
function managedPresent(): boolean {
	try {
		const roster = Reflect.get(globalThis, "__orcaPiSubagents") as ManagedRoster | undefined;
		return process.env.ORCA_PI_STATUS_OWNED === String(process.pid) && roster?.active instanceof Set && typeof roster.onEvent === "function";
	} catch { return false; }
}
export function activate(): Activation {
	const pane = process.env.ORCA_PANE_KEY;
	if (!pane?.trim()) return { mode: "inactive", reason: "ORCA_PANE_KEY is absent" };
	const self = String(process.pid);
	const previous = process.env.ORCA_PI_STATUS_OWNED;
	if (previous && previous !== self && ownerAlive(previous)) return { mode: "inactive", reason: "pane belongs to another live process" };
	let registry = Reflect.get(globalThis, OWNER_REGISTRY) as Registry | undefined;
	if (!(registry instanceof Map)) {
		registry = new Map();
		Reflect.set(globalThis, OWNER_REGISTRY, registry);
	}
	if (registry.has(pane)) return { mode: "inactive", reason: "bridge already active for this pane" };
	const managed = managedPresent();
	if (!managed && !process.env.ORCA_AGENT_HOOK_ENDPOINT && !process.env.ORCA_AGENT_HOOK_PORT) return { mode: "inactive", reason: "hook endpoint is not configured" };
	const owner = {};
	registry.set(pane, owner);
	if (!managed) process.env.ORCA_PI_STATUS_OWNED = self;
	return {
		mode: managed ? "managed" : "standalone",
		release() {
			if (registry.get(pane) !== owner) return;
			registry.delete(pane);
			if (!registry.size && Reflect.get(globalThis, OWNER_REGISTRY) === registry) Reflect.deleteProperty(globalThis, OWNER_REGISTRY);
			if (!managed && process.env.ORCA_PI_STATUS_OWNED === self) {
				if (previous === undefined) delete process.env.ORCA_PI_STATUS_OWNED;
				else process.env.ORCA_PI_STATUS_OWNED = previous;
			}
		},
	};
}

/** Own only the IDs we announced; never clear or mutate the managed roster. */
export class ManagedRelay {
	private owned = new Map<string, { label: string; source: string }>();
	constructor(private emit: (channel: string, value: unknown) => void) {}
	sync(rows: Array<{ key: string; label: string; source: string }>): void {
		const next = new Map(rows.map(row => [row.key, row]));
		// Add before removing, so replacing a final child cannot create an idle gap.
		for (const [id, row] of next) {
			if (this.owned.has(id)) continue;
			this.owned.set(id, row);
			this.send(id, row, "started");
		}
		for (const [id, row] of this.owned) {
			if (next.has(id)) continue;
			this.owned.delete(id);
			this.send(id, row, "completed");
		}
	}
	/** Read current foreign activity on every paint/check; never alter Orca's Set. */
	foreignCount(): number {
		try {
			const roster = Reflect.get(globalThis, "__orcaPiSubagents") as ManagedRoster | undefined;
			if (!(roster?.active instanceof Set)) return 0;
			let count = 0;
			for (const id of roster.active) if (!this.owned.has(id)) count++;
			return count;
		} catch { return 0; }
	}
	private send(id: string, row: { label: string; source: string }, status: string): void {
		try { this.emit("task:subagent:lifecycle", { id, status, agent: row.label, description: `${row.source}: ${row.label}` }); }
		catch { /* A receiver failure must not fail producer work. */ }
	}
	close(): void { this.sync([]); }
}
