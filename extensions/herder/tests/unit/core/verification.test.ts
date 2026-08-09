import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVerificationRequest, normalizeVerificationManifest } from "../../../src/core/verification.ts";

test("verification manifests are exact-tree bound and structurally validated", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-verification-"));
	const worktree = path.join(root, "worktree");
	fs.mkdirSync(path.join(worktree, "pkg"), { recursive: true });
	try {
		const request = createVerificationRequest({
			requestId: "request-1",
			runId: "run-1",
			generation: 1,
			graphSha256: "a".repeat(64),
			runAssignmentPath: path.join(worktree, "assignment.json"),
			runAssignmentSha256: "b".repeat(64),
			integrationBranch: "herder/example/integration",
			integrationWorktree: worktree,
			integrationHead: "c".repeat(40),
			integrationTree: "d".repeat(40),
			requestedAt: "2026-01-01T00:00:00.000Z",
		});
		const first = normalizeVerificationManifest(request, {
			schemaVersion: 1,
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			runId: request.runId,
			generation: request.generation,
			graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256,
			integrationHead: request.integrationHead,
			integrationTree: request.integrationTree,
			rationale: "One focused command covers the fixture.",
			gates: [{ gateId: "unit", label: "unit tests", cwd: "pkg", argv: ["npm", "test"], rationale: "Exercises the changed package." }],
		});
		const replay = normalizeVerificationManifest(request, JSON.parse(JSON.stringify(first.manifest)));
		assert.equal(replay.manifestSha256, first.manifestSha256);
		assert.equal(first.manifest.gates[0]!.cwd, "pkg");

		assert.throws(() => normalizeVerificationManifest(request, { ...first.manifest, integrationTree: "e".repeat(40) }), /integrationTree does not match/);
		assert.throws(() => normalizeVerificationManifest(request, {
			...first.manifest,
			gates: [first.manifest.gates[0]!, { ...first.manifest.gates[0]!, label: "duplicate" }],
		}), /duplicated/);
		assert.throws(() => normalizeVerificationManifest(request, {
			...first.manifest,
			gates: [{ ...first.manifest.gates[0]!, argv: ["npm\ntest"] }],
		}), /argument 1 is invalid/);
		assert.throws(() => normalizeVerificationManifest(request, {
			...first.manifest,
			gates: [{ ...first.manifest.gates[0]!, cwd: "../" }],
		}), /escapes the integration worktree/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("main session may explicitly select no gates with a rationale", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-verification-empty-"));
	try {
		const request = createVerificationRequest({
			requestId: "request-empty",
			runId: "run-empty",
			generation: 2,
			graphSha256: "1".repeat(64),
			runAssignmentPath: path.join(root, "assignment.json"),
			runAssignmentSha256: "2".repeat(64),
			integrationBranch: "herder/example/integration",
			integrationWorktree: root,
			integrationHead: "3".repeat(40),
			integrationTree: "4".repeat(40),
			requestedAt: "2026-01-01T00:00:00.000Z",
		});
		const normalized = normalizeVerificationManifest(request, {
			schemaVersion: 1,
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			runId: request.runId,
			generation: request.generation,
			graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256,
			integrationHead: request.integrationHead,
			integrationTree: request.integrationTree,
			rationale: "The integrated tree contains metadata-only changes with no executable verification surface.",
			gates: [],
		});
		assert.deepEqual(normalized.manifest.gates, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
