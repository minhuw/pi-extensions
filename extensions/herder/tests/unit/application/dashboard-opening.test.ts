import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { invokeHerderTool } from "../../../src/application/tools.ts";
import { stopService } from "../../../src/client/index.ts";
import { planFixture } from "../../support/plan-fixture.ts";

test("only explicit user-facing dashboard actions open Orca", async () => {
	const fixture = planFixture({ prefix: "herder-dashboard-opening-" });
	const command = path.join(fixture.root, "fake-orca.cjs");
	const calls = path.join(fixture.root, "orca-calls.log");
	writeFileSync(command, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\n`);
	chmodSync(command, 0o755);
	const previousOwned = process.env.ORCA_PI_STATUS_OWNED;
	const previousCommand = process.env.ORCA_CLI_COMMAND;
	const previousTestDashboardOpen = process.env.HERDER_ALLOW_TEST_DASHBOARD_OPEN;
	process.env.ORCA_PI_STATUS_OWNED = "test-owned";
	process.env.ORCA_CLI_COMMAND = command;
	process.env.HERDER_ALLOW_TEST_DASHBOARD_OPEN = "1";
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
		if (previousTestDashboardOpen === undefined) delete process.env.HERDER_ALLOW_TEST_DASHBOARD_OPEN;
		else process.env.HERDER_ALLOW_TEST_DASHBOARD_OPEN = previousTestDashboardOpen;
		await stopService(fixture.planDirectory).catch(() => {});
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
