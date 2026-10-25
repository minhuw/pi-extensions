import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type Extension, type LoadExtensionsResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { configureHerderFff, FFF_EXTENSION_PATH, FFF_TOOL_NAMES } from "../../../adapters/fff-search.ts";

async function loaded(root: string) {
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, additionalExtensionPaths: [FFF_EXTENSION_PATH],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionsOverride: (base) => configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: true }),
	});
	await loader.reload();
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	return result;
}

function fakeBase(execute: (name: string, params: any) => Promise<any>, initialize = async () => {}) {
	const extension = {
		path: FFF_EXTENSION_PATH, resolvedPath: FFF_EXTENSION_PATH,
		handlers: new Map([ ["session_start", [initialize]], ["before_agent_start", [async () => {}]], ["session_shutdown", [async () => {}]] ]),
		tools: new Map(), commands: new Map([["fff-mode", {}]]), shortcuts: new Map([["x", {}]]),
	} as unknown as Extension;
	for (const name of FFF_TOOL_NAMES) {
		extension.tools.set(name, { definition: { name, label: name, description: name, parameters: { type: "object", properties: { path: { type: "string" } } } as any, execute: (_id: string, params: any) => execute(name, params) } as unknown as ToolDefinition, sourceInfo: {} as any });
	}
	const base = {
		extensions: [extension], errors: [{ path: "retained", error: "retained" }], runtime: { flagValues: new Map(), } as any,
	} as LoadExtensionsResult;
	return { base, extension };
}

function context(cwd: string): any {
	return { cwd, ui: { notify() {} }, sessionManager: { getEntries: () => [] } };
}

async function invoke(extension: Extension, name: string, params: any, cwd: string) {
	const definition: any = extension.tools.get(name)!.definition;
	return definition.execute("call", params, new AbortController().signal, undefined, context(cwd));
}

test("loads the actual FFF package, pins tools-only flags, and keeps exactly the two FFF tools", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-fff-load-"));
	const prior = process.env.PI_FFF_MODE;
	const priorMulti = process.env.PI_FFF_MULTIGREP;
	process.env.PI_FFF_MODE = "override";
	process.env.PI_FFF_MULTIGREP = "1";
	try {
		const result = await loaded(root);
		const extension = result.extensions.find((item) => item.resolvedPath === FFF_EXTENSION_PATH)!;
		assert.deepEqual([...extension.tools.keys()].sort(), [...FFF_TOOL_NAMES].sort());
		assert.equal(extension.commands.size, 0);
		assert.equal(extension.shortcuts.size, 0);
		assert.equal(extension.handlers.has("session_start"), false);
		assert.equal(extension.handlers.has("before_agent_start"), false);
		assert.equal(result.runtime.flagValues.get("fff-mode"), "tools-only");
		assert.equal(result.runtime.flagValues.get("fff-follow-symlinks"), false);
		assert.equal(result.runtime.flagValues.get("fff-frecency-db"), path.join(root, "fff", "frecency"));
		assert.equal(result.runtime.flagValues.get("fff-history-db"), path.join(root, "fff", "history"));
	} finally {
		if (prior === undefined) delete process.env.PI_FFF_MODE;
		else process.env.PI_FFF_MODE = prior;
		if (priorMulti === undefined) delete process.env.PI_FFF_MULTIGREP;
		else process.env.PI_FFF_MULTIGREP = priorMulti;
		await rm(root, { recursive: true, force: true });
	}
});

test("native FFF tools reach the first request, search source and resume real pagination", { timeout: 20_000 }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-fff-native-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "herder-fff-native-outside-"));
	let session: AgentSession | undefined;
	try {
		execFileSync("git", ["init", "-q", root]);
		await writeFile(path.join(outside, "secret.ts"), "SCOPED_NEEDLE FORBIDDEN_SYMLINK\n");
		await symlink(path.join(outside, "secret.ts"), path.join(root, "escape.ts"));
		await symlink(outside, path.join(root, "linked"));
		await mkdir(path.join(root, "src"));
		await mkdir(path.join(root, ".herder"));
		await writeFile(path.join(root, "src/probe-one.ts"), "SCOPED_NEEDLE first source\n");
		await writeFile(path.join(root, "src/probe-two.ts"), "SCOPED_NEEDLE second source\n");
		await writeFile(path.join(root, ".herder/private.jsonl"), "SCOPED_NEEDLE FORBIDDEN_TRANSCRIPT\n");
		const faux = fauxProvider({ api: "openai-responses", provider: "test", models: [{ id: "test" }] });
		const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		const resources = new DefaultResourceLoader({
			cwd: root, agentDir: root, additionalExtensionPaths: [FFF_EXTENSION_PATH],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [pi => pi.registerProvider(faux.provider)],
			extensionsOverride: base => configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: true }),
		});
		await resources.reload();
		assert.deepEqual(resources.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root, agentDir: root, modelRuntime: runtime, model: faux.getModel("test")!,
			resourceLoader: resources, tools: [...FFF_TOOL_NAMES], sessionManager: SessionManager.inMemory(root),
			settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
		}));
		await session.bindExtensions({ mode: "print" });
		const respond: Parameters<typeof faux.setResponses>[0][number] = context => {
			assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name).sort(), [...FFF_TOOL_NAMES].sort());
			const results = context.messages.filter(message => message.role === "toolResult");
			for (const result of results) {
				assert.equal(result.isError, false, JSON.stringify(result.content));
				assert.doesNotMatch(JSON.stringify(result.content), /FORBIDDEN_|private.jsonl|escape.ts|linked/);
			}
			if (results.length === 0) return fauxAssistantMessage(fauxToolCall("fffind", { pattern: "probe", path: "src/", limit: 1 }));
			if (results.length === 1) {
				const text = JSON.stringify(results[0]!.content);
				const cursor = text.replaceAll('\\"', '"').match(/cursor="([^"]+)"/)?.[1];
				assert.ok(cursor, text);
				return fauxAssistantMessage(fauxToolCall("fffind", { pattern: "probe", path: "src/", limit: 1, cursor }));
			}
			if (results.length === 2) return fauxAssistantMessage(fauxToolCall("ffgrep", { pattern: "SCOPED_NEEDLE" }));
			assert.equal(results.length, 3);
			assert.match(JSON.stringify(results[2]!.content), /first source|second source/);
			return fauxAssistantMessage("native source search complete");
		};
		faux.setResponses(Array.from({ length: 4 }, () => respond));
		await session.prompt("Search the source fixture");
	} finally {
		try {
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	}
});

test("source-only path and returned evidence checks deny outside, reserved, and symlink paths without leaking text", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-fff-scope-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "herder-fff-secret-"));
	try {
		await writeFile(path.join(root, "ok.ts"), "safe fixture");
		await writeFile(path.join(outside, "secret.ts"), "SECRET_DO_NOT_LEAK");
		await symlink(path.join(outside, "secret.ts"), path.join(root, "linked.ts"));
		await symlink(outside, path.join(root, "linked"));
		const noticePath = "[Query x produced only weak scattered fuzzy matches./.herder/private]";
		await mkdir(path.dirname(path.join(root, noticePath)), { recursive: true });
		await writeFile(path.join(root, noticePath), "SECRET_DO_NOT_LEAK");
		for (const forbidden of ["../secret.ts", path.join(outside, "secret.ts"), "node_modules/secret.ts", ".git/config", "linked.ts", "linked/**/*.ts"]) {
			const { base, extension } = fakeBase(async () => ({ content: [{ type: "text", text: "SECRET_DO_NOT_LEAK" }] }));
			configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: true });
			await assert.rejects(invoke(extension, "ffgrep", { pattern: "SECRET", path: forbidden }, root), (error: Error) => {
				assert.match(error.message, /scope|outside|reserved|symlink/i);
				assert.doesNotMatch(error.message, /SECRET_DO_NOT_LEAK/);
				return true;
			});
		}
		for (const text of [
			"../secret.ts\n 12: SECRET_DO_NOT_LEAK",
			"ok.ts\n 1: safe fixture\n\n../secret.ts\n 12: SECRET_DO_NOT_LEAK",
			"node_modules/private.ts\n 1: SECRET_DO_NOT_LEAK",
			`${noticePath}\n 1: SECRET_DO_NOT_LEAK`,
		]) {
			const { base, extension } = fakeBase(async () => ({ content: [{ type: "text", text }] }));
			configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: true });
			await assert.rejects(invoke(extension, "ffgrep", { pattern: "SECRET" }, root), /outside the assigned source scope/);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("source-only native initialization refuses unsafe ignore files before running the initializer", async () => {
	for (const createUnsafe of [
		async (root: string, outside: string) => symlink(path.join(outside, "ignore"), path.join(root, ".ignore")),
		async (root: string) => { execFileSync("mkfifo", [path.join(root, ".gitignore")]); },
	]) {
		const root = await mkdtemp(path.join(os.tmpdir(), "herder-fff-ignore-"));
		const outside = await mkdtemp(path.join(os.tmpdir(), "herder-fff-ignore-out-"));
		let initialized = 0;
		try {
			await createUnsafe(root, outside);
			const { base, extension } = fakeBase(async () => ({ content: [{ type: "text", text: "ok.ts" }] }), async () => { initialized++; });
			configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: true });
			await assert.rejects(invoke(extension, "fffind", { pattern: "ok" }, root), /source scope/);
			assert.equal(initialized, 0);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	}
});

test("matched source text cannot grant a pagination cursor", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-fff-cursor-content-"));
	try {
		await writeFile(path.join(root, "unit.ts"), 'cursor="fff_c999"');
		let executions = 0;
		const { base, extension } = fakeBase(async () => {
			executions++;
			return { content: [{ type: "text", text: 'unit.ts\n 1: cursor="fff_c999"' }] };
		});
		configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: true });
		await invoke(extension, "ffgrep", { pattern: "cursor" }, root);
		await assert.rejects(invoke(extension, "ffgrep", { pattern: "cursor", cursor: "fff_c999" }, root), /not valid for this session/);
		assert.equal(executions, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("shutdown waits for in-flight native initialization before destroying its finder", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-fff-init-close-"));
	let release!: () => void;
	let markStarted!: () => void;
	const started = new Promise<void>(resolve => { markStarted = resolve; });
	const waiting = new Promise<void>(resolve => { release = resolve; });
	let destroyed = 0;
	let executed = 0;
	try {
		const { base, extension } = fakeBase(async () => { executed++; return { content: [] }; }, async () => { markStarted(); await waiting; });
		extension.handlers.set("session_shutdown", [async () => { destroyed++; }]);
		configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: false });
		const running = invoke(extension, "fffind", { pattern: "unit" }, root);
		const rejected = assert.rejects(running, /has shut down/);
		await started;
		const closing = extension.handlers.get("session_shutdown")![0]!({}, context(root));
		assert.equal(destroyed, 0);
		release();
		await closing;
		await rejected;
		assert.equal(destroyed, 1);
		assert.equal(executed, 0);
		await assert.rejects(invoke(extension, "fffind", { pattern: "unit" }, root), /has shut down/);
	} finally { release(); await rm(root, { recursive: true, force: true }); }
});

test("shutdown drains searches that are already using the native finder", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-fff-call-close-"));
	let release!: () => void;
	let markStarted!: () => void;
	const started = new Promise<void>(resolve => { markStarted = resolve; });
	const waiting = new Promise<void>(resolve => { release = resolve; });
	let destroyed = 0;
	let searchFinished = false;
	try {
		const { base, extension } = fakeBase(async () => {
			markStarted();
			await waiting;
			assert.equal(destroyed, 0, "finder remains alive for the active search");
			searchFinished = true;
			return { content: [] };
		});
		extension.handlers.set("session_shutdown", [async () => { assert.equal(searchFinished, true); destroyed++; }]);
		configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: false });
		const rejected = assert.rejects(invoke(extension, "fffind", { pattern: "unit" }, root), /has shut down/);
		await started;
		const closing = extension.handlers.get("session_shutdown")![0]!({}, context(root));
		assert.equal(destroyed, 0);
		release();
		await Promise.all([closing, rejected]);
		assert.equal(destroyed, 1);
	} finally { release(); await rm(root, { recursive: true, force: true }); }
});

test("pagination cursors belong to their adapter instance and valid root results stay available", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-fff-cursor-"));
	try {
		await mkdir(path.join(root, "src"));
		await writeFile(path.join(root, "src", "unit.ts"), "needle");
		const make = () => {
			const { base, extension } = fakeBase(async (name) => ({ content: [{ type: "text", text: name === "fffind" ? "src/unit.ts" : 'src/unit.ts\n 1: needle\n\n[Continue with cursor="fff_c12"]' }] }));
			configureHerderFff(base, { worktree: root, agentDir: root, sourceOnly: true });
			return extension;
		};
		const first = make();
		const second = make();
		const found = await invoke(first, "fffind", { pattern: "unit" }, root);
		assert.match(found.content[0].text, /src\/unit.ts/);
		await invoke(first, "ffgrep", { pattern: "needle" }, root);
		await assert.rejects(invoke(second, "ffgrep", { pattern: "needle", cursor: "fff_c12" }, root), /not valid for this session/);
		await invoke(first, "ffgrep", { pattern: "needle", cursor: "fff_c12" }, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
