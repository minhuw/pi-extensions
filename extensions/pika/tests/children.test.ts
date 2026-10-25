import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pikaExtension, { CHILD_SESSION_HOOKS, type ChildSessionHook } from "../index.ts";
import { MockIngest } from "./support/ingest-server.ts";
import { MockProvider } from "./support/provider-server.ts";
import { readText, startSession, waitFor, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let ingest: MockIngest;
beforeEach(async () => { workspace = await Workspace.create(); ingest = await new MockIngest().start(); });
afterEach(async () => { await ingest.stop(); await workspace.cleanup(); });

const registered = () => [...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? [])];

it("registers a child-session hook whose factory captures the child as its own stream, link entry included", async () => {
	await workspace.enable(ingest.url);
	expect(registered()).toEqual([]);
	const main = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		expect(registered().map((hook) => hook.name)).toEqual(["pika"]);
		main.faux.setResponses([fauxAssistantMessage("main")]);
		await main.session.prompt("parent prompt");

		const manager = SessionManager.create(workspace.cwd, workspace.sessionDir, { parentSession: main.session.sessionFile });
		const child = await startSession({ workspace, sessionManager: manager, faux: main.faux, extensions: registered().map((hook) => hook.extensionFactory) });
		const link = {
			kind: "subagent", parentSessionId: main.session.sessionId, parentSessionFile: main.session.sessionFile,
			parentToolCallId: "call_1", agentId: "agent-1", agentType: "worker", description: "child task",
		};
		try {
			manager.appendCustomEntry("pi-extensions.session-link", link);
			main.faux.appendResponses([fauxAssistantMessage("child")]);
			await child.session.prompt("child prompt");
			const key = `session:${child.session.sessionId}`;
			await waitFor(async () => ingest.data(key) === await readText(child.session.sessionFile!), 5_000, "child upload");
			const lines = ingest.data(key)!.trim().split("\n");
			const linkLine = lines.find((line) => line.includes("pi-extensions.session-link"))!;
			expect(JSON.parse(linkLine)).toMatchObject({ type: "custom", customType: "pi-extensions.session-link", data: link });
			expect((await readText(child.session.sessionFile!)).split("\n")).toContain(linkLine);
			await waitFor(() => ingest.sessionRequests(child.session.sessionId).length === 1, 5_000, "child request");
			expect(child.errors).toEqual([]);
		} finally { await child.shutdown(); }

		// The parent is still active, so the hook stays registered.
		expect(registered().map((hook) => hook.name)).toEqual(["pika"]);
		await waitFor(async () => ingest.data(`session:${main.session.sessionId}`) === await readText(main.session.sessionFile!), 5_000, "parent upload");
	} finally { await main.shutdown(); }
	expect(registered()).toEqual([]);
}, 20_000);

it("captures once, with the last-loaded instance, when pika loads twice into one session", async () => {
	const provider = await new MockProvider().start();
	await workspace.enable(ingest.url);
	const modify = (pi: ExtensionAPI) => {
		pi.on("before_provider_request", (event) => ({ ...(event.payload as object), metadata: { between: true } }));
	};
	// As in a child that loads pika from the package and again through the hook, which calls the same factory.
	const h = await startSession({ workspace, extensions: [pikaExtension, modify, pikaExtension], openAiBaseUrl: provider.baseUrl });
	try {
		await h.session.prompt("one");
		await h.session.prompt("two");
		const key = `session:${h.session.sessionId}`;
		await waitFor(async () => ingest.data(key) === await readText(h.session.sessionFile!) && ingest.sessionRequests(h.session.sessionId).length >= 2, 5_000, "upload");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const requests = ingest.sessionRequests(h.session.sessionId);
		expect(requests.map((request) => request.seq)).toEqual([1, 2]);
		for (const [index, request] of requests.entries()) expect(ingest.payload(request.id)).toEqual(JSON.parse(provider.bodies[index]!));
		expect(ingest.payload(requests[0]!.id)).toMatchObject({ metadata: { between: true } });
		expect(ingest.conflicts).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally { await h.shutdown(); await provider.stop(); }
	expect(registered()).toEqual([]);
}, 20_000);

it("captures once when one module copy loads by path and another arrives through the hook", async () => {
	await workspace.enable(ingest.url);
	const main = await startSession({ workspace, extensions: [pikaExtension] });
	try {
		const [hook] = registered();
		const path = fileURLToPath(new URL("../index.ts", import.meta.url));
		const child = await startSession({ workspace, faux: main.faux, extensionPaths: [path], extensions: [hook!.extensionFactory] });
		try {
			const loaded = child.session.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
			expect(loaded.filter((loadedPath) => loadedPath === path || loadedPath.startsWith("<inline:"))).toHaveLength(3);
			expect(loaded).toContain(path);
			main.faux.setResponses([fauxAssistantMessage("child")]);
			await child.session.prompt("child prompt");
			const key = `session:${child.session.sessionId}`;
			await waitFor(async () => ingest.data(key) === await readText(child.session.sessionFile!) && ingest.sessionRequests(child.session.sessionId).length === 1, 5_000, "child upload");
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(ingest.sessionRequests(child.session.sessionId)).toHaveLength(1);
			expect(child.errors).toEqual([]);
		} finally { await child.shutdown(); }
	} finally { await main.shutdown(); }
	expect(registered()).toEqual([]);
}, 20_000);

it("registers no hook in an excluded session and skips its children while another session keeps the hook", async () => {
	const secret = join(workspace.root, "secret");
	await mkdir(secret, { recursive: true });
	await workspace.enable(ingest.url, { exclude: [secret] });
	const excluded = await startSession({ workspace, cwd: secret, extensions: [pikaExtension] });
	try {
		expect(registered()).toEqual([]);
		const main = await startSession({ workspace, faux: excluded.faux, extensions: [pikaExtension] });
		try {
			expect(registered().map((hook) => hook.name)).toEqual(["pika"]);
			// A worktree-isolated child runs outside the excluded directory.
			const manager = SessionManager.create(workspace.cwd, workspace.sessionDir, { parentSession: excluded.session.sessionFile });
			const child = await startSession({ workspace, sessionManager: manager, faux: excluded.faux, extensions: registered().map((hook) => hook.extensionFactory) });
			try {
				manager.appendCustomEntry("pi-extensions.session-link", { kind: "subagent", parentSessionId: excluded.session.sessionId });
				excluded.faux.setResponses([fauxAssistantMessage("child")]);
				await child.session.prompt("child prompt");
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				expect(ingest.streams.has(`session:${child.session.sessionId}`)).toBe(false);
				expect(child.errors).toEqual([]);
			} finally { await child.shutdown(); }
		} finally { await main.shutdown(); }
		expect(registered()).toEqual([]);
		expect(ingest.streams.has(`session:${excluded.session.sessionId}`)).toBe(false);
	} finally { await excluded.shutdown(); }
}, 20_000);
