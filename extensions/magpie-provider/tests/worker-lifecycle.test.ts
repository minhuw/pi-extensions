import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { parseModels } from "../index.ts";

const extension = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
const name = "claude-opus-5-5";
const physical = `contabo/claude/${name}`;
const origin = "http://127.0.0.1:3425";
const catalog = { data: [{ id: physical, owned_by: "contabo", native_endpoints: ["/v1/messages"], context_window: 200000, max_output_tokens: 4096 }] };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function response() {
	const events = [
		{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: physical, content: [],
			stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } });
}

it.each(["healthy", "unavailable", "offline", "saved-unavailable", "saved-offline"] as const)("keeps the parent's Claude alias through four concurrent worktree sessions with %s child discovery", async mode => {
	const directory = mkdtempSync(join(tmpdir(), "magpie-workers-"));
	const sessions: AgentSession[] = [];
	try {
		const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
		git("init", "--quiet");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "--allow-empty", "-m", "fixture");
		const worktrees = Array.from({ length: 4 }, (_, index) => join(directory, `worker-${index}`));
		for (const cwd of worktrees) git("worktree", "add", "--quiet", "--detach", cwd, "HEAD");
		const agentDir = join(directory, "agent");
		const saved = mode.startsWith("saved-");
		const offline = mode.endsWith("offline");
		const credential = { type: "api_key" as const, key: "saved-key", env: { MAGPIE_BASE_URL: origin } };
		if (saved) {
			mkdirSync(agentDir);
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ magpie: credential }));
		}
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("MAGPIE_BASE_URL", origin);
		vi.stubEnv("MAGPIE_API_KEY", "fixture-key");
		let unavailable = false;
		let discoveries = 0;
		const requests: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
			if (url.origin !== origin) throw new Error("Unexpected network request");
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			const apiKey = saved ? credential.key : "fixture-key";
			expect(url.pathname === "/v1/models" ? headers.get("authorization") : headers.get("x-api-key"))
				.toBe(url.pathname === "/v1/models" ? `Bearer ${apiKey}` : apiKey);
			if (url.pathname === "/v1/models") {
				discoveries++;
				if (unavailable) throw new Error("simulated catalog outage");
				return Response.json(catalog);
			}
			if (url.pathname !== "/v1/messages") throw new Error("Unexpected gateway endpoint");
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return response();
		}));
		const credentials = new InMemoryCredentialStore();
		if (saved) await credentials.modify("magpie", async () => credential);
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const selected = parseModels(catalog, origin).find(model => model.id === name)!;
		async function start(cwd: string) {
			const settingsManager = SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false }, retry: { enabled: false } });
			// Load the real extension anew, as Subagents does, with the same runtime.
			// Separate loader module caches must still see the validated catalog.
			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
				noExtensions: true, additionalExtensionPaths: [extension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				// Saved login also registers search. Let native MCP handle it with a
				// disabled config entry so this fixture sends only model requests.
				extensionFactories: saved ? [createMcpExtension({ loadConfig: () => ({
					servers: [{ name: "magpie-web-search", config: { url: `${origin}/mcp`, enabled: false }, source: "fixture", scope: "global" }],
					errors: [], autoEnableCodemode: false,
				}) })] : [],
			});
			await resourceLoader.reload();
			expect(resourceLoader.getExtensions().errors).toEqual([]);
			const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: selected, thinkingLevel: "off",
				noTools: "all", settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd),
			});
			sessions.push(session);
			await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
			return session;
		}
		const expectSuccess = (session: AgentSession) => expect(session.messages.findLast(message => message.role === "assistant"))
			.toMatchObject({ model: name, magpiePhysicalModel: physical, stopReason: "stop", content: [{ type: "text", text: "OK" }] });
		const parent = await start(directory);
		await parent.prompt("First parent request.");
		expectSuccess(parent);
		unavailable = mode.endsWith("unavailable");
		if (offline) vi.stubEnv("PI_OFFLINE", "1");
		const workers = await Promise.all(worktrees.map(start));
		await Promise.all(workers.map(worker => worker.prompt("First worker request.")));
		for (const worker of workers) {
			expectSuccess(worker);
			await worker.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			worker.dispose();
		}
		// Even a refresh during an outage must retain the validated snapshot.
		unavailable = true;
		expect((await runtime.refresh({ providers: ["magpie"], allowNetwork: true, force: true })).errors.has("magpie")).toBe(true);
		unavailable = false;
		await parent.prompt("Parent continues after worker cleanup.");
		expectSuccess(parent);
		expect(requests).toHaveLength(6);
		expect(requests.every(request => request.model === physical)).toBe(true);
		expect(discoveries).toBe(offline ? 2 : 6);
		// Existing session transcripts still carry recoverable short selections.
		expect(parent.messages.filter(message => message.role === "assistant")).toHaveLength(2);
	} finally {
		for (const session of sessions) session.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
}, 30_000);
