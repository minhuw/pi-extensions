import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { dreamLimits, dreamRuntime } from "../../../memory/dream/index.ts";
import type { Batch, ChildEvent, DreamChild, DreamSession, Grant, Lease, SpawnOptions } from "../../../memory/dream/run.ts";
import type { Answer, FakePika, Recorded } from "./pika-server.ts";
import { PROJECT, PROJECT_SCOPE } from "./runtime.ts";

const DEFAULT_LIMITS = { ...dreamLimits };
const DEFAULT_SPAWN = dreamRuntime.spawn;
export const LEASE_ID = "lease-0001";

/** Puts the dream caps and the spawner back as they ship, and forgets the process's dreams. */
export function resetDreams(): void {
	Object.assign(dreamLimits, DEFAULT_LIMITS);
	dreamRuntime.spawn = DEFAULT_SPAWN;
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-extensions.pika.memory.dream")];
}

export function lease(fields: Partial<Lease> = {}): Lease {
	return {
		id: LEASE_ID, scope: PROJECT_SCOPE, mode: "auto", deviceId: "laptop", sessionId: null,
		grantedAt: "2026-11-08T10:00:00Z", expiresAt: "2026-11-08T10:15:00Z", releasedAt: null, outcome: null, ...fields,
	};
}

export function dreamSession(fields: Partial<DreamSession> = {}): DreamSession {
	return { id: "s-past-1", title: "Fix the flaky upload test", project: PROJECT, fromSeq: 3, toSeq: 41, lastAt: "2026-11-07T18:00:00Z", ...fields };
}

export function batch(fields: Partial<Batch> = {}): Batch {
	return {
		id: "batch-0001", leaseId: LEASE_ID, scope: PROJECT_SCOPE, mode: "auto", at: "2026-11-08T10:05:00Z", deviceId: "laptop", sessionId: null, dreamSessionId: null,
		summary: null, sessions: [], changes: [{ noteId: "aaaaaaaaaaaa", revision: 1, action: "save", title: "Pitfall", created: true }], revertedAt: null, ...fields,
	};
}

type Route = Answer | ((request: Recorded) => Answer);

/** The dream routes on a fake pika: a granted lease by default, and renew, commit, and release that succeed. */
export function serveDreams(pika: FakePika, options: { grant?: Grant; lease?: Route; renew?: Route; commit?: Route; release?: Route } = {}): void {
	const grant = options.grant ?? { lease: lease(), sessions: [dreamSession()] };
	pika.routes.set("POST memory/dream/lease", options.lease ?? ((request) => ({ body: { ...grant, lease: { ...grant.lease, mode: (request.body as { mode?: string }).mode ?? "auto" } } })));
	pika.routes.set(`POST memory/dream/${grant.lease.id}/renew`, options.renew ?? { body: { lease: { ...grant.lease, expiresAt: "2026-11-08T10:20:00Z" } } });
	pika.routes.set(`POST memory/dream/${grant.lease.id}/commit`, options.commit ?? { body: { batch: batch(), index: "# Project memory\n- Pitfall [aaaaaaaaaaaa]\n", indexBytes: 40, indexLines: 2 } });
	pika.routes.set(`POST memory/dream/${grant.lease.id}/release`, options.release ?? ((request) => ({ body: { lease: { ...grant.lease, releasedAt: "2026-11-08T10:30:00Z", outcome: (request.body as { outcome?: string }).outcome } } })));
}

export const leaseRequests = (pika: FakePika) => pika.requestsTo("memory/dream/lease");
export const releases = (pika: FakePika) => pika.requestsTo(`memory/dream/${LEASE_ID}/release`).map((request) => (request.body as { outcome: string }).outcome);
export const renewals = (pika: FakePika) => pika.requestsTo(`memory/dream/${LEASE_ID}/renew`);

/** A dream child whose run the test drives: `finish` ends its prompt, `emit` sends it events. */
export class FakeChild implements DreamChild {
	readonly sessionId = "dream-child-1";
	readonly sessionFile = undefined;
	readonly model: string;
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	aborts = 0;
	shutdowns = 0;
	stop: { stopReason?: string; errorMessage?: string } = { stopReason: "stop" };
	private listeners = new Set<(event: ChildEvent) => void>();
	private resolve?: () => void;

	constructor(readonly options: SpawnOptions) { this.model = `${options.model.provider}/${options.model.id}`; }

	subscribe(listener: (event: ChildEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	prompt(text: string) { this.prompts.push(text); return new Promise<void>((resolve) => { this.resolve = resolve; }); }
	async steer(text: string) { this.steers.push(text); }
	async abort() {
		this.aborts++;
		this.stop = { stopReason: "aborted" };
		this.resolve?.();
	}
	lastStop() { return this.stop; }
	async shutdown() { this.shutdowns++; }

	emit(event: ChildEvent): void { for (const listener of [...this.listeners]) listener(event); }
	/** Ends the child's prompt as the model would. */
	finish(stop: { stopReason?: string; errorMessage?: string } = { stopReason: "stop" }): void {
		this.stop = stop;
		this.resolve?.();
	}
	/** A tool the dream gave the child. */
	tool(name: string) {
		const tool = this.options.customTools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`no tool ${name}`);
		return tool;
	}
	/** Runs one of the child's tools as the model would, and returns its result text. */
	async call(name: string, params: unknown): Promise<{ text: string; isError: boolean; details: unknown }> {
		const result = await this.tool(name).execute("call-1", params as never, undefined, undefined, undefined as never);
		return { text: result.content.map((part) => part.type === "text" ? part.text : "").join(""), isError: Boolean((result as { isError?: boolean }).isError), details: result.details };
	}
}

/** Replaces the spawner with one making `FakeChild`ren; `children` lists them, newest last. */
export function fakeSpawner(): { children: FakeChild[]; spawns: SpawnOptions[] } {
	const record = { children: [] as FakeChild[], spawns: [] as SpawnOptions[] };
	dreamRuntime.spawn = async (options) => {
		record.spawns.push(options);
		const child = new FakeChild(options);
		record.children.push(child);
		return child;
	};
	return record;
}

/** A UI context that records notifications and footer statuses. */
export class RecordingUI {
	readonly notes: { message: string; type?: string }[] = [];
	readonly statuses: [string, string | undefined][] = [];
	status(key = "pika-memory"): string | undefined { return this.statuses.filter(([name]) => name === key).at(-1)?.[1]; }
	context(): ExtensionUIContext {
		const methods: Partial<ExtensionUIContext> = {
			notify: (message, type) => { this.notes.push({ message, type }); },
			setStatus: (key, text) => { this.statuses.push([key, text]); },
		};
		return new Proxy(methods, {
			get: (target, name) => name in target ? target[name as keyof ExtensionUIContext] : name === "then" ? undefined : () => undefined,
		}) as ExtensionUIContext;
	}
}
