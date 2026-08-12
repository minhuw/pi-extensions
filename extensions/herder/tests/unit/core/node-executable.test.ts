import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveNodeExecutable } from "../../../src/shared/node-executable.ts";

test("resolves Node from PATH when the preferred executable disappeared", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-node-executable-"));
	try {
		const linkedNode = path.join(root, process.platform === "win32" ? "node.exe" : "node");
		fs.symlinkSync(process.execPath, linkedNode);
		assert.equal(resolveNodeExecutable(path.join(root, "deleted-node"), { PATH: root }), fs.realpathSync(process.execPath));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("fails closed when neither the preferred executable nor PATH contains Node", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-node-executable-missing-"));
	try {
		assert.throws(() => resolveNodeExecutable(path.join(root, "deleted-node"), { PATH: root }), /Node executable is unavailable/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
