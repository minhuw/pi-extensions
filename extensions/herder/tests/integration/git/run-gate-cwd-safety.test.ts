#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVerificationRequest, normalizeVerificationManifest } from "../../../src/core/verification.ts";
import { GitDriver, runCommand } from "../../../src/daemon/git-driver.ts";
import type { VerificationGate } from "../../../src/shared/protocol.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const helperRoot = path.resolve(scriptDir, "../../../src/daemon/git");
const linkType = process.platform === "win32" ? "junction" : "dir";

type Fixture = {
	root: string;
	repo: string;
	planDirectory: string;
	worktree: string;
	driver: GitDriver;
};

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-gate-cwd-safety-"));
	try {
		const repo = path.join(root, "repo");
		const planDirectory = path.join(repo, "herder-plans");
		fs.mkdirSync(planDirectory, { recursive: true });
		runCommand("git", ["init", "-q", repo]);
		const driver = new GitDriver({
			repoRoot: repo,
			planDirectory,
			planName: "cwd-safety",
			helperRoot,
		});
		const worktree = driver.integrationWorktree;
		fs.mkdirSync(worktree, { recursive: true });
		return { root, repo, planDirectory, worktree, driver };
	} catch (error) {
		fs.rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function normalizedGate(fixtureData: Fixture, cwd: string, argv: string[], gateId: string): VerificationGate {
	const request = createVerificationRequest({
		requestId: `request-${gateId}`,
		runId: `run-${gateId}`,
		generation: 1,
		graphSha256: "a".repeat(40),
		runAssignmentPath: path.join(fixtureData.planDirectory, "assignment.json"),
		runAssignmentSha256: "b".repeat(64),
		integrationBranch: "herder/cwd-safety/integration",
		integrationWorktree: fixtureData.worktree,
		integrationHead: "c".repeat(40),
		integrationTree: "d".repeat(40),
		requestedAt: "2026-08-10T00:00:00.000Z",
	});
	return normalizeVerificationManifest(request, {
		schemaVersion: 1,
		requestId: request.requestId,
		requestSha256: request.requestSha256,
		runId: request.runId,
		generation: request.generation,
		graphSha256: request.graphSha256,
		runAssignmentSha256: request.runAssignmentSha256,
		integrationHead: request.integrationHead,
		integrationTree: request.integrationTree,
		rationale: "The gate cwd is normalized against the frozen worktree.",
		gates: [{
			gateId,
			label: gateId,
			cwd,
			argv,
			timeoutMs: 5_000,
			rationale: "Exercises the final cwd containment check.",
		}],
	}).manifest.gates[0]!;
}

test("prepares locked npm dependencies transiently in the gate cwd", () => {
	const fixtureData = fixture();
	try {
		const packageRoot = path.join(fixtureData.worktree, "packages", "fixture");
		const dependency = path.join(packageRoot, "vendor", "fixture-dependency");
		fs.mkdirSync(dependency, { recursive: true });
		fs.writeFileSync(path.join(dependency, "package.json"), `${JSON.stringify({
			name: "fixture-dependency",
			version: "1.0.0",
			main: "index.js",
		}, null, 2)}\n`);
		fs.writeFileSync(path.join(dependency, "index.js"), "module.exports = 42;\n");
		fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({
			name: "verification-dependency-fixture",
			private: true,
			dependencies: { "fixture-dependency": "file:vendor/fixture-dependency" },
			scripts: { test: "node -e \"if (require('fixture-dependency') !== 42) process.exit(1)\"" },
		}, null, 2)}\n`);
		runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: packageRoot });
		const gate = normalizedGate(fixtureData, "packages/fixture", ["npm", "test"], "npm-dependencies");
		const [result] = fixtureData.driver.runVerificationGates("npm-dependencies", fixtureData.worktree, [gate]);
		assert.equal(result?.ok, true);
		assert.equal(fs.existsSync(path.join(packageRoot, "node_modules")), false, "Herder left transient dependencies in the frozen worktree");
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("dependency-free npm verification does not require node_modules", () => {
	const fixtureData = fixture();
	try {
		fs.writeFileSync(path.join(fixtureData.worktree, "package.json"), `${JSON.stringify({
			name: "verification-no-dependencies-fixture",
			private: true,
			scripts: { test: "node -e \"process.exit(0)\"" },
		}, null, 2)}\n`);
		const gate = normalizedGate(fixtureData, ".", ["npm", "test"], "npm-no-dependencies");
		const [result] = fixtureData.driver.runVerificationGates("npm-no-dependencies", fixtureData.worktree, [gate]);
		assert.equal(result?.ok, true);
		assert.equal(fs.existsSync(path.join(fixtureData.worktree, "node_modules")), false);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("failed dependency preparation removes partial node_modules", () => {
	const fixtureData = fixture();
	try {
		fs.writeFileSync(path.join(fixtureData.worktree, "package.json"), `${JSON.stringify({
			name: "verification-broken-lock-fixture",
			private: true,
			dependencies: { missing: "file:vendor/missing" },
			scripts: { test: "node -e \"process.exit(0)\"" },
		}, null, 2)}\n`);
		fs.writeFileSync(path.join(fixtureData.worktree, "package-lock.json"), `${JSON.stringify({
			name: "verification-broken-lock-fixture",
			lockfileVersion: 3,
			requires: true,
			packages: {
				"": { name: "verification-broken-lock-fixture", dependencies: { missing: "file:vendor/missing" } },
				"node_modules/missing": { resolved: "vendor/missing", link: true },
			},
		}, null, 2)}\n`);
		const gate = normalizedGate(fixtureData, ".", ["npm", "test"], "npm-broken-dependencies");
		assert.throws(() => fixtureData.driver.runVerificationGates("npm-broken-dependencies", fixtureData.worktree, [gate]), /Failed to prepare final verification dependencies/);
		assert.equal(fs.existsSync(path.join(fixtureData.worktree, "node_modules")), false);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("rejects cwd replaced by an external symlink after manifest normalization", () => {
	const fixtureData = fixture();
	try {
		const nested = path.join(fixtureData.worktree, "nested");
		const moved = path.join(fixtureData.worktree, "nested-original");
		const external = path.join(fixtureData.root, "external");
		const marker = path.join(external, "escaped-marker");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(external, { recursive: true });
		const gate = normalizedGate(fixtureData, "nested", [
			process.execPath,
			"-e",
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`,
		], "external-cwd");
		assert.equal(gate.cwd, "nested");

		fs.renameSync(nested, moved);
		fs.symlinkSync(external, nested, linkType);
		assert.throws(
			() => fixtureData.driver.runVerificationGates("external-replacement", fixtureData.worktree, [gate]),
			/cwd resolves outside the integration worktree/,
		);
		assert.equal(fs.existsSync(marker), false);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("runVerificationGates rejects lexical cwd escape", () => {
	const fixtureData = fixture();
	try {
		const gate = normalizedGate(fixtureData, ".", [process.execPath, "-e", "process.exit(0)"], "lexical-escape");
		gate.cwd = "../../external";
		assert.throws(() => fixtureData.driver.runVerificationGates("lexical-escape", fixtureData.worktree, [gate]), /cwd escapes the integration worktree/);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("npm dependency preparation rejects cwd replaced by an external symlink", () => {
	const fixtureData = fixture();
	try {
		const nested = path.join(fixtureData.worktree, "nested");
		const moved = path.join(fixtureData.worktree, "nested-original");
		const external = path.join(fixtureData.root, "external");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(external, { recursive: true });
		fs.writeFileSync(path.join(external, "package.json"), `${JSON.stringify({
			name: "external-package",
			private: true,
			dependencies: { missing: "file:vendor/missing" },
			scripts: { test: "node -e \"process.exit(0)\"" },
		}, null, 2)}\n`);
		fs.writeFileSync(path.join(external, "package-lock.json"), `${JSON.stringify({
			name: "external-package",
			lockfileVersion: 3,
			requires: true,
			packages: {
				"": { name: "external-package", dependencies: { missing: "file:vendor/missing" } },
				"node_modules/missing": { resolved: "vendor/missing", link: true },
			},
		}, null, 2)}\n`);
		const gate = normalizedGate(fixtureData, "nested", ["npm", "test"], "external-npm-cwd");
		fs.renameSync(nested, moved);
		fs.symlinkSync(external, nested, linkType);
		assert.throws(() => fixtureData.driver.runVerificationGates("external-npm-cwd", fixtureData.worktree, [gate]), /cwd resolves outside the integration worktree/);
		assert.equal(fs.existsSync(path.join(external, "node_modules")), false);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("allows an in-worktree symlink and spawns from its canonical target", () => {
	const fixtureData = fixture();
	try {
		const target = path.join(fixtureData.worktree, "canonical");
		const nested = path.join(fixtureData.worktree, "nested");
		fs.mkdirSync(target, { recursive: true });
		fs.mkdirSync(nested, { recursive: true });
		const gate = normalizedGate(fixtureData, "nested", [
			process.execPath,
			"-e",
			"process.stdout.write(process.cwd())",
		], "in-tree-cwd");
		assert.equal(gate.cwd, "nested");
		fs.rmSync(nested, { recursive: true, force: true });
		fs.symlinkSync(target, nested, linkType);
		const [result] = fixtureData.driver.runVerificationGates("in-tree-symlink", fixtureData.worktree, [gate]);

		assert.equal(result?.ok, true);
		assert.equal(fs.readFileSync(result!.logPath, "utf8"), fs.realpathSync(target));
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});
