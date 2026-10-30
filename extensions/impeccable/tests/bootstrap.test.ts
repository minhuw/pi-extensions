import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ENGINE_VERSION, platformAsset, runEngine, sha256 } from "../src/engine.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";
import { writeFakeEngine } from "./support/fake-engine.ts";

isolateEngineEnvironment();

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

const onPosix = (name: string, fn: () => Promise<void>): ReturnType<typeof it> =>
	process.platform === "win32" ? it.skip(name, fn) : it(name, fn);

interface TestServer {
	url: string;
	hits: () => number;
	close: () => Promise<void>;
}

async function startServer(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
	const sockets = new Set<Socket>();
	let hits = 0;
	const server: Server = createServer((request, response) => {
		hits += 1;
		handler(request, response);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url,
		hits: () => hits,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

const ENGINE_BODY = "#!/bin/sh\necho bootstrapped-ok\nexit 0\n";
const ENGINE_BYTES = Buffer.from(ENGINE_BODY, "utf8");

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "pi impeccable bootstrap with spaces-"));
}

describe("managed bootstrap", () => {
	onPosix("downloads, verifies, caches, and runs the platform asset exactly once", async () => {
		const selected = platformAsset(process.platform, process.arch);
		if (!selected) return;
		const dir = await tempDir();
		const cacheRoot = path.join(dir, "cache with spaces");
		const cwd = path.join(dir, "project with spaces");
		await mkdir(cwd);
		const digest = sha256(ENGINE_BYTES);
		const checksums = new Map([[selected.asset, digest]]);
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/octet-stream" });
			response.end(ENGINE_BYTES);
		});
		try {
			const first = await runEngine({
				argv: ["context"],
				cwd,
				cacheRoot,
				downloadBase: server.url,
				checksums,
			});
			expect(first.status).toBe("success");
			expect(first.ok).toBe(true);
			expect(first.trustedOverride).toBe(false);
			expect(first.stdout).toContain("bootstrapped-ok");
			expect(server.hits()).toBe(1);

			const cached = path.join(cacheRoot, "bin", ENGINE_VERSION, selected.asset);
			expect(await readFile(cached, "utf8")).toBe(ENGINE_BODY);
			expect(await readFile(`${cached}.verified`, "utf8")).toContain(digest);

			// The verified cache serves the second run without any network.
			await server.close();
			const second = await runEngine({
				argv: ["context"],
				cwd,
				cacheRoot,
				downloadBase: server.url,
				checksums,
			});
			expect(second.status).toBe("success");
			expect(second.stdout).toContain("bootstrapped-ok");
			expect(server.hits()).toBe(1);
		} finally {
			await server.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.each(["writeFile", "rename"] as const)("reports cache %s permission failures as actionable cache-unwritable", async (operation) => {
		const selected = platformAsset(process.platform, process.arch)!;
		const dir = await tempDir();
		const cacheRoot = path.join(dir, "existing cache");
		const cacheDir = path.join(cacheRoot, "bin", ENGINE_VERSION);
		await mkdir(cacheDir, { recursive: true });
		const server = await startServer((_request, response) => response.end(ENGINE_BYTES));
		vi.mocked(fs[operation]).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
		try {
			const result = await runEngine({ argv: ["context"], cwd: dir, cacheRoot, downloadBase: server.url, checksums: new Map([[selected.asset, sha256(ENGINE_BYTES)]]) });
			expect(result).toMatchObject({ ok: false, status: "unavailable", kind: "cache-unwritable" });
			expect(result.message).toContain("writable IMPECCABLE_HOME");
			expect(await readdir(cacheDir)).toEqual([]);
		} finally {
			vi.mocked(fs[operation]).mockClear();
			await server.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports a real existing read-only cache directory as unavailable", async () => {
		const selected = platformAsset(process.platform, process.arch)!;
		const dir = await tempDir();
		const cacheRoot = path.join(dir, "cache");
		const cacheDir = path.join(cacheRoot, "bin", ENGINE_VERSION);
		await mkdir(cacheDir, { recursive: true });
		await chmod(cacheDir, 0o555);
		const server = await startServer((_request, response) => response.end(ENGINE_BYTES));
		try {
			const result = await runEngine({ argv: ["context"], cwd: dir, cacheRoot, downloadBase: server.url, checksums: new Map([[selected.asset, sha256(ENGINE_BYTES)]]) });
			expect(result).toMatchObject({ status: "unavailable", kind: "cache-unwritable" });
			expect(result.message).toContain(cacheDir);
		} finally {
			await chmod(cacheDir, 0o755);
			await server.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("rejects a checksum mismatch and leaves no cached executable", async () => {
		const selected = platformAsset(process.platform, process.arch);
		if (!selected) return;
		const dir = await tempDir();
		const cacheRoot = path.join(dir, "cache");
		const checksums = new Map([[selected.asset, "0".repeat(64)]]);
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/octet-stream" });
			response.end(ENGINE_BYTES);
		});
		try {
			const result = await runEngine({
				argv: ["context"],
				cwd: dir,
				cacheRoot,
				downloadBase: server.url,
				checksums,
			});
			expect(result.status).toBe("unavailable");
			expect(result.kind).toBe("checksum-mismatch");
			await expect(
				access(path.join(cacheRoot, "bin", ENGINE_VERSION, selected.asset)),
			).rejects.toThrow();
		} finally {
			await server.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("cancels a stalled download without leaving a cached executable", async () => {
		const selected = platformAsset(process.platform, process.arch);
		if (!selected) return;
		const dir = await tempDir();
		const cacheRoot = path.join(dir, "cache");
		const checksums = new Map([[selected.asset, sha256(ENGINE_BYTES)]]);
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/octet-stream" });
			response.write("partial");
			// Never end: the body stays open until the socket is destroyed.
		});
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 150);
			const result = await runEngine({
				argv: ["context"],
				cwd: dir,
				cacheRoot,
				downloadBase: server.url,
				checksums,
				signal: controller.signal,
				timeoutMs: 10_000,
			});
			clearTimeout(timer);
			expect(result.status).toBe("cancelled");
			await expect(
				access(path.join(cacheRoot, "bin", ENGINE_VERSION, selected.asset)),
			).rejects.toThrow();
		} finally {
			await server.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("times out a stalled download", async () => {
		const selected = platformAsset(process.platform, process.arch);
		if (!selected) return;
		const dir = await tempDir();
		const cacheRoot = path.join(dir, "cache");
		const checksums = new Map([[selected.asset, sha256(ENGINE_BYTES)]]);
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/octet-stream" });
			response.write("partial");
		});
		try {
			const result = await runEngine({
				argv: ["context"],
				cwd: dir,
				cacheRoot,
				downloadBase: server.url,
				checksums,
				timeoutMs: 300,
			});
			expect(result.status).toBe("timeout");
		} finally {
			await server.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	onPosix("runs a deliberate trusted override without consulting downloads or checksums", async () => {
		const dir = await tempDir();
		const cacheRoot = path.join(dir, "cache");
		const binary = await writeFakeEngine(dir, "override-engine", "#!/bin/sh\necho override-ok\nexit 0\n");
		try {
			const result = await runEngine({ argv: ["context"], cwd: dir, cacheRoot, binary });
			expect(result.status).toBe("success");
			expect(result.trustedOverride).toBe(true);
			expect(result.binary).toBe(binary);
			expect(result.stdout).toContain("override-ok");
			await expect(access(cacheRoot)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
