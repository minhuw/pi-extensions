import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeHerderTool } from "../../../src/application/tools.ts";
import { stopService } from "../../../src/client/index.ts";
import { git } from "../../../src/daemon/git-driver.ts";

function planRoot(): { root: string; planDirectory: string } {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-dashboard-opening-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.name", "Herder Dashboard Opening Test"]);
	git(root, ["config", "user.email", "herder-dashboard-opening@example.invalid"]);
	const planDirectory = path.join(root, "herder-plans");
	mkdirSync(planDirectory, { recursive: true });
	writeFileSync(path.join(planDirectory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|

## Dependency notes

None.

## Considered and rejected

None.
`);
	git(root, ["add", "."]);
	git(root, ["commit", "-q", "-m", "test: dashboard opening fixture"]);
	return { root, planDirectory };
}

test("only explicit user-facing dashboard actions open Orca", async () => {
	const fixture = planRoot();
	const command = path.join(fixture.root, "fake-orca.cjs");
	const calls = path.join(fixture.root, "orca-calls.log");
	writeFileSync(command, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\n`);
	chmodSync(command, 0o755);
	const previousOwned = process.env.ORCA_PI_STATUS_OWNED;
	const previousCommand = process.env.ORCA_CLI_COMMAND;
	process.env.ORCA_PI_STATUS_OWNED = "test-owned";
	process.env.ORCA_CLI_COMMAND = command;
	try {
		await invokeHerderTool("herder_run", { operation: "status", planDirectory: fixture.planDirectory });
		assert.equal(existsSync(calls), false, "status or daemon startup opened an Orca tab");

		await invokeHerderTool("herder_run", { operation: "dashboard", planDirectory: fixture.planDirectory });
		const lines = readFileSync(calls, "utf8").trim().split(/\r?\n/);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^tab create --url http:\/\/127\.0\.0\.1:\d+\/ --json$/);

		await invokeHerderTool("herder_run", { operation: "status", planDirectory: fixture.planDirectory });
		assert.equal(readFileSync(calls, "utf8").trim().split(/\r?\n/).length, 1, "status reopened the Orca tab");
	} finally {
		if (previousOwned === undefined) delete process.env.ORCA_PI_STATUS_OWNED;
		else process.env.ORCA_PI_STATUS_OWNED = previousOwned;
		if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
		else process.env.ORCA_CLI_COMMAND = previousCommand;
		await stopService(fixture.planDirectory).catch(() => {});
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
