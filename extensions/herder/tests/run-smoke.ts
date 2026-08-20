#!/usr/bin/env node

import { readdirSync, realpathSync, statSync } from "node:fs";
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
const testsRoot = realpathSync(path.join(extensionRoot, "tests"));
const focusedUsage = "Usage: npm run test:herder -- <test-file.test.ts> [...test-files]\n";

function isWithinDirectory(directory: string, candidate: string): boolean {
	const relative = path.relative(directory, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveFocusedFile(argument: string): string | undefined {
	const candidates = path.isAbsolute(argument)
		? [argument]
		: [
			path.resolve(process.cwd(), argument),
			path.resolve(repositoryRoot, argument),
			path.resolve(extensionRoot, argument),
		];
	const seen = new Set<string>();

	for (const candidate of candidates) {
		const absolute = path.resolve(candidate);
		if (seen.has(absolute)) continue;
		seen.add(absolute);

		try {
			const real = realpathSync(absolute);
			if (statSync(real).isFile() && real.endsWith(".test.ts") && isWithinDirectory(testsRoot, real)) {
				return real;
			}
		} catch {
			// Try the next supported base for a relative argument.
		}
	}

	return undefined;
}

function resolveFocusedFiles(argumentsList: string[]): { files: string[]; invalidArgument?: string } {
	const files: string[] = [];
	for (const argument of argumentsList) {
		const file = resolveFocusedFile(argument);
		if (file === undefined) return { files: [], invalidArgument: argument };
		files.push(file);
	}
	return { files };
}

function runFocusedTests(files: string[]): number {
	const args = ["--experimental-strip-types", "--test"];
	const integrationFiles = files.filter((file) => isWithinDirectory(realpathSync(integrationRoot), file));
	if (integrationFiles.length > 1) args.push("--test-concurrency=2");
	args.push(...files);

	process.stdout.write(`\n> ${path.basename(process.execPath)} ${args.join(" ")}\n`);
	const result = spawnSync(process.execPath, args, { cwd: extensionRoot, stdio: "inherit", env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) return result.status || 1;

	process.stdout.write("\nHerder Pi focused test run passed.\n");
	return 0;
}

const focusedArguments = process.argv.slice(2);
if (focusedArguments.length > 0) {
	const resolution = resolveFocusedFiles(focusedArguments);
	if (resolution.invalidArgument !== undefined) {
		process.stderr.write(`Invalid Herder test file: ${resolution.invalidArgument}\n${focusedUsage}`);
		process.exitCode = 1;
	} else {
		process.exitCode = runFocusedTests(resolution.files);
	}
} else {
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
}
