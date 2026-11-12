import { NodeRequestError } from "./channel";
import { LIMITS, toBase64Url, type Requests, type Results, type Stat } from "./contract";
import { Sha256 } from "./sha256";

type UploadRequestType = "fs.uploadStart" | "fs.uploadChunk" | "fs.uploadFinish" | "fs.uploadCancel";

/** The requests an upload makes; `NodeFiles.request` is one. */
export type UploadRequest = <K extends UploadRequestType>(type: K, params: Requests[K]) => Promise<Results[K]>;

export interface UploadItem {
	/** A `File` from a drop or the clipboard. */
	blob: Blob;
	/** The base name to store it under, as `uploadName` cleans it. */
	name: string;
}

export interface UploadProgress {
	/** The item being sent, of `count`. */
	index: number;
	count: number;
	name: string;
	/** Bytes sent of every item so far, of `total`. */
	sent: number;
	total: number;
}

export interface UploadOptions {
	/** The directory to write into; the node's `~/.pika-node/uploads/<day>/` without it. */
	dir?: string;
	chunkBytes?: number;
	signal?: AbortSignal;
	onProgress?: (progress: UploadProgress) => void;
}

/** The user cancelled: the node has deleted what was sent. */
export class UploadCancelled extends Error {
	constructor() {
		super("The upload was cancelled.");
		this.name = "UploadCancelled";
	}
}

const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
const MAX_NAME = 255;

/**
 * A base name the node accepts (`fs.uploadStart`'s `name`: no slash, no controls, not `.` or `..`, ≤ 255
 * characters): the rest become `_`, and a long name keeps its extension.
 */
export function uploadName(name: string): string {
	let clean = name.replace(CONTROLS, "_").replaceAll("/", "_").trim();
	if (!clean || clean === "." || clean === "..") clean = "upload";
	if (clean.length <= MAX_NAME) return clean;
	const dot = clean.lastIndexOf(".");
	const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
	return clean.slice(0, MAX_NAME - extension.length) + extension;
}

/**
 * Uploads each item in turn (NODE.md, "Upload"): `fs.uploadStart`, chunks of at most `maxUploadChunkBytes` sent in
 * order and hashed as they go, then `fs.uploadFinish` with the SHA-256, which the node checks before it renames the
 * file into place. Resolves with the final paths, in order. A cancel stops between chunks and deletes the item in
 * flight (`fs.uploadCancel`); items already finished stay.
 */
export async function uploadFiles(request: UploadRequest, items: readonly UploadItem[], options: UploadOptions = {}): Promise<{ path: string; stat: Stat }[]> {
	const chunkBytes = Math.min(options.chunkBytes ?? LIMITS.maxUploadChunkBytes, LIMITS.maxUploadChunkBytes);
	const total = items.reduce((sum, item) => sum + item.blob.size, 0);
	const tooLarge = items.find((item) => item.blob.size > LIMITS.maxUploadBytes);
	if (tooLarge) throw new Error(`${tooLarge.name} is over the node's ${LIMITS.maxUploadBytes / 1024 / 1024} MiB upload limit.`);
	const signal = options.signal;
	const done: { path: string; stat: Stat }[] = [];
	let sent = 0;
	for (const [index, item] of items.entries()) {
		if (signal?.aborted) throw new UploadCancelled();
		const report = () => options.onProgress?.({ index, count: items.length, name: item.name, sent, total });
		report();
		const { upload } = await request("fs.uploadStart", { name: item.name, size: item.blob.size, ...(options.dir ? { dir: options.dir } : {}) });
		const hash = new Sha256();
		try {
			for (let offset = 0; offset < item.blob.size; ) {
				if (signal?.aborted) throw new UploadCancelled();
				const bytes = new Uint8Array(await item.blob.slice(offset, offset + chunkBytes).arrayBuffer());
				if (bytes.length === 0) throw new Error(`${item.name} ended at ${offset} of ${item.blob.size} bytes while it was read.`);
				hash.update(bytes);
				const { received } = await request("fs.uploadChunk", { upload, offset, data: toBase64Url(bytes) });
				offset += bytes.length;
				sent += bytes.length;
				if (received !== offset) throw new Error(`The node has ${received} bytes of ${item.name}, not ${offset}.`);
				report();
			}
			if (signal?.aborted) throw new UploadCancelled();
			done.push(await request("fs.uploadFinish", { upload, hash: hash.hex() }));
		} catch (error) {
			// The node drops a failed hash check itself; anything else is cancelled here, so no partial file lingers.
			if (!(error instanceof NodeRequestError && error.code === "conflict")) await request("fs.uploadCancel", { upload }).catch(() => {});
			throw error;
		}
	}
	return done;
}
