import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getSkillDir } from "../src/resources.ts";
import { runEngine } from "../src/engine.ts";
import path from "node:path";
import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { runOperation } from "../src/operations.ts";
import { hookStatus, patchJson, readConfigs, resolveProject } from "../src/project.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

isolateEngineEnvironment();

it("patches only changed JSON values and refuses duplicate keys and malformed input", () => {
	expect(patchJson('{ "product" : {"keep":  1}, "hook" : { "enabled" : false } }\n', { product: { keep: 1 }, hook: { enabled: true } })).toBe('{ "product" : {"keep":  1}, "hook" : { "enabled" : true } }\n');
	expect(() => patchJson('{"hook":{},"hook":{}}', { hook: {} })).toThrow("Duplicate JSON key");
	expect(() => patchJson('{broken', {})).toThrow();
	expect(patchJson('{"a":1, "keep" : 2, "b":3}', { keep: 2 })).toBe('{"keep" : 2}');
	expect(patchJson('{"a":1}', { added: true })).toBe('{"added": true}');
});

it("serializes project controls, preserves unrelated config/manifests and resolves a nested app", async () => {
	const h = await detectorFixture();
	try {
		const app = path.join(h.directory, "apps/app one");
		await mkdir(path.join(app, "src"), { recursive: true });
		await writeFile(path.join(app, "package.json"), '{}');
		await h.config({ buildPath: "code", detector: { designSystem: { enabled: true } }, hook: { quiet: true } });
		await mkdir(path.join(h.directory, ".claude"));
		await writeFile(path.join(h.directory, ".claude/settings.json"), '{"unrelated":true}');
		expect(await resolveProject(h.directory, path.join(app, "src/new.tsx"))).toBe(app);
		const execute = (argv: string[], cwd = path.join(app, "src")) => runOperation({ argv, cwd }, h.api);
		const on = await execute(["hooks", "on"]);
		expect(on.integration).toMatchObject({ engineRun: false, root: app });
		expect(JSON.parse(on.stdout)).toMatchObject({ enabled: true });
		await Promise.all([execute(["hooks", "off"]), execute(["hook-admin", "on"])]);
		expect((await hookStatus(app)).enabled).toBe(true);
		expect((await hookStatus(h.directory)).enabled).toBe(false);
		await execute(["hooks", "reset"]);
		expect((await hookStatus(app)).enabled).toBe(false);
		expect(await readFile(path.join(h.directory, ".claude/settings.json"), "utf8")).toBe('{"unrelated":true}');
		expect(await readdir(app)).not.toContain(".pi");
		expect((await readConfigs(h.directory))[0]?.value).toMatchObject({ buildPath: "code", detector: { designSystem: { enabled: true } }, hook: { quiet: true } });
	} finally { await h.close(); }
});

it("stages upstream ignore validation, atomically keeps unrelated JSON formatting and preserves invalid config", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({});
		const file = path.join(h.directory, ".impeccable/config.json");
		await writeFile(file, '{ "buildPath" : "code", "detector": {"extensions": [{"ext":".twig"}]} }\n');
		const execute = (argv: string[]) => runOperation({ argv, cwd: h.directory }, h.api);
		const result = await execute(["hooks", "ignore-value", "overused-font", "Inter", "--file", "page.html", "--reason", "User confirmed"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("Upstream validation completed.\n");
		expect(result.integration).toMatchObject({ engineRun: true, committed: [file] });
		expect(await readFile(file, "utf8")).toContain('"buildPath" : "code"');
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ detector: { extensions: [{ ext: ".twig" }], ignoreValues: [{ rule: "overused-font", value: "Inter", files: ["page.html"], reason: "User confirmed" }] } });
		const before = await readFile(file, "utf8");
		expect((await execute(["ignores", "add-value", "invalid-value", "bad"])).ok).toBe(false);
		expect(await readFile(file, "utf8")).toBe(before);
		await execute(["ignores", "add-file", "page.html", "--local"]);
		expect((await readConfigs(h.directory))[1]?.value).toMatchObject({ detector: { ignoreFiles: ["page.html"] } });
		await writeFile(file, '{"broken":');
		expect((await execute(["hooks", "reset"])).ok).toBe(false);
		expect((await execute(["ignores", "clear"])).ok).toBe(false);
		expect(await readFile(file, "utf8")).toBe('{"broken":');
		expect((await readdir(path.dirname(file))).some((name) => name.startsWith("pi-admin-"))).toBe(false);
	} finally { await h.close(); }
});

it("keeps genuine doctor JSON alongside Pi metadata and routes runtime upgrades to the repository", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await runOperation({ argv: ["hooks", "on"], cwd: h.directory }, h.api);
		const result = await runOperation({ argv: ["doctor", "--json", "--fix"], cwd: h.directory }, h.api);
		expect(JSON.parse(result.stdout)).toMatchObject({ findings: [{ id: "product-missing" }], ruleRegistryAvailable: false });
		expect(result.integration).toMatchObject({ engineRun: true, hooks: { enabled: true, provider: "pi" } });
		for (const argv of [["update"], ["skills", "install"], ["link"]]) {
			const managed = await runOperation({ argv, cwd: h.directory }, h.api);
			expect(managed.integration?.engineRun).toBe(false);
			expect(JSON.parse(managed.stdout).managedBy).toBe("repository");
		}
		await writeFile(path.join(h.directory, ".impeccable/config.json"), '{"broken":');
		const malformed = await runOperation({ argv: ["doctor", "--json"], cwd: h.directory }, h.api);
		expect(malformed.integration).toMatchObject({ engineRun: true, hooks: { available: false } });
		expect(JSON.parse(malformed.stdout).findings[0].id).toBe("product-missing");
	} finally { await h.close(); }
});

it("pins native prompts without shadowing discovered commands and unpins only owned files", async () => {
	const h = await detectorFixture(undefined, [fileURLToPath(new URL("../../writer/prompts/polish.md", import.meta.url))]);
	try {
		const execute = (argv: string[]) => runOperation({ argv, cwd: h.directory }, h.api);
		expect(h.api.getCommands().some((command) => command.name === "polish")).toBe(true);
		expect((await execute(["pin", "pin", "polish"])).stderr).toContain("already belongs");
		expect((await execute(["pin", "pin", "craft"])).ok).toBe(true);
		const file = path.join(h.directory, ".pi/prompts/craft.md");
		expect(await readFile(file, "utf8")).toContain("pi-impeccable-owned-prompt:v1");
		expect((await execute(["unpin", "craft"])).ok).toBe(true);
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		await execute(["unpin", "craft"]);
		await writeFile(file, "User owned command");
		expect((await execute(["pin", "pin", "craft"])).ok).toBe(false);
		expect((await execute(["pin", "unpin", "craft"])).ok).toBe(false);
		expect(await readFile(file, "utf8")).toBe("User owned command");
		expect((await execute(["pin", "teach"])).ok).toBe(true);
		expect(await readFile(path.join(h.directory, ".pi/prompts/teach.md"), "utf8")).toContain("reference/init.md");
	} finally { await h.close(); }
});

it("discovers project pins after reload from a nested session cwd independently of the engine root", async () => {
	const h = await detectorFixture(undefined, [], { cwd: "apps/web app/src", promptDefaults: true });
	try {
		const app = path.join(h.directory, "apps/web app");
		const cwd = path.join(app, "src");
		await writeFile(path.join(app, "package.json"), '{}');
		const ancestorPrompt = path.join(app, ".pi/prompts/craft.md");
		await mkdir(path.dirname(ancestorPrompt), { recursive: true });
		await writeFile(ancestorPrompt, "User prompt outside the session's discovery scope");
		const enabled = await runOperation({ argv: ["hooks", "on"], cwd }, h.api);
		expect(enabled.integration?.root).toBe(app);
		expect((await hookStatus(app)).enabled).toBe(true);
		expect((await hookStatus(h.directory)).enabled).toBe(false);
		// A per-tool engine cwd override must not move the native prompt scope.
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("impeccable_run", { argv: ["pin", "pin", "craft", "--project"], cwd: app })]), fauxAssistantMessage("Pinned shortcut")]);
		await h.session.prompt("Pin the craft shortcut");
		const file = path.join(cwd, ".pi/prompts/craft.md");
		expect(await readFile(file, "utf8")).toContain("pi-impeccable-owned-prompt:v1");
		expect(h.api.getCommands().some((command) => command.name === "craft")).toBe(false);
		await h.session.reload();
		expect(h.api.getCommands().find((command) => command.name === "craft")).toMatchObject({ source: "prompt", sourceInfo: { path: file, scope: "project" } });
		let request = "";
		h.faux.setResponses([(context) => { request = JSON.stringify(context); return fauxAssistantMessage("Expanded the native shortcut"); }]);
		await h.session.prompt("/craft nested surface");
		expect(request).toContain("reference/craft.md");
		expect(request).toContain("nested surface");
		expect((await runOperation({ argv: ["pin", "pin", "craft"], cwd }, h.api)).ok).toBe(true);
		expect((await runOperation({ argv: ["pin", "unpin", "craft"], cwd }, h.api)).ok).toBe(true);
		await h.session.reload();
		expect(h.api.getCommands().some((command) => command.name === "craft")).toBe(false);
		expect(await readFile(ancestorPrompt, "utf8")).toBe("User prompt outside the session's discovery scope");
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("is disabled by default, then enables through the real Pi tool and reports a successful native write", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "<main>disabled</main>" })]), fauxAssistantMessage("Done")]);
		await h.session.prompt("Edit with default settings");
		expect(await h.calls()).toEqual([]);
		expect(h.feedback()).toHaveLength(0);
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_run", { argv: ["hooks", "on"] })]),
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "<main>enabled</main>" })]),
			fauxAssistantMessage("Ready"), fauxAssistantMessage("Bounded correction assessment"),
		]);
		await h.session.prompt("Enable checks and edit");
		expect(h.errors).toEqual([]);
		const calls = await h.calls();
		expect(calls.map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "Stop"]);
		expect(calls[0].event.tool_response).toMatchObject({ originalFile: "<main>disabled</main>", content: "<main>enabled</main>", userModified: false });
		expect(calls[0].env.provider).toBe("pi");
		expect(h.feedback()).toHaveLength(2);
		expect(h.faux.getPendingResponseCount()).toBe(0);
		const state = await readdir(path.join(h.directory, ".impeccable"));
		expect(state.some((name) => name.startsWith("pi-hook-"))).toBe(false);
		const temporary = path.dirname(calls[0].env.cache);
		expect(path.relative(h.directory, temporary).startsWith("..")).toBe(true);
		expect(await readdir(temporary)).toContain("audit.ndjson");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await expect(readdir(temporary)).rejects.toMatchObject({ code: "ENOENT" });
	} finally { expect((await h.close()).some((name) => name.startsWith("pi-hook-"))).toBe(false); }
});

it("observes actual nested edit events, skips failed/no-op/preview edits, and deduplicates unchanged content", async () => {
	let structured: unknown;
	const h = await detectorFixture((pi) => {
		pi.registerTool({ name: "nested_edit", label: "Nested edit", description: "Exercise SDK nesting", parameters: Type.Object({}), outputSchema: Type.Object({ retained: Type.String() }), async execute(_id, _args, _signal, _update, ctx) { const result = await ctx.executeTool("edit", { path: "page.html", edits: [{ oldText: "before", newText: "after" }] }); return { ...result.result, structuredContent: { retained: "original structured result" } }; } });
		pi.on("tool_result", (event) => { if (event.toolName === "nested_edit") structured = event.structuredContent; });
	});
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true } });
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: "page.html", edits: [{ oldText: "missing", newText: "bad" }] })]),
			fauxAssistantMessage([fauxToolCall("nested_edit", {})]),
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "<main>after</main>" })]),
			fauxAssistantMessage([fauxToolCall("write", { path: "preview.html", content: '<main data-impeccable-variants="x">preview</main>' })]),
			fauxAssistantMessage("Done"), fauxAssistantMessage("Done with bounded deep feedback"),
		]);
		await h.session.prompt("Make bounded edits");
		expect(h.errors).toEqual([]);
		const calls = await h.calls();
		expect(calls.map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "Stop"]);
		expect(calls[0].event.tool_response).toMatchObject({ originalFile: "<main>before</main>", userModified: false });
		expect(calls[0].event.tool_input.file_path).toBe(path.join(h.directory, "page.html"));
		expect(structured).toEqual({ retained: "original structured result" });
	} finally { await h.close(); }
});

it.each(["ios", "android", "adaptive"])("reports native %s as inapplicable without a corrective continuation", async (platform) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true } });
		await writeFile(path.join(h.directory, "PRODUCT.md"), `# Product\n\n## Platform\n${platform}\n`);
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "<main>native</main>" })]), fauxAssistantMessage("Done")]);
		await h.session.prompt("Edit native fixture");
		expect(h.faux.state.callCount).toBe(2);
		expect(JSON.stringify(h.feedback())).toContain("inapplicable");
		expect(JSON.stringify(h.feedback())).not.toContain('"status":"success"');
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("honors ignore/off/reset and never starts another correction loop", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true }, detector: { ignoreFiles: ["page.html"] }, buildPath: "code" });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "ignored" })]), fauxAssistantMessage("Done")]);
		await h.session.prompt("Ignored edit");
		expect(JSON.stringify(h.feedback())).not.toContain("Fixture immediate finding");
		await runOperation({ argv: ["hooks", "off"], cwd: h.directory }, h.api);
		const count = (await h.calls()).length;
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "off" })]), fauxAssistantMessage("Done")]);
		await h.session.prompt("Disabled edit");
		expect(await h.calls()).toHaveLength(count);
		await runOperation({ argv: ["hooks", "reset"], cwd: h.directory }, h.api);
		expect((await hookStatus(h.directory)).enabled).toBe(false);
		expect((await readConfigs(h.directory))[0]?.value.buildPath).toBe("code");
	} finally { await h.close(); }
});

it("cancels a delayed scan on user abort and cleans up idempotently", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true }, delay: 5000 });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "delayed" })]), fauxAssistantMessage("Unreachable feedback")]);
		const run = h.session.prompt("Edit then abort");
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 3000;
			const check = async () => { if ((await h.calls()).length) { resolve(); return; } if (Date.now() > deadline) { reject(new Error("Hook did not start")); return; } setTimeout(() => { void check(); }, 10); }; void check();
		});
		await h.session.abort(); await run;
		expect(h.feedback()).toHaveLength(0);
		expect(await h.calls()).toHaveLength(1);
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect((await readdir(path.join(h.directory, ".impeccable"))).some((name) => name.startsWith("pi-hook-"))).toBe(false);
	} finally { await h.close(); }
});

it("retains Pi provider identity through managed env overrides and a relocated fallback launcher", async () => {
	const h = await detectorFixture();
	try {
		const managed = await runEngine({ argv: ["context", "literal $(value); spaces"], cwd: h.directory, binary: h.binary, env: { IMPECCABLE_PROVIDER_ID: "codex" } });
		expect(JSON.parse(managed.stdout)).toEqual({ args: ["context", "literal $(value); spaces"], provider: "pi" });
		const relocated = path.join(h.directory, "relocated skill");
		await cp(getSkillDir(), relocated, { recursive: true });
		const result = await promisify(execFile)(path.join(relocated, "scripts/impeccable"), ["context"], { cwd: h.directory, env: { ...process.env, IMPECCABLE_BIN: h.binary, IMPECCABLE_PROVIDER_ID: "codex" } });
		expect(JSON.parse(result.stdout).provider).toBe("pi");
	} finally { await h.close(); }
});

it("isolates detector state and feedback between actual Pi sessions", async () => {
	const first = await detectorFixture(); const second = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = first.binary;
		await first.config({ hook: { enabled: true } }); await second.config({ hook: { enabled: true } });
		for (const h of [first, second]) h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "changed" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed")]);
		await Promise.all([first.session.prompt("First session"), second.session.prompt("Second session")]);
		const left = await first.calls(); const right = await second.calls();
		expect(left).toHaveLength(2); expect(right).toHaveLength(2);
		expect(left[0].event.session_id).not.toBe(right[0].event.session_id);
		expect(left[0].env.cache).not.toBe(right[0].env.cache);
		expect(first.feedback()).toHaveLength(2); expect(second.feedback()).toHaveLength(2);
		expect(first.errors).toEqual([]); expect(second.errors).toEqual([]);
	} finally { await first.close(); await second.close(); }
});

it.each(["apps/*", "./apps/*", "apps/*/", " './apps/*/' "])("scans only a nested app's successful edit and honors explicit non-package projectRoots: %s", async (pattern) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ projectRoots: [pattern] });
		const app = path.join(h.directory, "apps/web app");
		await mkdir(path.join(app, "src"), { recursive: true });
		await mkdir(path.join(h.directory, "apps/other"));
		expect((await runOperation({ argv: ["hooks", "on", "--target", app], cwd: h.directory }, h.api)).integration?.root).toBe(app);
		expect((await hookStatus(h.directory)).enabled).toBe(false);
		expect((await hookStatus(app)).enabled).toBe(true);
		expect(await resolveProject(h.directory, path.join(app, "src/card.tsx"))).toBe(app);
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "apps/web app/src/card.tsx", content: "export const Card = () => <main/>;" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed")]);
		await h.session.prompt("Edit just the focused app");
		const calls = JSON.parse((await readFile(path.join(app, "calls.ndjson"), "utf8")).split('\n')[0]!);
		expect(calls.cwd).toBe(app); expect(calls.event.tool_input.file_path).toBe(path.join(app, "src/card.tsx"));
		expect(await h.calls()).toEqual([]);
		expect(await readdir(path.join(h.directory, "apps/other"))).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it.each(["!apps/other/", "!./apps/other/", " './!apps/other/' "])("normalizes workspace exclusions before resolving app scope: %s", async (exclusion) => {
	const h = await detectorFixture();
	try {
		await h.config({ projectRoots: ["./apps/*/", exclusion] });
		const app = path.join(h.directory, "apps/other");
		await mkdir(path.join(app, "src"), { recursive: true });
		expect(await resolveProject(h.directory, path.join(app, "src/page.tsx"))).toBe(h.directory);
	} finally { await h.close(); }
});

it.each([false, true])("keeps fresh local ignores private with checks disabled (separate Git dir: %s)", async (separate) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		const git = (args: string[]) => promisify(execFile)("git", args, { cwd: h.directory });
		await git(separate ? ["init", "--separate-git-dir", path.join(h.directory, "git metadata")] : ["init"]);
		const exclude = path.resolve(h.directory, (await git(["rev-parse", "--git-path", "info/exclude"])).stdout.trim());
		const original = "# User excludes\nprivate-user-file\n";
		await writeFile(exclude, original);
		await h.config({ projectRoots: ["./apps/*/"] });
		const app = path.join(h.directory, "apps/web [one]");
		await mkdir(app, { recursive: true });
		const execute = () => runOperation({ argv: ["ignores", "add-file", "page.html", "--local", "--target", app], cwd: h.directory }, h.api);
		expect((await execute()).ok).toBe(true);
		const text = await readFile(exclude, "utf8");
		expect(text.startsWith(original)).toBe(true);
		expect(text).toContain("/apps/web \\[one\\]/.impeccable/config.local.json\n");
		expect((await git(["check-ignore", "--no-index", "apps/web [one]/.impeccable/config.local.json"])).stdout.trim()).toBe("apps/web [one]/.impeccable/config.local.json");
		expect((await hookStatus(app)).enabled).toBe(false);
		expect((await hookStatus(h.directory)).enabled).toBe(false);
		expect((await execute()).ok).toBe(true);
		expect(await readFile(exclude, "utf8")).toBe(text);
		expect((await readConfigs(app))[1]?.value).toMatchObject({ detector: { ignoreFiles: ["page.html", "page.html"] } });
		expect(await h.calls()).toEqual([]);
	} finally { await h.close(); }
});

it("supports native user-scope prompts, refuses symlinks and reports missing command discovery", async () => {
	const h = await detectorFixture();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(h.directory, "private agent");
		const execute = (argv: string[]) => runOperation({ argv, cwd: h.directory }, h.api);
		expect((await execute(["pin", "pin", "layout", "--user"])).ok).toBe(true);
		const file = path.join(process.env.PI_CODING_AGENT_DIR, "prompts/layout.md");
		expect(await readFile(file, "utf8")).toContain("reference/layout.md");
		await execute(["pin", "unpin", "layout", "--user"]);
		await symlink(path.join(h.directory, "page.html"), file);
		expect((await execute(["pin", "pin", "layout", "--user"])).stderr).toContain("not a regular owned prompt");
		expect((await execute(["pin", "unpin", "layout", "--user"])).ok).toBe(false);
		const unavailable = await runOperation({ argv: ["pin", "pin", "layout"], cwd: h.directory }, {} as Parameters<typeof runOperation>[1]);
		expect(unavailable.stderr).toContain("cannot establish command collision safety");
	} finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await h.close(); }
});

it("expands /i through actual public prompt discovery without claiming another command", async () => {
	const h = await detectorFixture(undefined, [fileURLToPath(new URL("../prompts/impeccable.md", import.meta.url))]);
	try {
		let request = "";
		h.faux.setResponses([(context) => { request = JSON.stringify(context); return fauxAssistantMessage("Routed the compatibility prompt"); }]);
		await h.session.prompt("/i teach");
		expect(request).toContain("Use the Impeccable design skill");
		expect(request).toContain("teach");
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("caps correction at one continuation even when changed content yields fresh deep feedback", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary; await h.config({ hook: { enabled: true } });
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "first" })]), fauxAssistantMessage("Initial answer"),
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "second" })]), fauxAssistantMessage("Correction assessment"),
			fauxAssistantMessage("Forbidden second automatic continuation"),
		]);
		await h.session.prompt("Edit with a bounded corrective opportunity");
		expect(h.faux.state.callCount).toBe(4);
		expect(h.faux.getPendingResponseCount()).toBe(1);
		expect((await h.calls()).map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "Stop", "PostToolUse", "Stop"]);
		expect(h.feedback()).toHaveLength(3);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("honors local consent/enablement and legacy disabled/quiet/log overrides", async () => {
	const h = await detectorFixture();
	const names = ["IMPECCABLE_HOOK_DISABLED", "IMPECCABLE_HOOK_QUIET", "IMPECCABLE_HOOK_LOG"];
	const previous = names.map((name) => process.env[name]);
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true }, fixtureClean: true });
		const local = path.join(h.directory, ".impeccable/config.local.json");
		await writeFile(local, '{"hook":{"consent":"declined"}}');
		expect((await hookStatus(h.directory)).enabled).toBe(false);
		await writeFile(local, '{"hook":{"enabled":false,"consent":"accepted"}}');
		expect((await hookStatus(h.directory)).enabled).toBe(false);
		await writeFile(local, '{"hook":{"consent":"accepted"}}');
		process.env.IMPECCABLE_HOOK_DISABLED = "yes";
		expect((await hookStatus(h.directory)).enabled).toBe(false);
		delete process.env.IMPECCABLE_HOOK_DISABLED;
		process.env.IMPECCABLE_HOOK_QUIET = "on";
		process.env.IMPECCABLE_HOOK_LOG = "audit with spaces.ndjson";
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "clean" })]), fauxAssistantMessage("Done")]);
		await h.session.prompt("Quiet clean fixture");
		expect(h.feedback()).toHaveLength(0);
		expect((await readFile(path.join(h.directory, "audit with spaces.ndjson"), "utf8")).trim().split('\n').map((line) => JSON.parse(line).event)).toEqual(["PostToolUse", "Stop"]);
		expect(h.errors).toEqual([]);
	} finally { names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); await h.close(); }
});

