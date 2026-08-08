import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = path.resolve(extensionRoot, "../..");

test("Herder is a self-contained Pi-only extension", () => {
	const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
	assert.ok(manifest.pi.extensions.includes("./extensions/herder/adapters/pi/index.ts"));
	assert.deepEqual(manifest.pi.skills.filter((entry: string) => entry.startsWith("./extensions/herder/")), [
		"./extensions/herder/skills/improve",
		"./extensions/herder/skills/grill",
		"./extensions/herder/skills/plans",
		"./extensions/herder/skills/validate",
	]);
	for (const directory of ["adapters/pi", "src/application", "src/core", "src/daemon", "src/client", "src/dashboard", "src/shared", "assets/roles/pi", "assets/roles/contracts", "assets/profiles", "skills", "tests"]) {
		assert.equal(existsSync(path.join(extensionRoot, directory)), true, directory);
	}
	for (const legacy of ["adapters/mcp", "agents", "assets/roles/codex", "assets/roles/claude", "src/core/profile-installer.ts", ".codex-plugin", ".claude-plugin", ".mcp.json"]) {
		assert.equal(existsSync(path.join(extensionRoot, legacy)), false, legacy);
	}
});

test("Pi and planning commands share one direct application facade", () => {
	const adapter = readFileSync(path.join(extensionRoot, "adapters/pi/index.ts"), "utf8");
	const planning = readFileSync(path.join(extensionRoot, "adapters/pi/lib/planning-workflows.ts"), "utf8");
	const application = readFileSync(path.join(extensionRoot, "src/application/tools.ts"), "utf8");
	assert.match(adapter, /src\/application\/tools\.ts/);
	assert.match(planning, /src\/application\/tools\.ts/);
	assert.doesNotMatch(adapter + planning + application, /adapters\/mcp|herder_wait|codex_terminal|herder_profile/);
	assert.match(application, /"herder_plan" \| "herder_run" \| "herder_submit"/);
});

test("runtime and profiles expose only Pi host behavior", () => {
	const protocol = readFileSync(path.join(extensionRoot, "src/shared/protocol.ts"), "utf8");
	const manager = readFileSync(path.join(extensionRoot, "src/core/run-manager.ts"), "utf8");
	const profiles = readFileSync(path.join(extensionRoot, "assets/profiles/profiles.json"), "utf8");
	assert.match(protocol, /HostName = "pi"/);
	assert.doesNotMatch(manager + profiles, /input\.host|roles\/claude|roles\/codex/);
	assert.match(manager, /assets.*roles.*contracts/);
});
