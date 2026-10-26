import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { credentials } from "../shared.ts";
import { FakeRelay, TOKEN } from "./support/relay-server.ts";
import { Notes, startSession, waitFor, Workspace, type Harness } from "./support/runtime.ts";

// pika loads by path, after relay, as in the collection; relay only reads its credentials registry.
const pikaPath = fileURLToPath(new URL("../../pika/index.ts", import.meta.url));

let workspace: Workspace;
let relay: FakeRelay;
let other: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); other = await new FakeRelay().start("/pika"); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await other.stop();
	await workspace.cleanup();
});

/** Notes plus scripted answers for `/pika login`'s method choice and token prompt. */
function loginUI(notes: Notes, token: string): ExtensionUIContext {
	const base = notes.context();
	return new Proxy(base, {
		get: (target, name) => name === "select" ? async () => "Paste a token" : name === "input" ? async () => token : target[name as keyof ExtensionUIContext],
	});
}

it("follows the credentials the pika extension publishes: at its session start, after /pika login, and after /pika logout", async () => {
	await writeFile(join(workspace.agentDir, "pika.json"), JSON.stringify({ url: relay.url, token: TOKEN }));
	other.tokens.add("other-token");
	const notes = new Notes();
	const h = await startSession({
		workspace, extensionPaths: [pikaPath], sessionManager: SessionManager.inMemory(workspace.cwd), ui: loginUI(notes, "other-token"),
	});
	harnesses.push(h);
	const id = h.session.sessionId;
	await waitFor(() => relay.online(id) !== undefined, 5_000, "the first server");
	expect(credentials().current?.url).toBe(relay.url);

	await h.session.prompt(`/pika login ${other.url}`);
	expect(notes.messages.some((message) => message.startsWith(`Logged in to ${other.url}`))).toBe(true);
	await waitFor(() => other.online(id) !== undefined && relay.online(id) === undefined, 5_000, "the second server");
	expect(other.upgrades.map((upgrade) => [upgrade.path, upgrade.authorization])).toEqual([["/pika/api/relay/v1/connect", "Bearer other-token"]]);

	await h.session.prompt("/pika logout");
	await waitFor(() => other.online(id) === undefined, 5_000, "the logout");
	expect(credentials().current).toBeUndefined();
	await h.session.prompt("/relay");
	expect(notes.last!.message.split("\n")[0]).toBe("Relay is offline: pika is not logged in or is disabled; run /pika login.");
	expect(h.errors).toEqual([]);
}, 20_000);
