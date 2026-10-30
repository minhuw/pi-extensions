import * as fs from "node:fs/promises";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEditToolDefinition, createWriteToolDefinition, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { runOperation } from "../src/operations.ts";
import { readConfigs, saveConfig, withManagedFileMutation } from "../src/project.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
isolateEngineEnvironment();
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it("queues an actual SDK native edit at the old check/rename window and preserves both updates through a realpath alias", async () => {
	const h = await detectorFixture();
	const reached = gate(); const release = gate();
	let adapter: Promise<void> | undefined;
	let native: Promise<unknown> | undefined;
	try {
		await h.config({ product: { keep: 1 }, hook: { enabled: false } });
		const config = (await readConfigs(h.directory))[0]!;
		const alias = path.join(h.directory, "project alias");
		await fs.symlink(h.directory, alias);
		const open = fs.open;
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (String(args[0]).startsWith(`${config.file}.`)) {
				const write = handle.writeFile.bind(handle);
				vi.spyOn(handle, "writeFile").mockImplementation(async (...values) => {
					await write(...values); reached.resolve(); await release.promise;
				});
			}
			return handle;
		});
		adapter = saveConfig(config, { ...config.value, hook: { enabled: true } });
		await reached.promise;
		let finished = false;
		native = createEditToolDefinition(alias).execute("native", { path: ".impeccable/config.json", edits: [{ oldText: '"keep":1', newText: '"keep":2' }] }, undefined, undefined, undefined!).then(() => { finished = true; });
		// Native queue registration awaits realpath. While the adapter holds its
		// staging write, an uncoordinated native edit would finish in this window.
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(finished).toBe(false);
		release.resolve(); await adapter; await native;
		expect((await readConfigs(h.directory))[0]!.value).toMatchObject({ product: { keep: 2 }, hook: { enabled: true } });
	} finally { release.resolve(); await Promise.allSettled([adapter, native]); vi.restoreAllMocks(); await h.close(); }
});

it("refuses a stale adapter update after an actual SDK native write already owns the queue", async () => {
	const h = await detectorFixture();
	const reached = gate(); const release = gate();
	let native: Promise<unknown> | undefined;
	try {
		await h.config({ product: { keep: 1 } });
		const config = (await readConfigs(h.directory))[0]!;
		native = createWriteToolDefinition(h.directory, { operations: {
			mkdir: async () => { reached.resolve(); await release.promise; },
			writeFile: (file, text) => fs.writeFile(file, text),
		} }).execute("native", { path: config.file, content: '{"product":{"keep":2}}' }, undefined, undefined, undefined!);
		await reached.promise;
		const adapter = saveConfig(config, { ...config.value, hook: { enabled: true } });
		const refusal = expect(adapter).rejects.toThrow("changed concurrently");
		release.resolve(); await native; await refusal;
		expect((await readConfigs(h.directory))[0]!.value).toEqual({ product: { keep: 2 } });
	} finally { release.resolve(); await native; await h.close(); }
});

it("queues first creation on the actual SDK lexical key through a symlink and refuses the stale adapter snapshot", async () => {
	const h = await detectorFixture(); const reached = gate(); const release = gate();
	let native: Promise<unknown> | undefined; let adapter: Promise<void> | undefined;
	try {
		const alias = path.join(h.directory, "project alias"); await fs.symlink(h.directory, alias);
		const config = (await readConfigs(alias))[0]!;
		expect(config.text).toBeUndefined();
		native = createWriteToolDefinition(alias, { operations: {
			mkdir: async (directory) => { reached.resolve(); await release.promise; await fs.mkdir(directory, { recursive: true }); },
			writeFile: (file, text) => fs.writeFile(file, text),
		} }).execute("native-first", { path: ".impeccable/config.json", content: '{"product":{"keep":2}}' }, undefined, undefined, undefined!);
		await reached.promise;
		let settled = false;
		adapter = saveConfig(config, { hook: { enabled: true } });
		const refusal = expect(adapter).rejects.toThrow("changed concurrently").then(() => { settled = true; });
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(settled).toBe(false);
		release.resolve(); await native; await refusal;
		expect((await readConfigs(h.directory))[0]!.value).toEqual({ product: { keep: 2 } });
	} finally { release.resolve(); await Promise.allSettled([adapter, native]); await h.close(); }
});

it("refuses a missing aliased destination before staging because physical native writers cannot share its key", async () => {
	const h = await detectorFixture();
	try {
		const alias = path.join(h.directory, "project alias"); await fs.symlink(h.directory, alias);
		const config = (await readConfigs(alias))[0]!;
		await expect(saveConfig(config, { hook: { enabled: true } })).rejects.toThrow("missing destination through a path alias");
		await expect(fs.stat(path.join(h.directory, ".impeccable"))).rejects.toMatchObject({ code: "ENOENT" });
		// The owner lock was released; canonical first creation still works.
		await saveConfig((await readConfigs(h.directory))[0]!, { product: { keep: 1 } });
		expect((await readConfigs(h.directory))[0]!.value).toEqual({ product: { keep: 1 } });
	} finally { await h.close(); }
});

it("queues an actual native first write at the config staging window", async () => {
	const h = await detectorFixture(); const reached = gate(); const release = gate();
	let adapter: Promise<void> | undefined; let native: Promise<unknown> | undefined;
	try {
		const config = (await readConfigs(h.directory))[0]!;
		const open = fs.open;
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (String(args[0]).startsWith(`${config.file}.`)) {
				const write = handle.writeFile.bind(handle);
				vi.spyOn(handle, "writeFile").mockImplementation(async (...values) => { await write(...values); reached.resolve(); await release.promise; });
			}
			return handle;
		});
		adapter = saveConfig(config, { hook: { enabled: true } }); await reached.promise;
		let finished = false;
		native = createWriteToolDefinition(h.directory).execute("native-first", { path: config.file, content: '{"hook":{"enabled":true},"product":{"keep":2}}' }, undefined, undefined, undefined!).then(() => { finished = true; });
		await new Promise((resolve) => setTimeout(resolve, 75)); expect(finished).toBe(false);
		release.resolve(); await adapter; await native;
		expect((await readConfigs(h.directory))[0]!.value).toEqual({ hook: { enabled: true }, product: { keep: 2 } });
	} finally { release.resolve(); await Promise.allSettled([adapter, native]); vi.restoreAllMocks(); await h.close(); }
});

function writer(root: string, mode: string) {
	const child = fork(fileURLToPath(new URL("./support/management-writer.ts", import.meta.url)), [root, mode], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
	const messages: Array<{ phase: string; ok?: boolean; error?: string }> = [];
	let failure = "";
	child.stderr!.on("data", (chunk) => { failure += String(chunk); });
	child.on("message", (message) => messages.push(message as typeof messages[number]));
	const phase = async (name: string) => {
		while (!messages.some((message) => message.phase === name)) {
			if (child.exitCode !== null) throw new Error(`Writer exited: ${failure}`);
			await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Writer exited: ${failure}`); })]);
		}
		return messages.find((message) => message.phase === name)!;
	};
	return { child, messages, phase };
}

it("coordinates separate-process adapter writers on the same physical config and truthfully refuses a stale snapshot", async () => {
	const h = await detectorFixture();
	const children: ChildProcess[] = [];
	try {
		await h.config({ product: { keep: 1 } });
		const alias = path.join(h.directory, "alias"); await fs.symlink(h.directory, alias);
		const first = writer(h.directory, "hold"); children.push(first.child);
		await first.phase("locked");
		const second = writer(alias, "save"); children.push(second.child);
		await second.phase("snapshot"); second.child.send("save");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(second.messages.some((message) => message.phase === "done")).toBe(false);
		first.child.send("commit");
		expect(await first.phase("done")).toMatchObject({ ok: true });
		expect(await second.phase("done")).toMatchObject({ ok: false, error: expect.stringContaining("changed concurrently") });
		expect((await readConfigs(h.directory))[0]!.value).toEqual({ product: { keep: 2 } });
		const third = writer(alias, "save"); children.push(third.child);
		await third.phase("snapshot"); third.child.send("save");
		expect(await third.phase("done")).toMatchObject({ ok: true });
		expect((await readConfigs(h.directory))[0]!.value).toEqual({ product: { keep: 2 }, hook: { enabled: true } });
	} finally { for (const child of children) if (child.exitCode === null) child.kill(); await h.close(); }
});

it("serializes separate-process exclusion writers from sibling workspaces and preserves both entries", async () => {
	const h = await detectorFixture(); const children: ChildProcess[] = [];
	try {
		await promisify(execFile)("git", ["init"], { cwd: h.directory });
		const web = path.join(h.directory, "apps/web"); const admin = path.join(h.directory, "apps/admin");
		await fs.mkdir(web, { recursive: true }); await fs.mkdir(admin);
		const file = path.join(h.directory, ".git/info/exclude");
		await fs.writeFile(file, "user-entry\n");
		const first = writer(web, "hold-exclude"); children.push(first.child); await first.phase("locked");
		const second = writer(admin, "append-exclude"); children.push(second.child); await second.phase("snapshot"); second.child.send("append");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(second.messages.some((message) => message.phase === "locked")).toBe(false);
		first.child.send("commit"); expect(await first.phase("done")).toMatchObject({ ok: true });
		expect(await second.phase("done")).toMatchObject({ ok: true });
		expect(await fs.readFile(file, "utf8")).toBe("user-entry\nhold-exclude\nappend-exclude\n");
	} finally { for (const child of children) if (child.exitCode === null) child.kill(); await h.close(); }
});

it("aborts a process-lock waiter without removing the other process's lock", async () => {
	const h = await detectorFixture();
	let child: ChildProcess | undefined;
	try {
		await h.config({ product: { keep: 1 } });
		const first = writer(h.directory, "hold"); child = first.child;
		await first.phase("locked");
		const config = (await readConfigs(h.directory))[0]!;
		const controller = new AbortController();
		const waiting = saveConfig(config, { hook: { enabled: true } }, controller.signal);
		const refusal = expect(waiting).rejects.toThrow();
		await tick(); controller.abort(); await refusal;
		const second = writer(h.directory, "save");
		try {
			await second.phase("snapshot"); second.child.send("save");
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(second.messages.some((message) => message.phase === "done")).toBe(false);
			first.child.send("commit"); await first.phase("done");
			expect(await second.phase("done")).toMatchObject({ ok: false, error: expect.stringContaining("changed concurrently") });
		} finally { if (second.child.exitCode === null) second.child.kill(); }
	} finally { if (child?.exitCode === null) child.kill(); await h.close(); }
});

it("bounds process-lock acquisition without stealing a busy owner's lock", async () => {
	const h = await detectorFixture();
	let child: ChildProcess | undefined;
	try {
		await h.config({ product: { keep: 1 } });
		const first = writer(h.directory, "hold"); child = first.child;
		await first.phase("locked");
		const config = (await readConfigs(h.directory))[0]!;
		const start = performance.now();
		await expect(saveConfig(config, { hook: { enabled: true } })).rejects.toThrow("management lock busy");
		expect(performance.now() - start).toBeLessThan(7000);
		expect(first.messages.some((message) => message.phase === "done")).toBe(false);
		first.child.send("commit");
		expect(await first.phase("done")).toMatchObject({ ok: true });
		expect((await readConfigs(h.directory))[0]!.value).toEqual({ product: { keep: 2 } });
	} finally { if (child?.exitCode === null) child.kill(); await h.close(); }
});

it("reports a second-file native-edit conflict after the shared config committed without rolling back either change", async () => {
	const h = await detectorFixture();
	try {
		await h.config({ product: { keep: 1 } });
		const shared = path.join(h.directory, ".impeccable/config.json");
		const local = path.join(h.directory, ".impeccable/config.local.json");
		await fs.writeFile(local, '{"hook":{"enabled":false},"keep":1}');
		const rename = fs.rename;
		vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
			const result = await rename(...args);
			if (args[1] === shared) await createEditToolDefinition(h.directory).execute("native-local", { path: local, edits: [{ oldText: '"keep":1', newText: '"keep":2' }] }, undefined, undefined, undefined!);
			return result;
		});
		const result = await runOperation({ argv: ["hooks", "on"], cwd: h.directory }, h.api);
		expect(result).toMatchObject({ ok: false, status: "error", integration: { committed: [shared], partial: true } });
		expect(result.stderr).toContain("changed concurrently");
		expect((await readConfigs(h.directory))[0]!.value).toMatchObject({ product: { keep: 1 }, hook: { enabled: true } });
		expect(await fs.readFile(local, "utf8")).toBe('{"hook":{"enabled":false},"keep":2}');
	} finally { vi.restoreAllMocks(); await h.close(); }
});

it.each(["pin", "exclude"])("holds the native mutation queue across the complete %s ownership/read/replace transaction", async (kind) => {
	const h = await detectorFixture(); const reached = gate(); const release = gate();
	let operation: Promise<unknown> | undefined; let native: Promise<unknown> | undefined;
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({});
		if (kind === "exclude") await promisify(execFile)("git", ["init"], { cwd: h.directory });
		const file = path.join(h.directory, kind === "pin" ? ".pi/prompts/layout.md" : ".git/info/exclude");
		if (kind === "pin") expect((await runOperation({ argv: ["pin", "layout"], cwd: h.directory }, h.api)).ok).toBe(true);
		const read = fs.readFile;
		let first = true;
		vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
			const result = await read(...args);
			if (args[0] === file && first) { first = false; reached.resolve(); await release.promise; }
			return result;
		});
		operation = runOperation({ argv: kind === "pin" ? ["pin", "layout"] : ["ignores", "add-file", "page.html", "--local"], cwd: h.directory }, h.api);
		await reached.promise;
		let finished = false;
		native = createEditToolDefinition(h.directory).execute("native", { path: file, edits: [{ oldText: kind === "pin" ? "<!-- pi-impeccable-owned-prompt:v1 -->" : "# git ls-files", newText: kind === "pin" ? "<!-- pi-impeccable-owned-prompt:v1 -->\nNative customization" : "# Native customization\n# git ls-files" }] }, undefined, undefined, undefined!).then(() => { finished = true; });
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(finished).toBe(false);
		release.resolve();
		expect(await operation).toMatchObject({ ok: true }); await native;
		const text = await fs.readFile(file, "utf8");
		expect(text).toContain("Native customization");
		if (kind === "exclude") expect(text).toContain("/.impeccable/config.local.json");
	} finally { release.resolve(); await Promise.allSettled([operation, native]); vi.restoreAllMocks(); await h.close(); }
});

it.each(["on", "reset"])("aborts hooks %s during config read without committing either file", async (action) => {
	const h = await detectorFixture();
	try {
		await h.config({ product: { keep: 1 }, hook: { enabled: true } });
		const local = path.join(h.directory, ".impeccable/config.local.json");
		await fs.writeFile(local, '{"hook":{"enabled":false},"keep":2}');
		const before = await readConfigs(h.directory);
		const controller = new AbortController();
		const read = fs.readFile;
		vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
			const result = await read(...args);
			// Resolution has read-only discovery reads too; cancel the actual
			// management snapshot, which explicitly carries this operation signal.
			if (args[0] === local && typeof args[1] === "object" && args[1]?.signal === controller.signal) controller.abort();
			return result;
		});
		const result = await runOperation({ argv: ["hooks", action], cwd: h.directory, signal: controller.signal }, h.api);
		expect(result).toMatchObject({ ok: false, status: "cancelled", integration: { committed: [], partial: false } });
		expect((await readConfigs(h.directory)).map((config) => config.text)).toEqual(before.map((config) => config.text));
	} finally { vi.restoreAllMocks(); await h.close(); }
});

it.each(["stage-copy", "stage-read"])("aborts ignore %s before any real commit and cleans only its external stage", async (phase) => {
	const h = await detectorFixture();
	let stage: string | undefined;
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ product: { keep: 1 } });
		const before = await readConfigs(h.directory);
		const controller = new AbortController();
		if (phase === "stage-copy") {
			const write = fs.writeFile;
			vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
				const result = await write(...args);
				if (String(args[0]).includes("/pi-impeccable-admin-")) { stage = path.dirname(path.dirname(String(args[0]))); controller.abort(); }
				return result;
			});
		} else {
			const read = fs.readFile;
			vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
				const result = await read(...args);
				if (String(args[0]).includes("/pi-impeccable-admin-")) { stage = path.dirname(path.dirname(String(args[0]))); controller.abort(); }
				return result;
			});
		}
		const result = await runOperation({ argv: ["ignores", "add-file", "page.html"], cwd: h.directory, signal: controller.signal }, h.api);
		expect(result).toMatchObject({ ok: false, status: "cancelled", integration: { committed: [], partial: false } });
		expect(stage).toBeDefined();
		expect(path.relative(h.directory, stage!).startsWith("..")).toBe(true);
		await expect(fs.stat(stage!)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await readConfigs(h.directory)).map((config) => config.text)).toEqual(before.map((config) => config.text));
	} finally { vi.restoreAllMocks(); await h.close(); }
});

it.each(["hooks", "ignore", "exclude", "hook-exclude", "pin"])("reports cancellation after a real %s commit with the actual committed path", async (kind) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ product: { keep: 1 } });
		const local = path.join(h.directory, ".impeccable/config.local.json");
		await fs.writeFile(local, '{"hook":{"enabled":false},"keep":2}');
		const controller = new AbortController();
		if (kind === "exclude" || kind === "hook-exclude") await promisify(execFile)("git", ["init"], { cwd: h.directory });
		const file = kind === "pin" ? path.join(h.directory, ".pi/prompts/layout.md") : kind === "exclude" || kind === "hook-exclude" ? path.join(h.directory, ".git/info/exclude") : path.join(h.directory, ".impeccable/config.json");
		const rename = fs.rename;
		vi.spyOn(fs, "rename").mockImplementation(async (...args) => { const result = await rename(...args); if (args[1] === file) controller.abort(); return result; });
		const argv = kind === "hooks" || kind === "hook-exclude" ? ["hooks", "on"] : kind === "pin" ? ["pin", "layout"] : ["ignores", "add-file", "page.html", ...(kind === "exclude" ? ["--local"] : [])];
		const result = await runOperation({ argv, cwd: h.directory, signal: controller.signal }, h.api);
		expect(result).toMatchObject({ ok: false, status: "cancelled", integration: { committed: [file], partial: true } });
		expect(result.stderr).toContain(file);
		expect(result.stderr).not.toContain("before mutation");
		expect(await fs.readFile(local, "utf8")).toBe('{"hook":{"enabled":false},"keep":2}');
		expect((await fs.readdir(path.dirname(file))).some((name) => name.endsWith(".tmp"))).toBe(false);
	} finally { vi.restoreAllMocks(); await h.close(); }
});

it("checks cancellation after acquiring Pi's actual file queue before committing", async () => {
	const h = await detectorFixture(); const reached = gate(); const release = gate();
	let holder: Promise<unknown> | undefined;
	try {
		await h.config({ product: { keep: 1 } });
		const config = (await readConfigs(h.directory))[0]!;
		holder = withFileMutationQueue(config.file, async () => { reached.resolve(); await release.promise; });
		await reached.promise;
		const controller = new AbortController();
		const waiting = saveConfig(config, { hook: { enabled: true } }, controller.signal);
		const refusal = expect(waiting).rejects.toThrow();
		await tick(); controller.abort(); release.resolve(); await holder; await refusal;
		expect((await readConfigs(h.directory))[0]!.value).toEqual({ product: { keep: 1 } });
		await withManagedFileMutation(config.file, undefined, async () => {});
	} finally { release.resolve(); await holder; await h.close(); }
});
