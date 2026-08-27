import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = path.resolve(extensionRoot, "../..");

test("Plans core is import-only and not a standalone CLI", () => {
	const sourcePath = path.join(extensionRoot, "src/core/plans.ts");
	const source = readFileSync(sourcePath, "utf8");
	assert.doesNotMatch(source, /^#!/m);
	assert.doesNotMatch(source, /fileURLToPath|const isMain|function takeFlag|function main\(argv|process\.(stdout|stderr|exitCode)/);
	assert.doesNotMatch(source, /herder-plans (record-usage|bind-profile|profile|usage)/);
	assert.equal(statSync(sourcePath).mode & 0o777, 0o644);
});

test("internal profile and Git helpers are import-only", () => {
	const importOnly = [
		"src/core/profile-registry.ts",
		"src/daemon/git/assignment-bundle.ts",
		"src/daemon/git/checkout-state.ts",
		"src/daemon/git/cleanup-run.ts",
		"src/daemon/git/coordination-ref.ts",
		"src/daemon/git/namespace-run.ts",
		"src/daemon/git/round-policy.ts",
	];
	const retainedEntrypoints = [
		"src/daemon/service.ts",
		"src/dashboard/herder-dashboard.ts",
		"src/daemon/git/run-gate.ts",
	];
	const importOnlyForbiddenPattern = /runCli|parseArguments|parseArgs|function main\(|export function main|const (?:isMain|isEntrypoint|invokedAsScript)|process\.(?:argv|stdout|stderr|exitCode)|process\.exit\s*\(|console\.(?:log|info|warn|error|debug)\s*\(|\bpretty\b/;
	assert.match("process.exit(1)", importOnlyForbiddenPattern);
	assert.match('console.error("failure")', importOnlyForbiddenPattern);
	for (const relative of retainedEntrypoints) assert.equal(existsSync(path.join(extensionRoot, relative)), true, relative);
	for (const relative of importOnly) {
		const sourcePath = path.join(extensionRoot, relative);
		const source = readFileSync(sourcePath, "utf8");
		assert.doesNotMatch(source, /^#!/m);
		assert.doesNotMatch(source, importOnlyForbiddenPattern);
		assert.equal(statSync(sourcePath).mode & 0o777, 0o644, relative);
	}
});
test("Herder is a self-contained Pi-only extension", () => {
	const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
	assert.ok(manifest.pi.extensions.includes("./extensions/herder/adapters/index.ts"));
	assert.equal(Object.hasOwn(manifest.pi, "skills"), false);
	for (const directory of ["adapters", "src/application", "src/core", "src/daemon", "src/client", "src/dashboard", "src/shared", "assets/roles/pi", "assets/roles/pi/nested", "assets/roles/contracts", "assets/review", "assets/profiles", "skills", "tests"]) {
		assert.equal(existsSync(path.join(extensionRoot, directory)), true, directory);
	}
	for (const legacy of ["adapters/mcp", "agents", "assets/roles/codex", "assets/roles/claude", "src/core/profile-installer.ts", ".codex-plugin", ".claude-plugin", ".mcp.json"]) {
		assert.equal(existsSync(path.join(extensionRoot, legacy)), false, legacy);
	}
});

test("Pi and planning commands share one direct application facade", () => {
	const adapter = readFileSync(path.join(extensionRoot, "adapters/index.ts"), "utf8");
	const planning = readFileSync(path.join(extensionRoot, "adapters/planning-workflows.ts"), "utf8");
	const application = readFileSync(path.join(extensionRoot, "src/application/tools.ts"), "utf8");
	assert.match(adapter, /src\/application\/tools\.ts/);
	assert.match(planning, /src\/application\/tools\.ts/);
	assert.doesNotMatch(adapter + planning + application, /adapters\/mcp|herder_wait|codex_terminal|herder_profile/);
	assert.equal((application.match(/export function invokeHerderTool/g) ?? []).length, 1);
	assert.match(application, /export function invokeHerderTool\(name: "herder_plan" \| "herder_run" \| "herder_submit" \| "herder_verification" \| "herder_integration_repair" \| "herder_reignite", args: JsonObject\)/);
	assert.match(application, /if \(name === "herder_verification"\) return verificationTool\(args\);/);
	assert.match(application, /if \(name === "herder_integration_repair"\) return integrationRepairTool\(args\);/);
	const verificationBody = application.match(/async function verificationTool\([\s\S]*?\n}\n\nasync function integrationRepairTool/)?.[0] ?? "";
	assert.notEqual(verificationBody, "");
	assert.doesNotMatch(verificationBody, /args\.(?:operation|repairOperation)|integrationRepairPayload|"integration_repair"/);
	assert.match(application, /submitHerderVerification/);
});

test("runtime and profiles expose only Pi host behavior", () => {
	const protocol = readFileSync(path.join(extensionRoot, "src/shared/protocol.ts"), "utf8");
	const manager = readFileSync(path.join(extensionRoot, "src/core/run-manager.ts"), "utf8");
	const profiles = readFileSync(path.join(extensionRoot, "assets/profiles/profiles.json"), "utf8");
	assert.match(protocol, /HostName = "pi"/);
	assert.doesNotMatch(manager + profiles, /input\.host|roles\/claude|roles\/codex/);
	assert.match(manager, /assets.*roles.*contracts/);
	assert.match(manager, /assets.*review.*code-review-protocol/);
	assert.doesNotMatch(manager, /extractGateCommands|runGates\(/);
});
