// Fresh Node process so imports cannot be rewritten to the worktree by Vitest.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [installed, cwd, binary, cacheRoot] = process.argv.slice(2);
const ext = path.join(installed, "extensions/impeccable");
// Use the SDK's TypeScript loader dependency, including non-erasable TS syntax.
const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const engine = await jiti.import(path.join(ext, "src/engine.ts"));
const resources = await jiti.import(path.join(ext, "src/resources.ts"));
assert.equal(engine.ENGINE_VERSION, "0.1.18");
assert.equal(resources.getSkillDir(), path.join(ext, "skills/impeccable"));
globalThis.fetch = () => { throw new Error("Offline relocation must never download"); };
const results = [];
for (const verb of ["context", "detect", "fail"]) {
	results.push(await engine.runEngine({
		binary, cacheRoot, cwd, argv: [verb, "--target", "surface with spaces", "$(literal)", "a;b", "$ARGUMENTS"],
		env: { PACKAGE_LITERAL: "literal $1 $(value); with spaces", IMPECCABLE_PROVIDER_ID: "foreign", IMPECCABLE_SKILL_DIR: "/wrong", IMPECCABLE_SELF: "/wrong" },
		stdin: JSON.stringify({ event: "package-relocation", literal: "$ARGUMENTS" }), timeoutMs: 10_000,
	}));
}
process.stdout.write(JSON.stringify(results) + "\n");
