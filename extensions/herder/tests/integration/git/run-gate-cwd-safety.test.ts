#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const GATE_LOG_LIMIT = 16_777_216;
const GATE_LOG_TRUNCATION_MARKER = "\n[herder] gate log truncated at 16777216 bytes\n";

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

function outputScript(stream: "stdout" | "stderr", totalBytes: number, byte: number): string {
	return `(() => { const chunk = Buffer.alloc(65536, ${byte}); let remaining = ${totalBytes}; while (remaining > 0) { const length = Math.min(remaining, chunk.length); process.${stream}.write(chunk.subarray(0, length)); remaining -= length; } })();`;
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

test("preserves under-limit gate output and evidence", () => {
	const fixtureData = fixture();
	try {
		const expected = Buffer.from("ordinary gate output\n");
		const gate = normalizedGate(fixtureData, ".", [
			process.execPath,
			"-e",
			`process.stdout.write(${JSON.stringify(expected.toString())})`,
		], "under-limit-output");
		const [result] = fixtureData.driver.runVerificationGates("under-limit-output", fixtureData.worktree, [gate]);
		const log = fs.readFileSync(result!.logPath);

		assert.equal(result?.ok, true);
		assert.equal(result?.logTruncated, false);
		assert.deepEqual(log, expected);
		assert.equal(result?.logBytes, expected.byteLength);
		assert.equal(result?.logSha256, createHash("sha256").update(expected).digest("hex"));
		assert.equal(fs.statSync(result!.logPath).mode & 0o777, 0o600);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("caps and drains oversized stdout while preserving normal exit", { timeout: 30_000 }, () => {
	const fixtureData = fixture();
	try {
		const gate = normalizedGate(fixtureData, ".", [
			process.execPath,
			"-e",
			outputScript("stdout", GATE_LOG_LIMIT + 4_096, 65),
		], "stdout-overflow");
		const [result] = fixtureData.driver.runVerificationGates("stdout-overflow", fixtureData.worktree, [gate]);
		const log = fs.readFileSync(result!.logPath);
		const marker = Buffer.from(GATE_LOG_TRUNCATION_MARKER);

		assert.equal(result?.ok, true);
		assert.equal(result?.exitCode, 0);
		assert.equal(result?.logTruncated, true);
		assert.equal(log.byteLength, GATE_LOG_LIMIT + marker.byteLength);
		assert.equal(log.subarray(0, GATE_LOG_LIMIT).equals(Buffer.alloc(GATE_LOG_LIMIT, 65)), true);
		assert.deepEqual(log.subarray(GATE_LOG_LIMIT), marker);
		assert.equal(log.indexOf(marker), GATE_LOG_LIMIT);
		assert.equal(log.lastIndexOf(marker), GATE_LOG_LIMIT);
		assert.equal(result?.logBytes, log.byteLength);
		assert.equal(result?.logSha256, createHash("sha256").update(log).digest("hex"));
		assert.equal(fs.statSync(result!.logPath).mode & 0o777, 0o600);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("caps mixed stdout and stderr against one shared limit", { timeout: 30_000 }, () => {
	const fixtureData = fixture();
	try {
		const gate = normalizedGate(fixtureData, ".", [
			process.execPath,
			"-e",
			`${outputScript("stdout", 9_000_000, 79)} ${outputScript("stderr", 9_000_000, 69)}`,
		], "mixed-overflow");
		const [result] = fixtureData.driver.runVerificationGates("mixed-overflow", fixtureData.worktree, [gate]);
		const log = fs.readFileSync(result!.logPath);
		const marker = Buffer.from(GATE_LOG_TRUNCATION_MARKER);

		assert.equal(result?.ok, true);
		assert.equal(result?.exitCode, 0);
		assert.equal(result?.logTruncated, true);
		assert.ok(log.byteLength <= GATE_LOG_LIMIT + marker.byteLength);
		assert.deepEqual(log.subarray(-marker.byteLength), marker);
		assert.equal(log.includes(79), true);
		assert.equal(log.includes(69), true);
		assert.equal(result?.logBytes, log.byteLength);
		assert.equal(result?.logSha256, createHash("sha256").update(log).digest("hex"));
		assert.equal(fs.statSync(result!.logPath).mode & 0o777, 0o600);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("preserves silent gate timeout failure behavior", { timeout: 15_000 }, () => {
	const fixtureData = fixture();
	try {
		const gate = normalizedGate(fixtureData, ".", [
			process.execPath,
			"-e",
			"setTimeout(() => {}, 10_000)",
		], "silent-timeout");
		gate.timeoutMs = 1_000;
		const [result] = fixtureData.driver.runVerificationGates("silent-timeout", fixtureData.worktree, [gate]);
		const log = fs.readFileSync(result!.logPath);

		assert.equal(result?.ok, false);
		assert.notEqual(result?.exitCode, 0);
		assert.equal(result?.logTruncated, false);
		assert.equal(log.byteLength, 0);
		assert.equal(result?.logBytes, 0);
		assert.equal(result?.logSha256, createHash("sha256").update(log).digest("hex"));
		assert.equal(fs.statSync(result!.logPath).mode & 0o777, 0o600);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("does not wait for detached descendants holding capture pipes", { skip: process.platform === "win32", timeout: 10_000 }, () => {
	const fixtureData = fixture();
	try {
		const expected = Buffer.from("direct gate output\n");
		const gate = normalizedGate(fixtureData, ".", [
			process.execPath,
			"-e",
			[
				"const { spawn } = require(\"node:child_process\");",
				`process.stdout.write(${JSON.stringify(expected.toString())});`,
				`const descendant = spawn(process.execPath, [\"-e\", ${JSON.stringify("setTimeout(() => {}, 4_500)")}], { detached: true, stdio: \"inherit\" });`,
				"descendant.unref();",
			].join(" "),
		], "detached-descendant");
		gate.timeoutMs = 1_000;
		const [result] = fixtureData.driver.runVerificationGates("detached-descendant", fixtureData.worktree, [gate]);
		const log = fs.readFileSync(result!.logPath);

		assert.equal(result?.ok, true);
		assert.equal(result?.exitCode, 0);
		assert.equal(log.toString(), expected.toString());
		assert.equal(result?.logBytes, expected.byteLength);
	} finally {
		fs.rmSync(fixtureData.root, { recursive: true, force: true });
	}
});

test("retains timeout escalation after the leader exits", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
	const fixtureData = fixture();
	let descendantPid: number | null = null;
	try {
		const pidPath = path.join(fixtureData.root, "same-group-descendant.pid");
		const survivorPath = path.join(fixtureData.root, "same-group-descendant-survived");
		const descendantScript = [
			"const fs = require(\"node:fs\");",
			"process.on(\"SIGTERM\", () => {});",
			`setTimeout(() => fs.writeFileSync(${JSON.stringify(survivorPath)}, \"survived\"), 8_000);`,
			"setTimeout(() => {}, 10_000);",
		].join(" ");
		const gate = normalizedGate(fixtureData, ".", [
			process.execPath,
			"-e",
			[
				"const fs = require(\"node:fs\");",
				"const { spawn } = require(\"node:child_process\");",
				`const descendant = spawn(process.execPath, [\"-e\", ${JSON.stringify(descendantScript)}], { detached: false, stdio: \"ignore\" });`,
				`fs.writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));`,
				"setTimeout(() => {}, 10_000);",
			].join(" "),
		], "same-group-timeout");
		gate.timeoutMs = 1_000;
		const startedAt = Date.now();
		const [result] = fixtureData.driver.runVerificationGates("same-group-timeout", fixtureData.worktree, [gate]);
		descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
		await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, 8_500 - (Date.now() - startedAt))));

		assert.equal(result?.ok, false);
		assert.ok(result!.durationMs < 5_000, `timeout finalization waited for hard-kill grace: ${result!.durationMs} ms`);
		assert.equal(fs.existsSync(survivorPath), false, "same-group descendant survived hard-kill escalation");
	} finally {
		if (descendantPid !== null && Number.isSafeInteger(descendantPid)) {
			try {
				process.kill(descendantPid, "SIGKILL");
			} catch {}
		}
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
