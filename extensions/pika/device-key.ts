import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { normalizeUrl } from "./config.ts";
import { type MachineSource, machineSource } from "./uploader.ts";

export const BIND_TIMEOUT_MS = 5_000;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Test seams: `afterWrite` runs between writing the key file and reading it back, where another
 * process may replace it; `machine` stands in for `machineSource()`.
 */
export const deviceKeyHooks: { afterWrite?: (file: string) => Promise<void> | void; machine?: () => Promise<MachineSource> } = {};

export const deviceKeyFile = (dir: string) => join(dir, "device-key.json");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** This machine's fingerprint: the hash of its id, or null when the id is only the hostname fallback. */
async function fingerprint(): Promise<string | null> {
	const { id, fromOs } = await (deviceKeyHooks.machine ?? machineSource)();
	return fromOs ? sha256(id) : null;
}

/** A valid key file's key and the fingerprint it was made or adopted on (null: made without one); undefined otherwise. */
async function readKey(file: string): Promise<{ key: string; machine: string | null } | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const { v, key, machine } = parsed as Record<string, unknown>;
		if (v !== 1 || typeof key !== "string" || !HEX64.test(key)) return undefined;
		return machine === null || (typeof machine === "string" && HEX64.test(machine)) ? { key, machine } : undefined;
	} catch {
		return undefined;
	}
}

/** Replaces `file` atomically with a file only its owner can read. */
async function writeKey(file: string, dir: string, fields: Record<string, unknown>): Promise<void> {
	await mkdir(dir, { recursive: true });
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temp, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(fields)}\n`);
		await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temp, file);
	} catch (error) {
		await handle?.close().catch(() => {});
		await rm(temp, { force: true });
		throw error;
	}
}

/**
 * This pi install's device key from `<dir>/device-key.json`, which lets the server recognize a
 * re-pairing as the same device. A missing or invalid file is replaced by a new key, and so is a
 * copied one: a file made on another machine, known only when both its fingerprint and this
 * machine's come from the OS. While this machine's id is only the hostname fallback, an existing
 * key is kept and a new file records no fingerprint; a later process that has the OS's id adopts
 * such a file by recording its fingerprint, keeping the key. After writing, the file is read
 * back, so of two processes that raced, both use the one that won. Undefined when no key file can
 * be made. The key is never shown.
 */
export async function deviceKey(dir: string): Promise<string | undefined> {
	try {
		const file = deviceKeyFile(dir);
		const machine = await fingerprint();
		const existing = await readKey(file);
		if (existing && (machine === null || existing.machine === machine)) return existing.key;
		const copied = existing && existing.machine !== null;
		await writeKey(file, dir, { v: 1, key: existing && !copied ? existing.key : randomBytes(32).toString("hex"), machine });
		await deviceKeyHooks.afterWrite?.(file);
		return (await readKey(file))?.key;
	} catch {
		return undefined;
	}
}

const BOUND = Symbol.for("pi-extensions.pika.bound");
const PENDING = Symbol.for("pi-extensions.pika.binds");
const shared = globalThis as { [BOUND]?: Set<string>; [PENDING]?: Set<AbortController> };
/** Hashes of the `[url, token]` pairs bound in this process, shared by module copies. */
const bound = (): Set<string> => shared[BOUND] ??= new Set();
/** What aborts each bind still running in this process. */
const pending = (): Set<AbortController> => shared[PENDING] ??= new Set();
const boundKey = (url: string, token: string) => {
	let normalized = url;
	try { normalized = normalizeUrl(url); } catch { /* compared as given */ }
	return sha256(JSON.stringify([normalized, token]));
};

/**
 * Tells the server this install's key belongs to the device of `token` (`POST api/pair/v1/bind`),
 * so a later pairing from here continues that device. Every failure (an older server's 404, a
 * 409 for a key another device holds, the network) is ignored; it never throws. `abortBinds()`
 * ends it at once; a bind ended that way counts as not done, so a later session binds again.
 */
export async function bindDeviceKey(url: string, token: string, dir: string): Promise<void> {
	const id = boundKey(url, token);
	bound().add(id);
	const controller = new AbortController();
	pending().add(controller);
	try {
		const key = await deviceKey(dir);
		if (!key || controller.signal.aborted) return;
		const response = await fetch(`${url}/api/pair/v1/bind`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.any([AbortSignal.timeout(BIND_TIMEOUT_MS), controller.signal]),
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ key }),
		});
		await response.body?.cancel().catch(() => {});
	} catch { /* ignored */ } finally {
		pending().delete(controller);
		if (controller.signal.aborted) bound().delete(id);
	}
}

/** Binds once per process for each URL and token, in the background. */
export function bindOnce(url: string, token: string, dir: string): void {
	if (bound().has(boundKey(url, token))) return;
	void bindDeviceKey(url, token, dir);
}

/** Aborts every bind still running in this process, so none keeps it alive after its last session. */
export function abortBinds(): void {
	for (const controller of pending()) controller.abort();
}
