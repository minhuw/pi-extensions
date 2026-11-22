import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { credentialsRegistry } from "../../credentials.ts";
import { FakeRelay, TOKEN } from "./support/relay-server.ts";
import { Notes, relaySuite, waitFor, type Workspace } from "./support/runtime.ts";

// pika loads by path, as in the collection, and brings relay with it; relay only reads its credentials registry.
const pikaPath = fileURLToPath(new URL("../../index.ts", import.meta.url));

let workspace: Workspace;
let relay: FakeRelay;
let other: FakeRelay;
const { open } = relaySuite({
	credentials: false,
	beforeEach: async (s) => { workspace = s.workspace; relay = s.relay; other = await new FakeRelay().start("/pika"); },
	afterCleanup: async () => { await other?.stop(); },
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
	const h = await open({
		noRelay: true, extensionPaths: [pikaPath], sessionManager: SessionManager.inMemory(workspace.cwd), ui: loginUI(notes, "other-token"),
	});
	const id = h.session.sessionId;
	await waitFor(() => relay.online(id) !== undefined, 5_000, "the first server");
	expect(credentialsRegistry().current?.url).toBe(relay.url);

	await h.session.prompt(`/pika login ${other.url}`);
	expect(notes.messages.some((message) => message.startsWith(`Logged in to ${other.url}`))).toBe(true);
	await waitFor(() => other.online(id) !== undefined && relay.online(id) === undefined, 5_000, "the second server");
	expect(other.upgrades.map((upgrade) => [upgrade.path, upgrade.authorization])).toEqual([["/pika/api/relay/v1/connect", "Bearer other-token"]]);

	await h.session.prompt("/pika logout");
	await waitFor(() => other.online(id) === undefined, 5_000, "the logout");
	expect(credentialsRegistry().current).toBeUndefined();
	await h.session.prompt("/relay");
	expect(notes.last!.message.split("\n")[0]).toBe("Relay is offline: pika is not logged in or is disabled; run /pika login.");
	expect(h.errors).toEqual([]);
}, 20_000);

it("registers the git repository's name pika resolves, from a subdirectory of the checkout", async () => {
	const repo = join(workspace.root, "my-repo");
	const cwd = join(repo, "src");
	await mkdir(cwd, { recursive: true });
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	execFileSync("git", ["-C", repo, "init", "-q"], { env });
	await writeFile(join(workspace.agentDir, "pika.json"), JSON.stringify({ url: relay.url, token: TOKEN }));
	const h = await open({ cwd, noRelay: true, extensionPaths: [pikaPath], sessionManager: SessionManager.inMemory(cwd) });
	await waitFor(() => relay.online(h.session.sessionId) !== undefined, 5_000, "welcome");
	expect(relay.hellos()).toEqual([expect.objectContaining({ cwd, project: "my-repo" })]);
	expect(h.errors).toEqual([]);
}, 20_000);
