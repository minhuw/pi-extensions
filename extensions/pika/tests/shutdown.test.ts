import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import pikaExtension from "../index.ts";
import { deviceKeyHooks } from "../device-key.ts";
import { machineSource } from "../uploader.ts";
import { MockIngest } from "./support/ingest-server.ts";
import { startSession, waitFor, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => { await ingest.stop(); await workspace.cleanup(); });

/** Holds every bind before its key write, at the machine fingerprint, until `open()`; `calls` counts the binds that got there. */
function holdMachine(): { calls: number; open: () => void } {
	let release!: () => void;
	const opened = new Promise<void>((resolve) => { release = resolve; });
	const gate = { calls: 0, open: () => release() };
	deviceKeyHooks.machine = async () => { gate.calls++; await opened; return machineSource(); };
	return gate;
}

const listing = async () => (await readdir(workspace.pikaDir, { recursive: true }).catch(() => [])).sort();
const keyFiles = (names: string[]) => names.filter((name) => basename(name) === "device-key.json" || name.endsWith(".tmp"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("waits at the last session's shutdown for the bind it aborts, which writes no key file", async () => {
	const gate = holdMachine();
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		await waitFor(() => gate.calls === 1, 5_000, "the bind");
		const shutdown = h.shutdown();
		setTimeout(gate.open, 50);
		await shutdown;
		const after = await listing();
		await sleep(500);
		expect(await listing()).toEqual(after);
		expect(keyFiles(after)).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally {
		gate.open();
		await h.shutdown();
		delete deviceKeyHooks.machine;
	}
}, 10_000);

it("ends the last session's shutdown within a second while a bind waits, never writes its key, and binds again in a later session", async () => {
	let gate = holdMachine();
	await workspace.enable(ingest.url);
	const h = await startSession({ workspace, extensions: [pikaExtension] });
	let later: Awaited<ReturnType<typeof startSession>> | undefined;
	try {
		await waitFor(() => gate.calls === 1, 5_000, "the bind");
		const started = Date.now();
		await h.shutdown();
		expect(Date.now() - started).toBeLessThan(1_500);
		gate.open();
		await sleep(1_000);
		expect(keyFiles(await listing())).toEqual([]);
		expect(ingest.binds).toEqual([]);

		gate = holdMachine();
		later = await startSession({ workspace, extensions: [pikaExtension] });
		await waitFor(() => gate.calls === 1, 5_000, "the bind in the later session");
		gate.open();
		await waitFor(async () => (await listing()).includes("device-key.json"), 5_000, "the key file");
		await waitFor(() => ingest.binds.length === 1, 5_000, "the bind request");
		expect(h.errors).toEqual([]);
		expect(later.errors).toEqual([]);
	} finally {
		gate.open();
		await h.shutdown();
		await later?.shutdown();
		delete deviceKeyHooks.machine;
	}
}, 15_000);
