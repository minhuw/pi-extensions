import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrcaWorkerApi } from "orca/worker";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import bridge from "../index.ts";
import { Activities, parseSnapshot } from "../activity.ts";
import { SnapshotPublisher } from "../companion.ts";
import { CompanionRuntime } from "../plugin/src/worker.ts";
import { entries, hasCompanion, privateDirectory, readJson, snapshotName, writeJson } from "../plugin/src/files.ts";
import { MAX_SNAPSHOT_BYTES, RETAIN_MS, STALE_MS, parseSession, summarize, type ActivityView, type SessionSnapshot } from "../plugin/src/protocol.ts";
import { session } from "../plugin/tests/fixtures.ts";

let directory: string;
let close: Array<() => Promise<void>>;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-orca-companion-"));
	close = [];
	vi.stubEnv("PI_ORCA_COMPANION_DIR", directory);
	vi.stubEnv("PI_ORCA_COMPANION", undefined);
});
afterEach(async () => {
	for (const stop of close.reverse()) await stop();
	vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

function host() {
	let list: () => Promise<ActivityView> = async () => ({ sessions: [], unavailable: false, truncated: false });
	const commands = new Map<string, () => Promise<string>>();
	const dispose = vi.fn();
	const api = {
		panels: { handle: vi.fn((_name: string, handler: typeof list) => { list = handler; return { dispose }; }), post: vi.fn() },
		commands: { register: vi.fn((name: string, handler: () => Promise<string>) => { commands.set(name, handler); return { dispose }; }) },
		hooks: { on: vi.fn(() => ({ dispose })) },
		host: { has: vi.fn(() => true), call: vi.fn(async (_name: string, _params: unknown) => ({ ok: true })) }, log: vi.fn(),
	};
	return { api, commands, list: () => list(), typed: api as unknown as OrcaWorkerApi };
}
async function runtime() {
	const h = host(), worker = new CompanionRuntime(h.typed, directory);
	close.push(() => worker.close());
	await worker.start();
	return { ...h, worker };
}
function publisher(build: (id: string, now: number) => SessionSnapshot = (id, now) => ({ ...session(), instanceId: id, updatedAt: now })) {
	const writer = new SnapshotPublisher(directory, build);
	close.push(() => writer.close());
	writer.start();
	return writer;
}
const connected = (writer: SnapshotPublisher) => vi.waitFor(() => expect(writer.status).toBe("connected"));

it("does not publish or create a directory without a live companion", async () => {
	const absent = join(directory, "absent"), writer = new SnapshotPublisher(absent, () => { throw new Error("must not read session data"); });
	close.push(() => writer.close()); writer.start();
	await new Promise(resolve => setTimeout(resolve, 150));
	expect(writer.status).toBe("waiting for plugin");
	expect(await readdir(directory)).toEqual([]);
	expect(await hasCompanion(absent, Date.now())).toBe(false);
});

it("projects live metadata through real files and keeps background work after parent settlement", async () => {
	const h = await runtime();
	let rootRunning = true, background = true;
	const writer = publisher((id, now) => ({ ...session(), instanceId: id, updatedAt: now, parent: rootRunning ? "running" : "idle", ...(background ? {} : { activities: [], activityCount: 0 }) }));
	await connected(writer);
	let view = await h.list();
	expect(view.sessions).toHaveLength(1);
	expect(summarize(view)).toMatchObject({ working: 1, activities: 2 });
	rootRunning = false; writer.update();
	await vi.waitFor(async () => expect((await h.list()).sessions[0].parent).toBe("idle"));
	expect(summarize(await h.list()).working).toBe(1);
	background = false; writer.update();
	await vi.waitFor(async () => expect(summarize(await h.list())).toMatchObject({ working: 0, activities: 0, sessions: 1 }));
	expect(h.api.host.call.mock.calls.at(-1)?.[1]).toMatchObject({ text: "π · 1 idle" });
	await writer.close();
	view = await h.list();
	expect(view.sessions).toEqual([]);
});

it("rediscovers sessions after worker restart without waiting for a new Pi turn", async () => {
	const first = await runtime(), writer = publisher();
	await connected(writer);
	await first.worker.close();
	const second = await runtime();
	expect((await second.list()).sessions[0].instanceId).toBe(writer.instanceId);
	expect(await second.commands.get("activity.summary")!()).toContain("Review the Orca integration");
});

it("marks stale work disconnected, prunes expired snapshots and rejects future timestamps", async () => {
	const h = await runtime(), row = session({ updatedAt: Date.now() - STALE_MS - 100, startedAt: Date.now() - 180_000 });
	await writeJson(directory, snapshotName(row.instanceId), row);
	expect(summarize(await h.list())).toMatchObject({ working: 0, activities: 0, disconnected: 1 });
	await writeJson(directory, snapshotName(row.instanceId), { ...row, updatedAt: Date.now() + 60_000 });
	expect((await h.list()).sessions).toEqual([]);
	await writeJson(directory, snapshotName(row.instanceId), { ...row, activities: [], startedAt: 0, updatedAt: Date.now() - RETAIN_MS - 1 });
	expect((await h.list()).sessions).toEqual([]);
	expect(await readJson(directory, snapshotName(row.instanceId))).toBeUndefined();
});

it("deduplicates reload instances by pane and prefers the latest snapshot", async () => {
	const h = await runtime(), old = session({ updatedAt: Date.now() - 1_000 }), next = session({ instanceId: randomUUID(), title: "Reloaded session" });
	await writeJson(directory, snapshotName(old.instanceId), old);
	await writeJson(directory, snapshotName(next.instanceId), next);
	expect((await h.list()).sessions.map(row => row.title)).toEqual(["Reloaded session"]);
});

it("refuses shared directories, symlinks, oversized files and malformed protocol data", async () => {
	const row = session(), name = snapshotName(row.instanceId);
	await writeFile(join(directory, "target"), JSON.stringify(row), { mode: 0o600 });
	await symlink(join(directory, "target"), join(directory, name));
	expect(await readJson(directory, name)).toBeUndefined();
	await rm(join(directory, name));
	await writeFile(join(directory, name), "x".repeat(MAX_SNAPSHOT_BYTES + 1), { mode: 0o600 });
	expect(await readJson(directory, name)).toBeUndefined();
	await chmod(directory, 0o755);
	expect(await privateDirectory(directory)).toBe(process.platform === "win32");
	await chmod(directory, 0o700);
	expect(parseSession({ ...row, version: 2 })).toBeUndefined();
	expect(parseSession({ ...row, activityCount: 0 })).toBeUndefined();
	expect(parseSession({ ...row, activities: [row.activities[0], row.activities[0]] })).toBeUndefined();
	expect(parseSession({ ...row, prompt: "secret prompt", toolInput: { token: "secret" } })).not.toHaveProperty("prompt");
});

it.skipIf(process.platform === "win32")("skips FIFOs without blocking polling, presence checks or shutdown", async () => {
	const names = ["plugin-00000000-0000-0000-0000-000000000000.json", `session-${randomUUID()}.json`];
	execFileSync("mkfifo", names.map(name => join(directory, name)));
	// A subprocess deadline also bounds a regression in open(): it cannot strand the
	// test runner's libuv thread pool or its shutdown hooks waiting for a FIFO writer.
	const files = new URL("../plugin/src/files.ts", import.meta.url).href;
	const script = `
		import { hasCompanion, readJson } from ${JSON.stringify(files)};
		const directory = ${JSON.stringify(directory)};
		for (const name of ${JSON.stringify(names)}) {
			if (await readJson(directory, name) !== undefined) throw new Error("FIFO accepted");
		}
		if (await hasCompanion(directory, Date.now())) throw new Error("FIFO is not a heartbeat");
		console.log("skipped");
	`;
	expect(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { timeout: 3_000, encoding: "utf8" }).trim()).toBe("skipped");
	const h = await runtime(), writer = publisher();
	await connected(writer);
	expect((await h.list()).sessions).toHaveLength(1);
	await writer.close();
	await h.worker.close();
});

it("accepts additive activity metadata atomically and never evaluates event getters", () => {
	const activities = new Activities(), getter = vi.fn(() => { throw new Error("getter"); });
	const row = { id: "workflow:1", label: "Review", state: "waiting", kind: "workflow", startedAt: 10, progress: { completed: 2, total: 3 } };
	expect(activities.update({ source: "subagents", activities: [row] })).toBe(true);
	expect(activities.entries()[0]).toMatchObject(row);
	expect(activities.update({ source: "subagents", activities: [{ ...row, progress: { completed: 4, total: 3 } }] })).toBe(false);
	expect(activities.entries()[0].progress).toEqual({ completed: 2, total: 3 });
	const invalid = Object.defineProperty({}, "id", { get: getter });
	expect(parseSnapshot({ source: "subagents", activities: [invalid] })).toBeUndefined();
	expect(getter).not.toHaveBeenCalled();
});

it("coalesces rapid updates and leaves no snapshot after shutdown during an update", async () => {
	await runtime();
	let title = "initial";
	const writer = publisher((id, now) => ({ ...session(), instanceId: id, updatedAt: now, title }));
	for (let i = 0; i < 100; i++) { title = `update-${i}`; writer.update(); }
	await connected(writer);
	expect(await readJson(directory, snapshotName(writer.instanceId))).toMatchObject({ title: "update-99" });
	title = "obsolete"; writer.update();
	await writer.close();
	await new Promise(resolve => setTimeout(resolve, 150));
	expect((await entries(directory)).names.some(name => name.startsWith("session-"))).toBe(false);
});

it("connects the actual bridge lifecycle to the companion and clears it on shutdown", async () => {
	const h = await runtime();
	for (const key of Object.keys(process.env)) if (key.startsWith("ORCA_")) vi.stubEnv(key, undefined);
	vi.stubEnv("ORCA_PANE_KEY", "integration-pane"); vi.stubEnv("ORCA_AGENT_HOOK_PORT", "12345"); vi.stubEnv("ORCA_AGENT_HOOK_TOKEN", "offline-token");
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emit = (channel: string, data: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(data); };
	const ctx = { mode: "tui", cwd: "/project", ui: { setTitle: () => {} }, sessionManager: { getSessionId: () => "bridge-session", getSessionName: () => "Bridge integration", getSessionFile: () => undefined } } as unknown as ExtensionContext;
	bridge({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); return () => { handlers.delete(name); }; }, registerCommand: () => {}, events: {
		emit, on: (channel: string, listener: (data: unknown) => void) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); return () => { set.delete(listener); }; },
	} } as unknown as ExtensionAPI);
	const fire = async (name: string) => { await handlers.get(name)?.({}, ctx); };
	close.push(() => fire("session_shutdown"));
	await fire("session_start"); await fire("agent_start");
	emit("pi-extensions:activity", { source: "herder", activities: [{ id: "T1", label: "Herder T1 · Build" }] });
	await vi.waitFor(async () => expect((await h.list()).sessions[0]).toMatchObject({ parent: "running", activityCount: 1 }));
	await fire("agent_end"); await fire("agent_settled");
	await vi.waitFor(async () => expect((await h.list()).sessions[0]).toMatchObject({ parent: "idle", activityCount: 1 }));
	await fire("ui_prompt_start");
	await vi.waitFor(async () => expect(summarize(await h.list()).waiting).toBe(1));
	await fire("session_shutdown");
	expect((await h.list()).sessions).toEqual([]);
});

it("pins the upstream plugin typings and their provenance", async () => {
	const root = new URL("../plugin/types/", import.meta.url);
	const provenance = JSON.parse(await readFile(new URL("upstream.json", root), "utf8")) as { tag: string; files: Array<{ file: string; sha256: string }> };
	expect(provenance.tag).toBe("v1.4.247");
	for (const file of provenance.files) expect(createHash("sha256").update(await readFile(new URL(file.file, root))).digest("hex")).toBe(file.sha256);
});
