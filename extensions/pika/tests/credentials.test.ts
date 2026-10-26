import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CREDENTIALS, type CredentialsRegistry } from "../credentials.ts";
import pikaExtension from "../index.ts";
import { PASTE } from "../login.ts";
import { MockIngest, TOKEN } from "./support/ingest-server.ts";
import { startSession, Workspace } from "./support/runtime.ts";
import { ScriptedUI } from "./support/ui.ts";

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => {
	delete (globalThis as Record<symbol, unknown>)[CREDENTIALS];
	workspace = await Workspace.create();
	ingest = await new MockIngest().start();
});
afterEach(async () => {
	delete process.env.PIKA_DISABLED;
	await ingest.stop();
	await workspace.cleanup();
});

/** The registry as another extension sees it: created first, with a listener that counts changes. */
function observe(): { registry: CredentialsRegistry; changes: (string | undefined)[] } {
	const registry = ((globalThis as Record<symbol, CredentialsRegistry | undefined>)[CREDENTIALS] ??= { current: undefined, listeners: new Set() });
	const changes: (string | undefined)[] = [];
	registry.listeners.add(() => { changes.push(registry.current?.url); });
	return { registry, changes };
}

async function run(ui: ScriptedUI, commands: string[]): Promise<void> {
	const h = await startSession({ workspace, extensions: [pikaExtension], ui: ui.context() });
	try {
		for (const text of commands) await h.session.prompt(text);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); }
}

it("publishes the url, token, and exclude patterns when enabled, and notifies only on a change", async () => {
	const { registry, changes } = observe();
	const secret = join(workspace.root, "secret");
	await workspace.enable(ingest.url, { exclude: [secret] });
	await run(new ScriptedUI(), []);
	expect(registry.current).toMatchObject({ url: ingest.url, token: TOKEN });
	expect(registry.current!.isExcluded(join(secret, "deep"))).toBe(true);
	expect(registry.current!.isExcluded(workspace.cwd)).toBe(false);
	expect(changes).toEqual([ingest.url]);

	// Another session with the same configuration changes nothing.
	const before = registry.current;
	await run(new ScriptedUI(), []);
	expect(registry.current).toBe(before);
	expect(changes).toEqual([ingest.url]);

	// A changed exclude list is a change.
	await workspace.enable(ingest.url);
	await run(new ScriptedUI(), []);
	expect(registry.current!.isExcluded(join(secret, "deep"))).toBe(false);
	expect(changes).toEqual([ingest.url, ingest.url]);
});

it("leaves the registry empty when unconfigured and clears it when PIKA_DISABLED=1", async () => {
	const { registry, changes } = observe();
	await run(new ScriptedUI(), []);
	expect(registry.current).toBeUndefined();
	expect(changes).toEqual([]);

	await workspace.enable(ingest.url);
	await run(new ScriptedUI(), []);
	expect(registry.current?.url).toBe(ingest.url);
	process.env.PIKA_DISABLED = "1";
	await run(new ScriptedUI(), []);
	expect(registry.current).toBeUndefined();
	expect(changes).toEqual([ingest.url, undefined]);
});

it("follows /pika login to another server and /pika logout", async () => {
	const other = await new MockIngest().start();
	try {
		const { registry, changes } = observe();
		await workspace.enable(ingest.url);
		const ui = new ScriptedUI();
		ui.inputs = [other.url, TOKEN];
		ui.choices = [PASTE];
		await run(ui, ["/pika login", "/pika logout"]);
		expect(ui.messages.some((message) => message.startsWith(`Logged in to ${other.url}`))).toBe(true);
		expect(changes).toEqual([ingest.url, other.url, undefined]);
		expect(registry.current).toBeUndefined();
	} finally { await other.stop(); }
});

it("lets the registry be created by either side first", async () => {
	await workspace.enable(ingest.url);
	await run(new ScriptedUI(), []);
	const registry = (globalThis as Record<symbol, CredentialsRegistry | undefined>)[CREDENTIALS];
	expect(registry?.current?.url).toBe(ingest.url);
	expect(registry?.listeners).toBeInstanceOf(Set);
});
