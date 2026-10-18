import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createMagpieSearchExtension, MAGPIE_SEARCH_SERVER } from "../../../adapters/magpie-search.ts";

test("explicit user MCP configuration wins over automatic registration and failures never bypass it", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-magpie-registration-"));
	const file = path.join(root, "mcp.json");
	const registered = { url: "https://registered.example/mcp", headers: { Authorization: "Bearer fixture" } };
	const configured = { url: "https://configured.example/mcp", headers: { Authorization: "Bearer other-fixture" } };
	let lookups = 0;
	const loader = () => new DefaultResourceLoader({
		cwd: root, agentDir: root, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [createMagpieSearchExtension(root, () => { lookups++; return registered; })],
	});
	try {
		for (const raw of [undefined, {}, { mcpServers: { unrelated: { command: "never-run" } } }]) {
			await rm(file, { force: true });
			if (raw) await writeFile(file, JSON.stringify(raw));
			const resources = loader();
			await resources.reload();
			assert.deepEqual(resources.getExtensions().errors, []);
			assert.deepEqual(resources.getExtensions().runtime.mcpServers.list().map(({ name, config }) => ({ name, config })), [{
				name: MAGPIE_SEARCH_SERVER,
				config: { ...registered, exposure: "hidden", toolExposure: { web_search: "direct", web_fetch: "direct" } },
			}]);
			if (raw) assert.equal(await readFile(file, "utf8"), JSON.stringify(raw));
			else await assert.rejects(() => readFile(file), { code: "ENOENT" });
		}
		assert.equal(lookups, 3);
		const contents = JSON.stringify({ mcpServers: { [MAGPIE_SEARCH_SERVER]: configured } });
		await writeFile(file, contents);
		const explicit = loader();
		await explicit.reload();
		assert.deepEqual(explicit.getExtensions().errors, []);
		assert.equal((explicit.getExtensions().runtime.mcpServers.list()[0]!.config as typeof configured).url, configured.url);
		assert.equal(await readFile(file, "utf8"), contents);
		assert.equal(lookups, 3, "explicit config must not consult the host registration");

		for (const raw of [
			'{"secret":"DO_NOT_PRINT', null, [], { mcpServers: [] },
			{ mcpServers: { magpie_web_search: { enabled: false } } },
			...[null, {}, { enabled: false }, { ...configured, enabled: false }, { command: "never-run" }]
				.map((selected) => ({ mcpServers: { [MAGPIE_SEARCH_SERVER]: selected } })),
		]) {
			const bytes = typeof raw === "string" ? raw : JSON.stringify(raw);
			await writeFile(file, bytes);
			const resources = loader();
			await resources.reload();
			assert.equal(resources.getExtensions().errors.length, 1);
			assert.doesNotMatch(JSON.stringify(resources.getExtensions().errors), /DO_NOT_PRINT/);
			assert.equal(resources.getExtensions().runtime.mcpServers.list().length, 0);
			assert.equal(await readFile(file, "utf8"), bytes);
			assert.equal(lookups, 3, "broken/disabled config must not fall back to the host");
		}
		await rm(file);
		await mkdir(file);
		const unreadable = loader();
		await unreadable.reload();
		assert.match(unreadable.getExtensions().errors[0]!.error, /cannot read valid user MCP JSON/);
		assert.equal(lookups, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
