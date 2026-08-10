import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { recordUsageRecord } from "../../../src/daemon/execution-store.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { collectLiveArtifacts } from "../../e2e/support/collect-live-artifacts.ts";

const SERVICE_TOKEN_MARKER = "[REDACTED:HERDER_SERVICE_AUTH_TOKEN]";

function createServiceDatabase(planDirectory: string, serviceToken: string, providerSecret?: string): void {
	const store = new RunStore(planDirectory);
	try {
		store.putService({
			instanceId: "fixture-instance",
			pid: process.pid,
			port: 43123,
			authToken: serviceToken,
			dashboardUrl: "http://127.0.0.1:43123",
			forwardedUrl: null,
			startedAt: "2026-08-10T00:00:00.000Z",
		});
	} finally {
		store.close();
	}
	recordUsageRecord(planDirectory, {
		attempt: "fixture-attempt",
		plan: "014",
		role: "plan-implementer",
		model: providerSecret || "Provider/synthetic",
		effort: "max",
		outcome: "complete",
		inputTokens: 12,
		cachedInputTokens: 3,
		outputTokens: 34,
		reasoningTokens: 5,
		source: providerSecret || "fixture-provider",
		round: 1,
		generation: "generation-1",
		harness: "synthetic",
		serviceTier: "test",
	});
}

function readFiles(root: string): Buffer[] {
	const files: Buffer[] = [];
	for (const entry of fs.readdirSync(root)) {
		const file = path.join(root, entry);
		const status = fs.lstatSync(file);
		if (status.isDirectory()) files.push(...readFiles(file));
		else if (status.isFile()) files.push(fs.readFileSync(file));
	}
	return files;
}

test("live artifacts preserve diagnostics while structurally sanitizing execution databases", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-artifact-test-"));
	try {
		const tmpRoot = path.join(root, "tmp");
		const workspace = path.join(tmpRoot, "herder-pi-live-example");
		const planDirectory = path.join(workspace, "repository", "herder-plans");
		const runtime = path.join(planDirectory, ".herder");
		const output = path.join(root, "output");
		const serviceToken = "synthetic-service-credential";
		const key = "test-secret-key-value";
		const base = "https://proxy.example.invalid";
		fs.mkdirSync(workspace, { recursive: true });
		createServiceDatabase(planDirectory, serviceToken, key);
		fs.writeFileSync(path.join(workspace, "pi.log"), `\u001b[32mProvider=synthetic key=${key} endpoint=${base}/v1 service=${serviceToken}\u001b[0m\n`);
		fs.writeFileSync(path.join(runtime, "execution.sqlite3-wal"), Buffer.from([0, 1, 2, 3]));
		fs.writeFileSync(path.join(runtime, "execution.sqlite3-shm"), Buffer.from([4, 5, 6, 7]));
		fs.writeFileSync(path.join(runtime, "unknown.bin"), Buffer.from([0, 255, 1, 2]));
		fs.symlinkSync("../pi.log", path.join(runtime, "trajectory-link"));

		const report = await collectLiveArtifacts({
			host: "pi",
			output,
			tmpRoot,
			environment: { CLIPROXY_API_KEY: key, CLIPROXY_BASE_URL: base },
		});
		const copied = path.join(output, "fixtures", path.basename(workspace));
		const trajectory = fs.readFileSync(path.join(copied, "pi.log"), "utf8");
		assert.doesNotMatch(trajectory, new RegExp(key));
		assert.doesNotMatch(trajectory, new RegExp(serviceToken));
		assert.doesNotMatch(trajectory, /proxy\.example\.invalid/);
		assert.match(trajectory, /\u001b\[32m/);
		assert.match(trajectory, /\[REDACTED:CLIPROXY_API_KEY\]/);
		assert.match(trajectory, /\[REDACTED:CLIPROXY_BASE_URL\]/);
		assert.match(trajectory, new RegExp(`\\[REDACTED:${SERVICE_TOKEN_MARKER.slice(10, -1)}\\]`));

		const copiedDatabasePath = path.join(copied, "repository", "herder-plans", ".herder", "execution.sqlite3");
		const copiedDatabase = new DatabaseSync(copiedDatabasePath, { readOnly: true });
		try {
			assert.equal((copiedDatabase.prepare("PRAGMA quick_check").get() as Record<string, unknown>).quick_check, "ok");
			assert.equal(copiedDatabase.prepare("SELECT auth_token FROM manager_service WHERE singleton = 1").get()?.auth_token, SERVICE_TOKEN_MARKER);
			assert.deepEqual({ ...(copiedDatabase.prepare("SELECT plan_id, model, source, input_tokens, output_tokens FROM attempts").get() as Record<string, unknown>) }, {
				plan_id: "014",
				model: "[REDACTED:CLIPROXY_API_KEY]",
				source: "[REDACTED:CLIPROXY_API_KEY]",
				input_tokens: 12,
				output_tokens: 34,
			});
		} finally {
			copiedDatabase.close();
		}

		const outputBytes = readFiles(output);
		assert.equal(outputBytes.some((bytes) => bytes.includes(Buffer.from(serviceToken))), false);
		assert.equal(outputBytes.some((bytes) => bytes.includes(Buffer.from(key))), false);
		assert.equal(fs.existsSync(path.join(copied, "repository", "herder-plans", ".herder", "execution.sqlite3-wal")), false);
		assert.equal(fs.existsSync(path.join(copied, "repository", "herder-plans", ".herder", "execution.sqlite3-shm")), false);
		assert.equal(fs.existsSync(path.join(copied, "repository", "herder-plans", ".herder", "unknown.bin")), false);
		assert.equal(fs.existsSync(path.join(copied, "repository", "herder-plans", ".herder", "trajectory-link")), false);
		assert.equal(report.redactedOccurrences.CLIPROXY_API_KEY, 1);
		assert.equal(report.redactedOccurrences.CLIPROXY_BASE_URL, 1);
		assert.equal(report.redactedOccurrences.HERDER_SERVICE_AUTH_TOKEN, 1);
		assert.equal(report.omittedSensitiveFiles.includes(path.join(workspace, "pi.log")), false);
		assert.ok(report.omittedSensitiveFiles.includes(path.join(runtime, "execution.sqlite3-wal")));
		assert.ok(report.omittedSensitiveFiles.includes(path.join(runtime, "execution.sqlite3-shm")));
		assert.ok(report.omittedSensitiveFiles.includes(path.join(runtime, "unknown.bin")));
		assert.deepEqual(report.skippedSpecialFiles, [path.join(runtime, "trajectory-link")]);
		assert.match(fs.readFileSync(path.join(output, "README.txt"), "utf8"), /Herder live E2E diagnostics/);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")), report);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("unrelated execution databases are omitted without aborting collection", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-artifact-unrelated-db-"));
	try {
		const tmpRoot = path.join(root, "tmp");
		const workspace = path.join(tmpRoot, "herder-pi-live-unrelated-db");
		const unrelated = path.join(workspace, "cache", "execution.sqlite3");
		const output = path.join(root, "output");
		fs.mkdirSync(path.dirname(unrelated), { recursive: true });
		const database = new DatabaseSync(unrelated);
		try {
			database.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('diagnostic')");
		} finally {
			database.close();
		}

		const report = await collectLiveArtifacts({ host: "pi", output, tmpRoot });
		const copied = path.join(output, "fixtures", path.basename(workspace));
		assert.equal(fs.existsSync(path.join(copied, "cache", "execution.sqlite3")), false);
		assert.ok(report.omittedSensitiveFiles.includes(unrelated));
		assert.equal(fs.existsSync(output), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("malformed execution databases fail closed before output placement", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-artifact-malformed-"));
	try {
		const tmpRoot = path.join(root, "tmp");
		const runtime = path.join(tmpRoot, "herder-pi-live-malformed", "repository", "herder-plans", ".herder");
		const output = path.join(root, "output");
		fs.mkdirSync(runtime, { recursive: true });
		fs.writeFileSync(path.join(runtime, "execution.sqlite3"), Buffer.from("not-a-sqlite-database"));
		await assert.rejects(collectLiveArtifacts({ host: "pi", output, tmpRoot }));
		assert.equal(fs.existsSync(output), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
