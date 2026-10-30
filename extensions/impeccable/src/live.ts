import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveEngine, spawnEngine, type EngineProcess, type ResolveEngineOptions, type ResolvedEngine } from "./engine.ts";
import { object, optionalText, physicalPath, resolveDirectory, serialized, type ObjectValue } from "./project.ts";

export const LIVE_MESSAGE = "impeccable-live-event";
export const LIVE_SNAPSHOT = "impeccable-live-owner";
const actionable = new Set(["generate", "steer", "accept", "discard", "manual_edit_apply", "variant_mount_failed", "prefetch", "carbonize_cleanup"]);
const idOK = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}$/.test(id);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
	const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
	const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
	const timer = setTimeout(done, ms); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
});

export interface LiveSaved {
	version: 1; sessionId: string; root: string; ids: string[]; phase: string;
	pending?: { file: string; hash: string; id: string; token: string; receivedAt: number };
}
export interface Pending { id: string; token: string; event: ObjectValue; file: string; hash: string; receivedAt: number }
export interface LiveReply { id: string; eventToken: string; status: "done" | "steer_done" | "error" | "complete" | "verified" | "read"; file?: string; data?: unknown; message?: string }
export interface LiveView {
	ok: boolean; phase: string; root?: string; owner: string; message?: string; result?: unknown;
	engine?: { binary: string; trustedOverride: boolean };
	pending?: { id: string; eventToken: string; receivedAt: number; event: ObjectValue | { payloadPath: string; bytes: number }; protocolAcknowledged: boolean };
}

/** Validate the native envelope without narrowing away optional scaffold, provenance or repair fields. */
export function validateLiveEvent(value: unknown): ObjectValue {
	if (!object(value) || typeof value.type !== "string") throw new Error("Malformed native live event");
	const type = value.type;
	if (["timeout", "exit"].includes(type)) return value;
	if (!actionable.has(type)) throw new Error(`Unknown native live event ${type}; recover with status/resume`);
	if (type !== "prefetch" && !idOK(value.id)) throw new Error(`${type}: malformed native id`);
	if (type === "generate") {
		if (!Number.isInteger(value.count) || Number(value.count) < 1 || Number(value.count) > 8) throw new Error("generate: invalid count");
		if (value.mode === "insert") {
			if (!object(value.insert) || !["before", "after"].includes(String(value.insert.position)) || !object(value.insert.anchor) || !object(value.placeholder) || !Number.isFinite(value.placeholder.width) || !Number.isFinite(value.placeholder.height) || !(typeof value.freeformPrompt === "string" && value.freeformPrompt.trim() || Array.isArray(value.comments) && value.comments.length || Array.isArray(value.strokes) && value.strokes.length)) throw new Error("generate: malformed insert context");
		} else if (typeof value.action !== "string" || !value.action.trim() || !object(value.element) || typeof value.element.outerHTML !== "string" || !value.element.outerHTML) throw new Error("generate: missing action/element context");
	}
	if (type === "steer" && (typeof value.message !== "string" || !value.message.trim())) throw new Error("steer: missing message");
	if (type === "prefetch" && (typeof value.pageUrl !== "string" || !value.pageUrl)) throw new Error("prefetch: missing pageUrl");
	if (type === "manual_edit_apply" && (!object(value.batch) || !Array.isArray(value.batch.entries) || !value.batch.entries.length || typeof value.pageUrl !== "string" || !Number.isFinite(value.deadlineMs))) throw new Error("manual_edit_apply: missing batch/page/deadline");
	if (type === "variant_mount_failed" && (!Number.isInteger(value.variant) || typeof value.url !== "string" || typeof value.error !== "string")) throw new Error("variant_mount_failed: missing variant/url/error");
	if (type === "accept" && (typeof value.variantId !== "string" || !/^\d{1,3}$/.test(value.variantId))) throw new Error("accept: missing variantId");
	if (["accept", "discard"].includes(type) && (!object(value._acceptResult) || !object(value._completionAck))) throw new Error(`${type}: missing native transaction result/acknowledgement`);
	if (type === "carbonize_cleanup" && (!idOK(value.sessionId) || typeof value.file !== "string")) throw new Error("carbonize_cleanup: missing session/file");
	return value;
}

/** A dedicated live lease; never holds the shared source/config queues while polling. */
async function lease(root: string, sessionId: string, activation: string): Promise<() => Promise<void>> {
	const base = path.join(os.tmpdir(), `pi-impeccable-live-locks-${process.getuid?.() ?? "user"}`);
	await mkdir(base, { recursive: true, mode: 0o700 });
	const info = await lstat(base);
	if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error("Unsafe live lease directory");
	const lock = path.join(base, digest(root));
	return serialized(`live-lease:${root}`, async () => {
		const guard = `${lock}.acquiring`;
		try { await mkdir(guard, { mode: 0o700 }); }
		catch { throw new Error("Live lease acquisition is busy or interrupted; inspect the owning process before recovery"); }
		try {
			try { await mkdir(lock, { mode: 0o700 }); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const previous: unknown = JSON.parse(await optionalText(path.join(lock, "owner.json")) ?? "null");
				// Only the SAME persisted Pi session can reclaim its proven-dead process.
				if (!object(previous) || previous.sessionId !== sessionId || typeof previous.pid !== "number" || alive(previous.pid)) throw new Error("Live project is owned by another activation/session/process; stop it there first");
				await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
			}
			const owner = await lstat(lock);
			await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, sessionId, activation }), { mode: 0o600 });
			return async () => serialized(`live-lease:${root}`, async () => {
				const current = await lstat(lock).catch(() => undefined);
				if (current?.ino === owner.ino && current.dev === owner.dev) { await rm(path.join(lock, "owner.json"), { force: true }); await rmdir(lock); }
			});
		} finally { await rmdir(guard); }
	});
}

/** Session resource owner. Native CLI owns all transport, source transactions and journal transitions. */
export class LiveOwner {
	readonly activation = randomUUID();
	phase = "stopped";
	root?: string;
	pending?: Pending;
	result?: unknown;
	message?: string;
	private ids: string[] = [];
	private controller = new AbortController();
	private resolved?: ResolvedEngine;
	private processes = new Set<EngineProcess>();
	private helper?: EngineProcess;
	private helperInfo?: ObjectValue;
	private release?: () => Promise<void>;
	private directory?: string;
	private job?: Promise<void>;
	private history = new Set<string>();
	private closing?: Promise<void>;
	private replying = false;
	readonly sessionId: string;
	private readonly changed: (owner: LiveOwner) => void;
	private readonly options: ResolveEngineOptions & { env?: NodeJS.ProcessEnv };
	constructor(sessionId: string, changed: (owner: LiveOwner) => void, options: ResolveEngineOptions & { env?: NodeJS.ProcessEnv } = {}) {
		this.sessionId = sessionId; this.changed = changed; this.options = options;
	}

	saved(): LiveSaved | undefined {
		return this.root ? { version: 1, sessionId: this.sessionId, root: this.root, ids: this.ids.slice(-64), phase: this.phase,
			...(this.pending ? { pending: { file: this.pending.file, hash: this.pending.hash, id: this.pending.id, token: this.pending.token, receivedAt: this.pending.receivedAt } } : {}) } : undefined;
	}
	view(): LiveView {
		const event = this.pending?.event;
		const raw = event ? JSON.stringify(event) : "";
		return { ok: !["paused", "error"].includes(this.phase), owner: this.activation, phase: this.phase, root: this.root, message: this.message, result: this.result, engine: this.resolved ? { binary: this.resolved.binary, trustedOverride: this.resolved.trustedOverride } : undefined,
			...(this.pending ? { pending: { id: this.pending.id, eventToken: this.pending.token, receivedAt: this.pending.receivedAt, event: Buffer.byteLength(raw) > 16_000 ? { payloadPath: this.pending.file, bytes: Buffer.byteLength(raw) } : this.pending.event, protocolAcknowledged: this.acknowledged(this.pending.event) } } : {}) };
	}
	private notify() { this.changed(this); }
	private acknowledged(event: ObjectValue) { return object(event._completionAck) && event._completionAck.ok === true && ["complete", "discarded", "agent_done"].includes(String(event._completionAck.type)); }
	private async native(argv: string[], cwd: string, timeout = 120_000): Promise<ObjectValue> {
		const signal = this.controller.signal;
		signal.throwIfAborted();
		this.resolved ??= await resolveEngine({ ...this.options, signal });
		signal.throwIfAborted();
		const proc = spawnEngine(this.resolved, argv, { cwd, env: { ...this.options.env, IMPECCABLE_LIVE_COPY_AGENT: "chat" } });
		this.processes.add(proc);
		const abort = () => proc.cancel();
		signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => proc.cancel("timeout"), timeout); timer.unref?.();
		try {
			const exit = await proc.exited;
			signal.throwIfAborted();
			if (proc.stdout.truncated || proc.stderr.truncated) {
				const file = path.join(await this.storage(), "overflow.txt");
				await writeFile(file, proc.stdout.text(), { mode: 0o600 });
				this.result = { payloadPath: file, truncated: true, bytes: Buffer.byteLength(proc.stdout.text()) };
				throw new Error("Native live output exceeded 4 MiB capture bound; JSON was not parsed; recover from native journal/status");
			}
			const text = proc.stdout.text();
			if (Buffer.byteLength(text) > 16_000) {
				const file = path.join(await this.storage(), "raw.json");
				await writeFile(file, text, { mode: 0o600 });
				this.result = { payloadPath: file, bytes: Buffer.byteLength(text), note: "Complete raw bounded native stdout; validate before use" };
			}
			let value: unknown;
			try { value = JSON.parse(text); } catch { throw new Error(`Invalid native JSON (${argv[0]}): ${proc.stderr.text().slice(0, 4000)}`); }
			if (!object(value)) throw new Error(`Invalid native result (${argv[0]})`);
			if (exit.code !== 0 || proc.reason || proc.spawnError) {
				this.result = await this.presentation(value);
				throw new Error(`Native ${argv[0]} failed: ${proc.reason ?? proc.spawnError?.message ?? (proc.stderr.text().slice(0, 4000) || `exit ${exit.code}`)}`);
			}
			if (value.ok === false) {
				this.result = await this.presentation(value);
				throw new Error(`Native ${argv[0]} business refusal: inspect result; native work retained`);
			}
			return value;
		} finally { clearTimeout(timer); signal.removeEventListener("abort", abort); this.processes.delete(proc); }
	}
	private async storage() { return this.directory ??= await mkdtemp(path.join(await resolveDirectory(os.tmpdir()), "pi-impeccable-live-")); }
	private async presentation(value: ObjectValue): Promise<ObjectValue> {
		const text = JSON.stringify(value);
		if (Buffer.byteLength(text) <= 16_000) return value;
		const file = path.join(await this.storage(), "result.json");
		await writeFile(file, text, { mode: 0o600 });
		return { payloadPath: file, bytes: Buffer.byteLength(text), note: "Complete bounded native JSON; read before acting. Not truncated JSON." };
	}
	private background(work: () => Promise<void>) {
		const signal = this.controller.signal;
		this.job = work().catch(async (error: unknown) => {
			if (signal.aborted) return;
			this.phase = "paused"; this.message = String(error);
			try { await this.releaseResources(); }
			catch (cleanup) { this.message += `; cleanup needs inspection: ${String(cleanup)}`; }
			this.notify();
		});
	}
	private async acquire(root: string) {
		this.root = await resolveDirectory(root);
		this.release = await lease(this.root, this.sessionId, this.activation);
	}
	private async ensureHelper() {
		const root = this.root!;
		const file = path.join(root, ".impeccable/live/server.json");
		const raw: unknown = JSON.parse(await optionalText(file) ?? "null");
		if (object(raw) && typeof raw.pid === "number" && alive(raw.pid)) {
			this.helperInfo = raw; // Reused helper is NEVER ours to stop.
			const status = await this.native(["live-status", "--target", root], root);
			if (!object(status.liveServer) || status.liveServer.port !== raw.port) throw new Error("Recorded helper failed native authenticated live-status; left untouched");
			return;
		}
		this.resolved ??= await resolveEngine({ ...this.options, signal: this.controller.signal });
		this.controller.signal.throwIfAborted();
		const helper = spawnEngine(this.resolved, ["live-server", "--target", root], { cwd: root, env: { ...this.options.env, IMPECCABLE_LIVE_COPY_AGENT: "chat" } });
		this.helper = helper;
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline) {
			this.controller.signal.throwIfAborted();
			const info: unknown = JSON.parse(await optionalText(file) ?? "null");
			if (object(info) && info.pid === helper.child.pid) { this.helperInfo = info; return; }
			if (helper.child.exitCode !== null || helper.spawnError) throw new Error(`Owned helper failed to start: ${helper.stderr.text().slice(0, 2000)}`);
			await sleep(25, this.controller.signal);
		}
		throw new Error("Owned helper startup timed out");
	}
	private async checkIdentity(boot?: ObjectValue) {
		const root = this.root!;
		const manifest: unknown = JSON.parse(await optionalText(path.join(root, ".impeccable/live/roots.json")) ?? "null");
		if (!object(manifest) || typeof manifest.appRoot !== "string" || await resolveDirectory(manifest.appRoot) !== root || typeof manifest.sessionRoot !== "string" || await physicalPath(manifest.sessionRoot) !== path.join(root, ".impeccable/live")) throw new Error("Invalid native roots manifest; polling refused");
		if (boot && (typeof boot.projectRoot !== "string" || await resolveDirectory(boot.projectRoot) !== root || !object(boot.roots) || await physicalPath(String(boot.roots.appRoot)) !== root || !Array.isArray(boot.pageFiles) || boot.pageFiles.some((file) => typeof file !== "string") || boot.serverPort !== this.helperInfo?.port || boot.serverToken !== this.helperInfo?.token)) throw new Error("Native boot connection/root mismatch; polling refused");
		const current: unknown = JSON.parse(await optionalText(path.join(root, ".impeccable/live/server.json")) ?? "null");
		if (!object(current) || current.pid !== this.helperInfo?.pid || current.port !== this.helperInfo?.port || current.token !== this.helperInfo?.token || typeof current.port !== "number" || current.port < 1 || current.port > 65535 || typeof current.token !== "string" || !current.token) throw new Error("Native helper identity changed; delivery/replies refused");
	}
	start(cwd: string, argv: string[], generate: boolean) {
		if (!["stopped", "paused"].includes(this.phase) || this.pending || this.release) throw new Error("Live owner already exists; use status/resume/stop");
		if (this.closing) throw new Error("Live cleanup still in progress");
		this.controller = new AbortController(); this.phase = "starting"; this.message = undefined; this.result = undefined;
		this.background(async () => {
			const base = await resolveDirectory(cwd);
			// Native --check supplies the actual resolved app/config path before any helper is created.
			const targets = argv.flatMap((arg, i) => arg === "--target" || arg === "-t" ? ["--target", argv[i + 1] ?? ""] : arg.startsWith("--target=") ? [arg] : []);
			const check = await this.native(["live-inject", "--check", ...targets], base);
			this.result = await this.presentation(check);
			if (check.ok !== true || typeof check.path !== "string") throw new Error("Native live config prerequisite failed; follow live-setup.md and inspect result");
			if (!object(check.config) || check.config.cspChecked !== true) throw new Error("Live setup/CSP check required; follow live-setup.md consent before starting");
			const root = path.dirname(path.dirname(path.dirname(check.path)));
			if (await physicalPath(check.path) !== path.join(await resolveDirectory(root), ".impeccable/live/config.json")) throw new Error("Noncanonical live config override cannot establish safe ownership");
			await this.acquire(root);
			const status = await this.native(["live-status", "--target", root], root);
			if (!Array.isArray(status.activeSessions)) throw new Error("Malformed native live-status");
			if (status.activeSessions.length) throw new Error("Existing recoverable upstream work; use this session's resume metadata, never adopt by shared cwd");
			await this.ensureHelper();
			const boot = await this.native(["live", ...(generate ? [...targets, "--allow-missing-context", "--dev-url", "--no-live-bar"] : argv)], base);
			this.result = await this.presentation(boot);
			if (boot.ok !== true) throw new Error("Native boot refused; inspect result and retain upstream prerequisite handling");
			await this.checkIdentity(boot); this.controller.signal.throwIfAborted(); this.notify();
			if (generate) {
				// No poller exists while live-generate leases its own generate event.
				const lane = await this.native(["live-generate", ...argv.filter((arg) => arg !== "--boot"), "--target", root], base, 240_000);
				this.result = await this.presentation(lane);
				if (lane.ok !== true) throw new Error("Native generate refused; inspect result");
				if (lane.event !== null && lane.event !== undefined) { await this.receive(lane.event); return; }
			}
			this.controller.signal.throwIfAborted(); this.phase = "polling"; this.notify(); await this.poll();
		});
		this.notify(); return this.view();
	}
	private async receive(value: unknown) {
		this.controller.signal.throwIfAborted();
		const event = validateLiveEvent(value);
		if (event.type === "timeout") { this.phase = "paused"; this.message = "Native poll timed out; resume retains upstream work"; await this.releaseResources(); this.notify(); return; }
		if (event.type === "exit") { this.phase = "stopped"; this.message = "Native exit; canonical journal retained"; await this.releaseResources(); this.notify(); return; }
		const raw = JSON.stringify(event); const hash = digest(raw);
		if (this.history.has(hash)) throw new Error("Duplicate native event after acknowledgement; inspect status/resume");
		if (this.pending) throw new Error("Cannot replace pending live work");
		const file = path.join(await this.storage(), "event.json"); await writeFile(file, raw, { mode: 0o600 });
		this.pending = { id: typeof event.id === "string" ? event.id : `prefetch-${randomUUID()}`, token: randomUUID(), event, file, hash, receivedAt: Date.now() };
		for (const id of [event.id, event.sessionId]) if (idOK(id) && !this.ids.includes(id)) this.ids.push(id);
		this.ids = this.ids.slice(-64);
		this.phase = this.controller.signal.aborted ? "paused" : "pending"; this.notify();
	}
	private async poll() {
		await this.checkIdentity();
		const event = await this.native(["live-poll", "--target", this.root!], this.root!, 660_000);
		await this.checkIdentity(); await this.receive(event);
	}
	async status() {
		if (this.root && this.release && !this.controller.signal.aborted) this.result = await this.presentation(await this.native(["live-status", "--target", this.root], this.root));
		return this.view();
	}
	/** live-resume intentionally omits terminal snapshots. Prove terminal state from the native append-only journal. */
	private async terminal(id: string, expected: string[]) {
		if (!idOK(id)) return false;
		const file = path.join(this.root!, ".impeccable/live/sessions", `${id}.jsonl`);
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("Native journal unavailable or exceeds recovery bound; inspect manually");
		const rows: unknown[] = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const last = rows.findLast((row) => object(row) && row.id === id && ["complete", "discarded", "generate", "accept", "agent_error"].includes(String(row.type)));
		return object(last) && expected.includes(String(last.type));
	}
	async reply(reply: LiveReply) {
		const pending = this.pending;
		if (!pending || reply.id !== pending.id || reply.eventToken !== pending.token || this.phase !== "pending" || !this.release) throw new Error("Wrong/stale event id or token; resume the owning Pi session first");
		if (this.replying) throw new Error("Live reply already in progress");
		this.replying = true;
		try { return await this.applyReply(reply); }
		catch (error) {
			await this.pause(`Reply failed; inspect native status/resume before retry: ${String(error)}`);
			throw error;
		} finally { this.replying = false; }
	}
	private async applyReply(reply: LiveReply) {
		const pending = this.pending;
		if (!pending || reply.id !== pending.id || reply.eventToken !== pending.token || this.phase !== "pending" || !this.release) throw new Error("Wrong/stale event id or token; resume the owning Pi session first");
		if (pending.event.type === "manual_edit_apply" && pending.receivedAt + Number(pending.event.deadlineMs) <= Date.now()) throw new Error("Manual Apply relative soft deadline elapsed; inspect native status/resume");
		await this.checkIdentity();
		const event = pending.event;
		const type = String(event.type);
		let result: ObjectValue;
		if (["accept", "discard", "carbonize_cleanup"].includes(type)) {
			const ack = event._completionAck;
			const finalAck = object(ack) && ack.ok === true && ["complete", "discarded"].includes(String(ack.type)) && ack.requiresComplete !== true;
			if (reply.status === "complete" && reply.message?.trim() && !finalAck) {
				result = await this.native(["live-complete", "--id", String(event.sessionId ?? event.id), ...(type === "discard" ? ["--discarded"] : []), "--target", this.root!], this.root!);
				if (result.ok !== true || result.id !== (event.sessionId ?? event.id) || !["completed", "discarded"].includes(String(result.phase))) throw new Error("Native completion refused or not terminal; work remains pending");
			} else if (reply.status === "verified" && finalAck && reply.message?.trim()) {
				// Plain native accepts/discards are already acknowledged. Verify, never reply twice.
				result = await this.native(["live-resume", "--id", String(event.id), "--target", this.root!], this.root!);
				if (result.active !== false || !await this.terminal(String(event.id), [type === "discard" ? "discarded" : "complete"])) throw new Error("Native journal does not prove terminal accept/discard");
			} else throw new Error("Accept/discard requires accept-time verification: verified + evidence for an already terminal native ack, or complete after canonical cleanup; no duplicate poll reply");
		} else if (type === "prefetch") {
			if (reply.status !== "read") throw new Error("Prefetch requires read (no native protocol reply)");
			result = { ok: true, prefetchRead: true };
		} else {
			const allowed = reply.status === "error" || reply.status === (type === "steer" ? "steer_done" : "done");
			if (!allowed) throw new Error(`Invalid reply status for ${type}`);
			if (["generate", "variant_mount_failed"].includes(type) && reply.status === "done" && !reply.file) throw new Error("Publish/retry requires the exact source/manifest file");
			if (type === "steer" && reply.status === "steer_done" && !reply.file && !reply.message?.trim()) throw new Error("Steer requires a source file or intentional no-op explanation");
			if (type === "manual_edit_apply" && reply.status === "done" && (!object(reply.data) || !["done", "partial", "error"].includes(String(reply.data.status)) || !["appliedEntryIds", "failed", "files", "notes"].every((key) => Array.isArray((reply.data as ObjectValue)[key])))) throw new Error("Manual Apply requires canonical structured result JSON");
			const argv = ["live-poll", "--reply", pending.id, reply.status, ...(reply.file ? ["--file", reply.file] : []), ...(reply.data === undefined ? [] : ["--data", JSON.stringify(reply.data)]), ...(reply.message ? [reply.message] : []), "--target", this.root!];
			result = await this.native(argv, this.root!);
			if (result.ok !== true || result.id !== pending.id || result.status !== reply.status || reply.file && result.file !== reply.file) throw new Error("Native business acknowledgement mismatch/refusal; work remains pending");
		}
		this.result = await this.presentation(result);
		if (idOK(event.id)) {
			const recovery = await this.native(["live-resume", "--id", String(event.sessionId ?? event.id), "--target", this.root!], this.root!);
			if (recovery.active === false) {
				if (!await this.terminal(String(event.sessionId ?? event.id), ["complete", "discarded"])) throw new Error("Native settlement has no active snapshot or terminal journal proof");
			} else if (!object(recovery.snapshot) || recovery.snapshot.id !== (event.sessionId ?? event.id) || recovery.snapshot.pendingEvent) throw new Error("Native settlement still has pending work; inspect status/resume, no automatic replay");
		}
		this.controller.signal.throwIfAborted();
		this.history.add(pending.hash); if (this.history.size > 64) this.history.delete(this.history.values().next().value!);
		this.pending = undefined; await rm(pending.file, { force: true });
		this.controller.signal.throwIfAborted();
		this.phase = "polling"; this.notify(); this.background(() => this.poll()); return this.view();
	}
	async restore(saved: LiveSaved) {
		if (saved.version !== 1 || saved.sessionId !== this.sessionId || typeof saved.root !== "string" || !Array.isArray(saved.ids) || saved.ids.some((id) => !idOK(id))) throw new Error("No recovery metadata for this Pi session/branch");
		this.root = await resolveDirectory(saved.root); this.ids = saved.ids.slice(-64);
		if (saved.pending) {
			if (!Number.isFinite(saved.pending.receivedAt) || typeof saved.pending.token !== "string" || typeof saved.pending.hash !== "string") throw new Error("Malformed recovery event metadata");
			const file = saved.pending.file; const directory = path.dirname(file);
			if (path.dirname(directory) !== await physicalPath(os.tmpdir()) || !path.basename(directory).startsWith("pi-impeccable-live-") || path.basename(file) !== "event.json") throw new Error("Invalid owned recovery sidecar path");
			const info = await lstat(directory); const fileInfo = await lstat(file);
			if (!info.isDirectory() || info.isSymbolicLink() || fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.size > 4 * 1024 * 1024 || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error("Unsafe recovery sidecar");
			const raw = await readFile(file, "utf8");
			if (digest(raw) !== saved.pending.hash) throw new Error("Recovery payload changed; inspect canonical journal");
			this.directory = directory; this.pending = { ...saved.pending, event: validateLiveEvent(JSON.parse(raw)), token: randomUUID() };
		}
		this.phase = "paused"; this.message = "Recovered own session metadata; explicit resume required"; this.notify();
	}
	resume() {
		if (!["paused", "stopped"].includes(this.phase) || !this.root || this.closing) throw new Error("No paused owner in this Pi session/branch");
		this.controller = new AbortController(); this.phase = "starting"; this.message = undefined;
		this.background(async () => {
			await this.acquire(this.root!);
			const status = await this.native(["live-status", "--target", this.root!], this.root!);
			if (!Array.isArray(status.activeSessions) || status.activeSessions.some((s) => !object(s) || !this.ids.includes(String(s.id)))) throw new Error("Foreign or malformed recoverable work; this session cannot adopt it");
			await this.ensureHelper(); await this.checkIdentity(); this.controller.signal.throwIfAborted();
			// A restarted native helper has a new auth token. Refresh the native script tag
			// before delivering recovery so a page reload can reconnect without another Go.
			if (this.helper) {
				const injection = await this.native(["live-inject", "--port", String(this.helperInfo!.port), "--target", this.root!], this.root!);
				if (injection.ok !== true) throw new Error("Native recovery injection refused; reload cannot reconnect safely");
				await this.checkIdentity();
			}
			if (this.pending) {
				const id = this.pending.event.sessionId ?? this.pending.event.id;
				if (id) {
					const recovery = await this.native(["live-resume", "--id", String(id), "--target", this.root!], this.root!);
					this.result = await this.presentation(recovery);
					if (recovery.active === false) {
						if (!["accept", "discard", "carbonize_cleanup"].includes(String(this.pending.event.type)) || !await this.terminal(String(id), ["complete", "discarded"])) throw new Error("Canonical work already terminal or missing; inspect status before further edits");
					} else {
						if (!object(recovery.snapshot) || recovery.snapshot.id !== id || recovery.snapshot.pendingEvent && (!object(recovery.snapshot.pendingEvent) || recovery.snapshot.pendingEvent.id !== this.pending.event.id || recovery.snapshot.pendingEvent.type !== this.pending.event.type)) throw new Error("Canonical journal cannot restore this event");
						if (!["accept", "discard", "carbonize_cleanup"].includes(String(this.pending.event.type)) && !recovery.snapshot.pendingEvent) throw new Error("Native event is already acknowledged; inspect status/result instead of replaying it");
					}
				}
				this.controller.signal.throwIfAborted();
				this.pending.token = randomUUID(); this.phase = "pending"; this.notify(); return;
			}
			// Native helper startup requeues unacknowledged journal events, without another Go.
			this.phase = "polling"; this.notify(); await this.poll();
		});
		this.notify(); return this.view();
	}
	private async releaseResources() {
		for (const proc of this.processes) proc.cancel();
		await Promise.all([...this.processes].map((proc) => proc.exited));
		const helper = this.helper; this.helper = undefined;
		if (helper) { helper.cancel(); await helper.exited; }
		this.helperInfo = undefined;
		const release = this.release; await release?.(); this.release = undefined;
	}
	async pause(reason: string, stopped = false) {
		if (this.closing) return this.closing;
		this.controller.abort(); this.phase = stopped ? "stopped" : "paused"; this.message = reason;
		if (this.pending) this.pending.token = randomUUID();
		this.notify();
		this.closing = (async () => {
			await this.job; await this.releaseResources();
			if (!this.pending && this.directory && !object(this.result)) { await rm(this.directory, { recursive: true, force: true }); this.directory = undefined; }
			this.notify();
		})();
		try { await this.closing; } finally { this.closing = undefined; }
	}
}
