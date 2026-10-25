import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname } from "node:path";

/** File-system calls used for durable writes; a mutable object so tests can observe fsync. */
export const fileFs = {
	openSync: fs.openSync, writeSync: fs.writeSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync,
};

/** A unique sibling name for temp and set-aside files. */
export const siblingPath = (path: string, suffix: string) => `${path}.${process.pid}.${randomBytes(4).toString("hex")}.${suffix}`;

/** Writes `path` completely or not at all: a synced temp file renamed over it, then the directory synced. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
	const temp = siblingPath(path, "tmp");
	try {
		writeFileSynced(temp, data, "wx");
		fileFs.renameSync(temp, path);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
	syncDir(dirname(path));
}

/** Writes and fsyncs the file and its directory; with flag `wx` the file must not exist yet. */
export function writeSynced(path: string, data: string | Uint8Array, flag = "w"): void {
	writeFileSynced(path, data, flag);
	syncDir(dirname(path));
}

/** Writes and fsyncs the file only; the caller makes its directory entry durable. */
export function writeFileSynced(path: string, data: string | Uint8Array, flag = "w"): void {
	const fd = fileFs.openSync(path, flag, 0o644);
	try {
		const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		for (let offset = 0; offset < bytes.length;) offset += fileFs.writeSync(fd, bytes, offset, bytes.length - offset);
		fileFs.fsyncSync(fd);
	} finally {
		fileFs.closeSync(fd);
	}
}

/** Makes created, renamed, and removed entries of `path` durable. */
export function syncDir(path: string): void {
	let fd: number;
	try {
		fd = fileFs.openSync(path, "r");
	} catch {
		return; // directories cannot be opened on some platforms
	}
	try {
		fileFs.fsyncSync(fd);
	} catch (error) {
		// Directory fsync is unsupported on some platforms (EINVAL/EPERM/EISDIR); anything else is a real I/O failure.
		if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	} finally {
		fileFs.closeSync(fd);
	}
}
