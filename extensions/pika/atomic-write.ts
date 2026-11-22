import { randomUUID } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";

/**
 * Replaces `file` atomically via a unique `.tmp` sibling and rename.
 * When `mode` is set, the temp file is created and chmodded to that mode before renaming so umask
 * cannot change the final permissions. When `sync` is true, the file is fsynced before renaming.
 */
export async function writeFileAtomic(
	file: string,
	data: string,
	options?: { mode?: number; sync?: boolean },
): Promise<void> {
	const mode = options?.mode;
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temp, "wx", mode ?? 0o666);
		await handle.writeFile(data);
		if (mode !== undefined) await handle.chmod(mode);
		if (options?.sync) await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temp, file);
	} catch (error) {
		await handle?.close().catch(() => {});
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}
