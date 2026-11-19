import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-pika-store-perms-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("Store permissions", () => {
	it("creates directories with 0700 and spool, stream, parked, and ack files with 0600", async () => {
		const store = new Store(join(root, "pika"));
		await store.init();

		const dirs = [store.dir, store.streams, store.done, join(store.dir, "spool"), store.requests, store.blobs, store.parked];
		for (const dir of dirs) expect(await modeOf(dir)).toBe(0o700);

		const stream = { key: "sess:1", kind: "session" as const, path: "/tmp/s.jsonl", length: 12, updatedAt: "2026-01-01T00:00:00Z" };
		await store.saveStream(stream);
		expect(await modeOf(join(store.streams, `${encodeURIComponent(stream.key)}.json`))).toBe(0o600);

		await store.archiveStream(stream);
		expect(await modeOf(join(store.done, `${encodeURIComponent(stream.key)}.json`))).toBe(0o600);

		const req = { id: "req-1", sessionId: "s1", seq: 1, at: "2026-01-01T00:00:00Z", fidelity: "payload" as const, skeleton: {}, blocks: [HASH_A] };
		await store.saveRequest(req);
		expect(await modeOf(join(store.requests, "req-1.json"))).toBe(0o600);

		await store.saveBlob(HASH_A, "secret payload");
		expect(await modeOf(join(store.blobs, HASH_A))).toBe(0o600);

		await store.parkDocument("doc.json", "{\"secret\":true}");
		expect(await modeOf(join(store.parked, "doc.json"))).toBe(0o600);

		await store.parkBlob(HASH_A);
		expect(await modeOf(join(store.parked, HASH_A))).toBe(0o600);

		await store.parkRequest("req-1");
		expect(await modeOf(join(store.parked, "req-1.json"))).toBe(0o600);

		await store.appendAcked([HASH_A]);
		expect(await modeOf(store.ackedLog)).toBe(0o600);

		await chmod(store.ackedLog, 0o644);
		await store.appendAcked([HASH_B]);
		expect(await modeOf(store.ackedLog)).toBe(0o600);

		await store.rewriteAcked("https://pika.example", [HASH_A, HASH_B]);
		expect(await modeOf(store.ackedLog)).toBe(0o600);
	});

	it("tightens pre-existing looser spool directories to 0700 and files to 0600 on init", async () => {
		const store = new Store(join(root, "pika"));
		const spool = join(store.dir, "spool");
		const dirs = [store.dir, store.streams, store.done, spool, store.requests, store.blobs, store.parked];
		for (const dir of dirs) {
			await mkdir(dir, { recursive: true, mode: 0o755 });
			await chmod(dir, 0o755);
		}

		const files = [
			store.ackedLog,
			join(store.streams, "active.json"),
			join(store.done, "closed.json"),
			join(store.requests, "req-old.json"),
			join(store.blobs, HASH_A),
			join(store.parked, HASH_B),
		];
		for (const file of files) {
			await writeFile(file, "data", { mode: 0o644 });
			await chmod(file, 0o644);
		}

		const staleTmp = join(store.requests, "req-old.json.1.abcd.tmp");
		await writeFile(staleTmp, "partial", { mode: 0o644 });
		const old = new Date(Date.now() - 120_000);
		await utimes(staleTmp, old, old);

		await store.init();

		for (const dir of dirs) expect(await modeOf(dir)).toBe(0o700);
		for (const file of files) {
			expect(await modeOf(file)).toBe(0o600);
			expect(await readFile(file, "utf8")).toBe("data");
		}
		await expect(stat(staleTmp)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
