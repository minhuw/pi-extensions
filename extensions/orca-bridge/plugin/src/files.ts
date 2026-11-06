import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_DIRECTORY_ENTRIES, MAX_SNAPSHOT_BYTES, STALE_MS, timestamp } from "./protocol.ts";

export const defaultDirectory = () => process.env.PI_ORCA_COMPANION_DIR ?? join(homedir(), ".cache", "pi-orca-bridge", "v1");
export const snapshotName = (id: string) => `session-${id}.json`;
export const presenceName = (id: string) => `plugin-${id}.json`;
const entryPattern = /^(session|plugin)-[a-f0-9-]{36}\.json$/;

/** All participants use the same user's private directory. Refuse symlinks and shared directories. */
export async function privateDirectory(directory: string, create = false): Promise<boolean> {
	if (!isAbsolute(directory)) return false;
	try {
		if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
		const stat = await lstat(directory);
		return stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === "win32" ||
			((stat.mode & 0o077) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid())));
	} catch { return false; }
}

/** Bounded, nonblocking read through a descriptor; reject symlinks and non-regular files. */
export async function readJson(directory: string, name: string): Promise<unknown> {
	if (!entryPattern.test(name)) return;
	let handle;
	try {
		handle = await open(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES || (process.platform !== "win32" &&
			((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) return;
		const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_SNAPSHOT_BYTES) return;
		return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
	} catch { return; }
	finally { await handle?.close().catch(() => {}); }
}

export async function entries(directory: string): Promise<{ names: string[]; truncated: boolean }> {
	const names = (await readdir(directory)).filter(name => entryPattern.test(name)).sort();
	return { names: names.slice(0, MAX_DIRECTORY_ENTRIES), truncated: names.length > MAX_DIRECTORY_ENTRIES };
}

export async function writeJson(directory: string, name: string, value: unknown): Promise<void> {
	if (!entryPattern.test(name) || !(await privateDirectory(directory))) throw new Error("Companion directory is unavailable");
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new Error("Companion snapshot is too large");
	const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(text, "utf8"); }
		finally { await handle.close(); }
		await rename(temporary, join(directory, name));
	} finally { await unlink(temporary).catch(() => {}); }
}

export async function remove(directory: string, name: string): Promise<void> {
	if (entryPattern.test(name) && await privateDirectory(directory)) await unlink(join(directory, name)).catch(() => {});
}

export async function hasCompanion(directory: string, now: number): Promise<boolean> {
	if (!(await privateDirectory(directory))) return false;
	try {
		const { names } = await entries(directory);
		for (const name of names.filter(name => name.startsWith("plugin-"))) {
			const value = await readJson(directory, name) as { version?: unknown; updatedAt?: unknown } | undefined;
			if (value?.version === 1 && timestamp(value.updatedAt) && value.updatedAt <= now && now - value.updatedAt <= STALE_MS) return true;
		}
	} catch { /* Missing or restarting companion. */ }
	return false;
}
