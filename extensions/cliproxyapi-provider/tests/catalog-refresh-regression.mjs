#!/usr/bin/env node
// Node >=22.19.0: node tests/catalog-refresh-regression.mjs [path/to/lib.ts[.orig]]
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const libUrl = pathToFileURL(resolve(process.argv[2] ?? fileURLToPath(new URL("../src/lib.ts", import.meta.url)))).href;
// Load the actual source (including .orig) without node_modules TS restrictions.
// These helpers never need credentials; fail closed instead of loading the Pi runtime.
const hooks = registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { shortCircuit: true, url: "data:text/javascript,export function readStoredCredential(){throw new Error('Unexpected credential access')}" };
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url === libUrl) {
			return { shortCircuit: true, format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { sourceUrl: url }) };
		}
		return next(url, context);
	},
});

const root = mkdtempSync(join(tmpdir(), "catalog-refresh-regression-"));
const originalFetch = globalThis.fetch;
const baseUrl = "https://catalog-regression.invalid";
const apiKey = "fake-regression-key";
let respond = () => assert.fail("Unexpected model fetch");
let requests = [];
let passed = 0;
let failed = 0;
try {
	globalThis.fetch = async (url, options = {}) => {
		requests.push(String(url));
		if (String(url) === "https://models.dev/api.json") return Response.json({ test: { models: {} } });
		assert.equal(String(url), `${baseUrl}/v1/models?client_version=pi`);
		assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
		return respond(options.signal);
	};
	const { fetchCodexModels, resolveMappedModels, resolveEndpoints, toPiModel, loadModelsCache, saveModelsCache, MODELS_CACHE_FILE_NAME } = await import(libUrl);
	const modelsUrl = resolveEndpoints(baseUrl).modelsUrl;
	const replacement = [{ id: "new-model", display_name: "New model", service_tiers: ["fast"] }];
	const envelopes = [
		["array", (models) => models],
		["models", (models) => ({ models })],
		["data", (models) => ({ data: models })],
	];
	const bodyFailure = new TypeError("simulated body read failure");
	const bodyAbort = new DOMException("simulated body abort", "AbortError");
	const brokenBody = (error) => new Response(new ReadableStream({ pull(controller) { controller.error(error); } }));
	const invalid = [
		["truncated JSON", () => new Response('{"models":[{"id":"partial"}'), SyntaxError],
		["body read failure", () => brokenBody(bodyFailure), (error) => error === bodyFailure],
		["body abort", () => brokenBody(bodyAbort), (error) => error === bodyAbort],
		["unsupported envelope", () => Response.json({ unexpected: [] }), Error],
	];
	const empty = [
		...envelopes.map(([name, wrap]) => [`empty ${name}`, () => Response.json(wrap([]))]),
		["hidden-only catalog", () => Response.json([{ id: "hidden", visibility: "hide" }])],
	];
	function fixture(seed = true, endpoint = baseUrl) {
		const dir = mkdtempSync(join(root, "agent-"));
		const file = join(dir, MODELS_CACHE_FILE_NAME);
		if (seed) saveModelsCache(dir, {
			...resolveEndpoints(endpoint),
			models: [toPiModel({ id: "old-a" }), toPiModel({ id: "old-b" })],
			fastModelIds: [], fastMode: false,
		}, 1);
		return { dir, file, before: seed ? readFileSync(file) : undefined };
	}
	async function check(name, run) {
		requests = [];
		respond = () => assert.fail("Unexpected model fetch");
		try {
			await run();
			passed++;
		} catch (error) {
			failed++;
			console.error(`FAIL ${name}: ${error.message.split("\n")[0]}`);
		}
	}
	function assertSaved(dir, loaded) {
		const { fetchedAt, ...saved } = loadModelsCache(dir, baseUrl);
		assert.ok(fetchedAt > 1);
		assert.deepEqual(saved, JSON.parse(JSON.stringify(loaded)));
	}

	// Direct parsing errors must propagate, independently of the cache guard.
	for (const [name, response, expected] of invalid) await check(`fetch: ${name}`, async () => {
		respond = response;
		await assert.rejects(fetchCodexModels(modelsUrl, apiKey), expected);
		assert.equal(requests.length, 1);
	});

	// Both forced refresh and a fast-mode cache miss must preserve known-good bytes.
	for (const options of [
		{ forceRefresh: true },
		{ forceRefresh: true, fastMode: false },
		{ forceRefresh: true, fastMode: true },
		{ fastMode: true },
	]) for (const [name, response] of [...invalid, ...empty]) await check(`${name} ${JSON.stringify(options)}`, async () => {
		const { dir, file, before } = fixture();
		respond = response;
		const [result] = await Promise.allSettled([resolveMappedModels(dir, baseUrl, apiKey, options)]);
		assert.deepEqual(readFileSync(file), before, "populated cache bytes changed");
		assert.equal(result.status, "rejected", "refresh must reject, not return an empty catalog");
		assert.equal(requests.filter((url) => url === modelsUrl).length, 1);
	});

	// A smaller, nonempty catalog is legitimate, in every supported envelope.
	for (const [name, wrap] of envelopes) await check(`valid ${name} replaces cache`, async () => {
		const { dir, file, before } = fixture();
		respond = () => Response.json(wrap(replacement));
		assert.deepEqual(await fetchCodexModels(modelsUrl, apiKey), replacement);
		const { loaded, fromCache } = await resolveMappedModels(dir, baseUrl, apiKey, { forceRefresh: true });
		assert.equal(fromCache, false);
		assert.deepEqual(loaded.models.map((model) => model.id), ["new-model"]);
		assert.equal(loaded.models[0].name, "New model");
		assert.deepEqual(loaded.fastModelIds, ["new-model"]);
		assertSaved(dir, loaded);
		assert.notDeepEqual(readFileSync(file), before);
	});

	for (const fastMode of [undefined, false]) await check(`cache hit fastMode=${fastMode}`, async () => {
		const { dir, file, before } = fixture();
		const result = await resolveMappedModels(dir, baseUrl, apiKey, { fastMode });
		assert.equal(result.fromCache, true);
		assert.deepEqual(result.loaded, loadModelsCache(dir, baseUrl));
		assert.deepEqual(readFileSync(file), before);
		assert.deepEqual(requests, []);
	});

	for (const seed of [false, true]) for (const [name, response] of empty) await check(`${name}: ${seed ? "unmatched endpoint" : "initial setup"}`, async () => {
		const { dir } = fixture(seed, "https://other-catalog.invalid");
		assert.equal(loadModelsCache(dir, baseUrl), null);
		respond = response;
		const { loaded, fromCache } = await resolveMappedModels(dir, baseUrl, apiKey);
		assert.equal(fromCache, false);
		assert.deepEqual(loaded.models, []);
		assertSaved(dir, loaded);
	});

	for (const seed of [false, true]) for (const fence of ["shouldCommit", "signal"]) await check(`${fence} fence, populated=${seed}`, async () => {
		const { dir, file, before } = fixture(seed);
		const controller = new AbortController();
		let commit = true;
		respond = () => {
			if (fence === "signal") controller.abort();
			else commit = false;
			// Deliver a valid body despite abort to exercise the final write fence.
			return Response.json(replacement);
		};
		const { loaded, fromCache } = await resolveMappedModels(dir, baseUrl, apiKey, {
			forceRefresh: true, signal: controller.signal, shouldCommit: () => commit,
		});
		assert.equal(fromCache, false);
		assert.deepEqual(loaded.models.map((model) => model.id), ["new-model"]);
		if (seed) assert.deepEqual(readFileSync(file), before);
		else assert.equal(existsSync(file), false);
	});

	console.log(`${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed (${fileURLToPath(libUrl)})`);
	if (failed) process.exitCode = 1;
} finally {
	globalThis.fetch = originalFetch;
	hooks.deregister();
	rmSync(root, { recursive: true, force: true });
}
