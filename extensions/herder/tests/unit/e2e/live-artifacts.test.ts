import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectLiveArtifacts } from "../../e2e/support/collect-live-artifacts.ts";

test("live artifacts preserve diagnostics while redacting endpoint secrets", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-artifact-test-"));
	try {
		const tmpRoot = path.join(root, "tmp");
		const workspace = path.join(tmpRoot, "herder-v010-codex-example");
		const runtime = path.join(workspace, "repository", "herder-plans", ".herder");
		const output = path.join(root, "output");
		const key = "test-secret-key-value";
		const base = "https://proxy.example.invalid";
		fs.mkdirSync(runtime, { recursive: true });
		fs.writeFileSync(path.join(workspace, "codex.log"), `key=${key} endpoint=${base}/v1 safe=1\n`);
		fs.writeFileSync(path.join(runtime, "execution.sqlite3"), Buffer.from([0, 1, 2, 3]));
		fs.writeFileSync(path.join(runtime, "sensitive.bin"), Buffer.concat([Buffer.from([0]), Buffer.from(key), Buffer.from([0])]));

		const report = collectLiveArtifacts({
			host: "codex",
			output,
			tmpRoot,
			environment: { CLIPROXY_API_KEY: key, CLIPROXY_BASE_URL: base },
		});
		const copied = path.join(output, "fixtures", path.basename(workspace));
		const trajectory = fs.readFileSync(path.join(copied, "codex.log"), "utf8");
		assert.doesNotMatch(trajectory, new RegExp(key));
		assert.doesNotMatch(trajectory, /proxy\.example\.invalid/);
		assert.match(trajectory, /\[REDACTED:CLIPROXY_API_KEY\]/);
		assert.match(trajectory, /\[REDACTED:CLIPROXY_BASE_URL\]/);
		assert.deepEqual(fs.readFileSync(path.join(copied, "repository", "herder-plans", ".herder", "execution.sqlite3")), Buffer.from([0, 1, 2, 3]));
		assert.equal(fs.existsSync(path.join(copied, "repository", "herder-plans", ".herder", "sensitive.bin")), false);
		assert.equal(report.redactedOccurrences.CLIPROXY_API_KEY, 1);
		assert.equal(report.redactedOccurrences.CLIPROXY_BASE_URL, 1);
		assert.deepEqual(report.omittedSensitiveFiles, [path.join(runtime, "sensitive.bin")]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
