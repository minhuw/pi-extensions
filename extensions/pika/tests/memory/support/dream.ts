import { afterEach, beforeEach, vi } from "vitest";
import { currentDream, dreamLimits, dreamRuntime } from "../../../memory/dream/index.ts";
import type { Batch, ChildEvent, DreamChild, DreamSession, Grant, Lease, SpawnOptions } from "../../../memory/dream/run.ts";
import { type Answer, FakePika, type Route } from "../../support/pika-server.ts";
import { RecordingUI } from "../../support/runtime.ts";
import { type Harness, PROJECT, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./runtime.ts";

export { RecordingUI };

const DEFAULT_LIMITS = { ...dreamLimits };
const DEFAULT_SPAWN = dreamRuntime.spawn;
export const LEASE_ID = "lease-0001";
export const SOURCES = [{ sessionId: "s-past-1", seq: 7 }];
export const SAVE = {
	expectedRevision: 0, scope: "project", category: "project",
	title: "Pitfall", hook: "run npm ci first", body: "Tests need node_modules.", sources: SOURCES,
};

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

export interface ServeDreamOptions { grant?: Grant; lease?: Route; renew?: Route; commit?: Route; release?: Route }

/** The dream routes on a fake pika: a granted lease by default, and renew, commit, and release that succeed. */
export function serveDreams(pika: FakePika, options: ServeDreamOptions = {}): void {
	const grant = options.grant ?? { lease: lease(), sessions: [dreamSession()] };
	pika.routes.set("POST memory/dream/lease", options.lease ?? ((request) => ({ body: { ...grant, lease: { ...grant.lease, mode: (request.body as { mode?: string }).mode ?? "auto" } } })));
	pika.routes.set(`POST memory/dream/${grant.lease.id}/renew`, options.renew ?? { body: { lease: { ...grant.lease, expiresAt: "2026-11-08T10:20:00Z" } } });
	pika.routes.set(`POST memory/dream/${grant.lease.id}/commit`, options.commit ?? { body: { batch: batch(), index: "# Project memory\n- Pitfall [aaaaaaaaaaaa]\n", indexBytes: 40, indexLines: 2 } });
	pika.routes.set(`POST memory/dream/${grant.lease.id}/release`, options.release ?? ((request) => ({ body: { lease: { ...grant.lease, releasedAt: "2026-11-08T10:30:00Z", outcome: (request.body as { outcome?: string }).outcome } } })));
}

export const leaseRequests = (pika: FakePika) => pika.requestsTo("memory/dream/lease");
export const releases = (pika: FakePika) => pika.requestsTo(`memory/dream/${LEASE_ID}/release`).map((request) => (request.body as { outcome: string }).outcome);
export const renewals = (pika: FakePika) => pika.requestsTo(`memory/dream/${LEASE_ID}/renew`);
export const commits = (pika: FakePika, leaseId = LEASE_ID) => pika.requestsTo(`memory/dream/${leaseId}/commit`);

/** Fake timers for dream timeouts and intervals; the session's own work and loopback server run on real I/O. */
export const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

/** Waits real time on `setImmediate`, which fake timers leave alone, for `check` or, without one, about 150 ms. */
export async function settle(check?: () => boolean, ms = check ? 5_000 : 150): Promise<boolean> {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) {
		if (check?.()) return true;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return check?.() ?? true;
}

export async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
	if (!await settle(check, ms)) throw new Error(`timed out waiting for ${what}`);
}

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
export function fakeSpawner(createChild: (options: SpawnOptions) => FakeChild = (options) => new FakeChild(options)): { children: FakeChild[]; spawns: SpawnOptions[] } {
	const record = { children: [] as FakeChild[], spawns: [] as SpawnOptions[] };
	dreamRuntime.spawn = async (options) => {
		record.spawns.push(options);
		const child = createChild(options);
		record.children.push(child);
		return child;
	};
	return record;
}

export type FakeSpawner = ReturnType<typeof fakeSpawner>;

export interface DreamEnvOptions {
	/** `GET memory` route; defaults to empty notes and `index` (`""`). */
	memory?: Route;
	/** Shorthand for the `index` field in the default `GET memory` response (ignored when `memory` is set). */
	index?: string;
	/** Route overrides passed to `serveDreams(pika, routes)`. */
	routes?: ServeDreamOptions;
	/** Install a `fakeSpawner()` in `beforeEach` and expose it as `env.spawner`. Pass a factory to customize `FakeChild`. */
	spawner?: boolean | ((options: SpawnOptions) => FakeChild);
	/** Start a default session in `beforeEach` and expose it as `env.h`. */
	session?: boolean | Omit<Parameters<typeof startSession>[0], "workspace">;
	/** Pass `ui: env.ui.context()` to `env.start()` by default; default `true`. */
	defaultUi?: boolean;
	/** Extra setup run in `beforeEach` after `workspace` and `pika` are ready, before any default session starts. */
	beforeEach?: (env: DreamEnv) => void | Promise<void>;
	/** Extra teardown run at the start of `afterEach`, before stopping the dream. */
	beforeTeardown?: (env: DreamEnv) => void | Promise<void>;
	/** Extra teardown run in `afterEach` after stopping servers, before workspace cleanup. */
	afterTeardown?: (env: DreamEnv) => void | Promise<void>;
}

export interface DreamEnv {
	readonly workspace: Workspace;
	readonly pika: FakePika;
	readonly ui: RecordingUI;
	/** Available when `spawner` was enabled in `useDreamEnv`. */
	readonly spawner: FakeSpawner;
	/** Available when `session` was enabled in `useDreamEnv`. */
	readonly h: Harness;
	/** Starts a session in `workspace` and tracks it for `afterEach` shutdown. */
	start(options?: Omit<Parameters<typeof startSession>[0], "workspace">): Promise<Harness>;
	/** Registers an extra `FakePika` server to be stopped in `afterEach`. */
	addServer(server: FakePika): FakePika;
}

const envSpawners = new WeakMap<DreamEnv, () => FakeSpawner | undefined>();

/** Registers `beforeEach`/`afterEach` hooks for dream tests: workspace, fake pika, dream routes, sessions, and teardown. */
export function useDreamEnv(options: DreamEnvOptions = {}): DreamEnv {
	let workspace!: Workspace;
	let pika!: FakePika;
	let ui!: RecordingUI;
	let spawner: FakeSpawner | undefined;
	let defaultHarness: Harness | undefined;
	const open: Harness[] = [];
	const extraServers: FakePika[] = [];

	const env: DreamEnv = {
		get workspace() { return workspace; },
		get pika() { return pika; },
		get ui() { return ui; },
		get spawner() {
			if (!spawner) throw new Error("useDreamEnv({ spawner: true }) is required to access env.spawner");
			return spawner;
		},
		get h() {
			if (!defaultHarness) throw new Error("useDreamEnv({ session: true }) is required to access env.h");
			return defaultHarness;
		},
		async start(startOptions = {}) {
			const base = options.defaultUi === false ? {} : { ui: ui.context() };
			const harness = await startSession({ workspace, ...base, ...startOptions });
			open.push(harness);
			return harness;
		},
		addServer(server) {
			extraServers.push(server);
			return server;
		},
	};
	envSpawners.set(env, () => spawner);

	beforeEach(async () => {
		workspace = await Workspace.create();
		pika = await new FakePika().start();
		pika.routes.set("GET memory", options.memory ?? { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: options.index ?? "" } });
		serveDreams(pika, options.routes);
		setCredentials(pika.url);
		resetDreams();
		spawner = typeof options.spawner === "function" ? fakeSpawner(options.spawner) : options.spawner ? fakeSpawner() : undefined;
		ui = new RecordingUI();
		defaultHarness = undefined;
		await options.beforeEach?.(env);
		if (options.session) defaultHarness = await env.start(options.session === true ? {} : options.session);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await options.beforeTeardown?.(env);
		currentDream()?.stop("stopped", "the test ended");
		await currentDream()?.done;
		for (const harness of open.splice(0)) await harness.shutdown();
		defaultHarness = undefined;
		spawner = undefined;
		resetDreams();
		for (const server of [pika, ...extraServers.splice(0)]) await server.stop();
		await options.afterTeardown?.(env);
		await workspace.cleanup();
	});

	return env;
}

export interface DreamStartOptions {
	/** Session to prompt `/memory dream` in; defaults to `env.h` when passing a `DreamEnv`. */
	session?: Harness;
	/** Reuse an already-installed `fakeSpawner()`; defaults to `env.spawner` if enabled, otherwise installs a fresh one. */
	spawner?: FakeSpawner;
	/** Customize or subclass the `FakeChild` created by a fresh spawner. */
	createChild?: (options: SpawnOptions) => FakeChild;
	/** Fake pika server to configure when `memory`, `routes`, or `answers` is given (inferred from `DreamEnv`). */
	pika?: FakePika;
	/** Override the `GET memory` route before starting the dream. */
	memory?: Route;
	/** Route overrides passed to `serveDreams` before starting the dream. */
	routes?: ServeDreamOptions;
	/** Commit answers returned in turn, repeating the last one. */
	answers?: readonly Answer[];
}

/** Starts a dream via `/memory dream` with a `FakeChild` and returns the child once it has its kickoff. */
export async function dream(target: DreamEnv | Harness, options: DreamStartOptions = {}): Promise<FakeChild> {
	const env = envSpawners.has(target as DreamEnv) ? (target as DreamEnv) : undefined;
	const h = options.session ?? (env ? env.h : target as Harness);
	const pika = options.pika ?? env?.pika;
	if (options.memory !== undefined) {
		if (!pika) throw new Error("dream({ memory }) requires a DreamEnv or options.pika");
		pika.routes.set("GET memory", options.memory);
	}
	if (options.routes || options.answers) {
		if (!pika) throw new Error("dream({ routes | answers }) requires a DreamEnv or options.pika");
		let n = 0;
		const answers = options.answers;
		serveDreams(pika, {
			...options.routes,
			...(answers ? { commit: () => answers[Math.min(n++, answers.length - 1)]! } : {}),
		});
	}
	const spawner = options.spawner ?? (options.createChild ? fakeSpawner(options.createChild) : (env ? envSpawners.get(env)?.() : undefined) ?? fakeSpawner());
	const before = spawner.children.length;
	await h.session.prompt("/memory dream");
	await until(() => spawner.children.length > before && spawner.children.at(-1)?.prompts.length === 1, "the kickoff");
	return spawner.children.at(-1)!;
}
