#!/usr/bin/env node

import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(extensionRoot, "../..");

function filesBelow(directory: string, suffix: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(directory, entry.name);
		return entry.isDirectory() ? filesBelow(absolute, suffix) : entry.name.endsWith(suffix) ? [absolute] : [];
	}).sort();
}

const integrationRoot = path.join(extensionRoot, "tests/integration");
const legacyIntegration = filesBelow(integrationRoot, ".mjs");
if (legacyIntegration.length > 0) {
	process.stderr.write(`Legacy integration test files are not supported:\n${legacyIntegration.map((file) => path.relative(extensionRoot, file)).join("\n")}\n`);
	process.exit(1);
}

const typedIntegration = filesBelow(integrationRoot, ".test.ts");
const unit = filesBelow(path.join(extensionRoot, "tests/unit"), ".test.ts");
const checks: Array<[string, string[], string]> = [
	["npm", ["run", "typecheck"], repositoryRoot],
	[process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=2", ...typedIntegration], extensionRoot],
	[process.execPath, ["--experimental-strip-types", "--test", ...unit], extensionRoot],
];

for (const [command, args, cwd] of checks) {
	process.stdout.write(`\n> ${path.basename(command)} ${args.join(" ")}\n`);
	const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write("\nHerder Pi smoke suite passed.\n");
