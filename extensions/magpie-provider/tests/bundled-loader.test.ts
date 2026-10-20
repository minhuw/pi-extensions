import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("loads the installed extension with Pi's actual bundled modules and no checkout dependencies", async () => {
	const root = mkdtempSync(join(tmpdir(), "magpie-bundled-"));
	try {
		const extensions = fileURLToPath(new URL("../../", import.meta.url));
		cpSync(join(extensions, "magpie-provider"), join(root, "extensions/magpie-provider"), { recursive: true });
		const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		// A separate Node process avoids Vitest's module mocks and resolution hooks.
		const result = await run(process.execPath, ["--input-type=module", "-e", String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [root, piDist] = process.argv.slice(1);
assert.equal(existsSync(join(root, "node_modules")), false);
assert.equal(existsSync(join(root, "extensions/magpie-provider/node_modules")), false);
const chunks = join(piDist, "bundle/chunks");
const virtualFile = readdirSync(chunks).find(name => name.startsWith("virtual-modules-") && name.endsWith(".js"));
assert.ok(virtualFile, "Installed Pi must expose its bundled virtual-module table for this compatibility check");
const { VIRTUAL_MODULES } = await import(pathToFileURL(join(chunks, virtualFile)).href);
const { createJiti } = createRequire(join(piDist, "index.js"))("jiti");
const filename = join(root, "extensions/magpie-provider/index.ts");
const jiti = createJiti(filename, { moduleCache: false, tryNative: false, virtualModules: VIRTUAL_MODULES });
const { createMagpieProvider, parseModels } = await jiti.import(filename);
const provider = createMagpieProvider({});
const context = VIRTUAL_MODULES["@earendil-works/pi-ai"].normalizeContext({
 messages: [{ role: "user", content: "hello", timestamp: 0 }],
});
let calls = [];
// Reject every request locally: no gateway, provider credits, or credentials.
globalThis.fetch = async (url, init) => {
 calls.push({ url: new URL(String(url)), headers: new Headers(init.headers) });
 return Response.json({ error: { message: "bundled fixture rejection" } }, { status: 400 });
};
for (const endpoint of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
 const [model] = parseModels({ data: [{ id: "fixture-model", native_endpoints: [endpoint] }] }, "https://gateway.example");
 for (const method of ["stream", "streamSimple"]) {
  calls = [];
  const response = await provider[method](model, context, { apiKey: "magpie-fixture" }).result();
  assert.equal(response.stopReason, "error");
  assert.match(response.errorMessage, /bundled fixture rejection/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, "https://gateway.example");
  assert.equal(calls[0].url.pathname, endpoint);
  const anthropic = endpoint === "/v1/messages";
  assert.equal(calls[0].headers.get(anthropic ? "x-api-key" : "authorization"),
   anthropic ? "magpie-fixture" : "Bearer magpie-fixture");
 }
}
console.log("All six bundled streaming routes passed");
`, root, piDist], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
		expect(result.stdout).toContain("All six bundled streaming routes passed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 40_000);
