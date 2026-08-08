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

const integrationScripts = [
	"tests/integration/profiles/profiles.test.mjs",
	"tests/integration/plans/plans.test.mjs",
	"tests/integration/git/fire-contract.test.mjs",
	"tests/integration/git/coordination-ref-test.mjs",
	"tests/integration/git/checkout-state-test.mjs",
	"tests/integration/git/namespace-test.mjs",
	"tests/integration/git/assignment-bundle-test.mjs",
	"tests/integration/git/branch-model-test.mjs",
	"tests/integration/git/cleanup-test.mjs",
	"tests/integration/dashboard/dashboard.test.mjs",
].map((file) => path.join(extensionRoot, file));

const typedIntegration = filesBelow(path.join(extensionRoot, "tests/integration"), ".test.ts");
const unit = filesBelow(path.join(extensionRoot, "tests/unit"), ".test.ts");
const checks: Array<[string, string[], string]> = [
	["npm", ["run", "typecheck"], repositoryRoot],
	...integrationScripts.map((file): [string, string[], string] => [process.execPath, [file], extensionRoot]),
	[process.execPath, ["--experimental-strip-types", "--test", ...typedIntegration], extensionRoot],
	[process.execPath, ["--experimental-strip-types", "--test", ...unit], extensionRoot],
];

for (const [command, args, cwd] of checks) {
	process.stdout.write(`\n> ${path.basename(command)} ${args.join(" ")}\n`);
	const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write("\nHerder Pi smoke suite passed.\n");
