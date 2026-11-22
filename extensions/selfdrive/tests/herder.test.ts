// selfdrive and Herder in one real Pi session on the faux provider, both loaded by path as Pi loads them (separate module
// instances that share only the process-global standing-approval registry), inside a temporary git repository.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Context, type ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { openRun } from "../../herder/src/run/store.ts";
import { createGitFixture, type GitFixture } from "../../herder/tests/support/git-fixture.ts";
import { grants } from "../grants.ts";
import { reasons } from "../guard.ts";
import {
	scopeAgentDir,
	startSelfdriveSession,
	textOf,
	type RecordedToolResult as ToolResult,
} from "./support/session-harness.ts";

const SELFDRIVE = fileURLToPath(new URL("../index.ts", import.meta.url));
const HERDER = fileURLToPath(new URL("../../herder/index.ts", import.meta.url));

const GOAL = `# Goal: Fix the docs

## Intent
Readers want the README to match the code.

## Acceptance criteria
- AC-1: WHEN the README is read THE SYSTEM SHALL describe the fixture. verify: check:readme

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| readme | grep -q fixture README.md | 1m | yes |
`;
const PLAN = "# Plan\n\n- [ ] T1 (AC-1) Rewrite the README\n";

const calls = (...blocks: ToolCall[]) => fauxAssistantMessage(blocks, { stopReason: "toolUse" });
/** The artifact path the latest `herder_run start` result names, read from the provider's context like a model would. */
function artifactPath(context: Context, name: "goal.md" | "plan.md"): string {
	const result = [...context.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "herder_run");
	const path = new RegExp(`^- ${name.replace(".", "\\.")}: (.+)$`, "m").exec(result ? textOf(result) : "")?.[1];
	if (!path) throw new Error(`no ${name} path in the last herder_run result`);
	return path;
}

let root: string;
let fixture: GitFixture;
let restoreAgentDir: (() => void) | undefined;
let previousPath: string | undefined;
const started: { dispose(): Promise<void> }[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-selfdrive-herder-"));
	await Promise.all(["agent", "sessions", "bin"].map((name) => mkdir(join(root, name))));
	restoreAgentDir = scopeAgentDir(join(root, "agent"));
	// The by-path module is not the one this file imports, so its keep-awake cannot be replaced: shadow caffeinate instead.
	writeFileSync(join(root, "bin", "caffeinate"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(root, "bin", "caffeinate"), 0o755);
	previousPath = process.env.PATH;
	process.env.PATH = `${join(root, "bin")}${delimiter}${previousPath ?? ""}`;
	fixture = createGitFixture();
});

afterEach(async () => {
	try {
		for (const harness of started.splice(0)) await harness.dispose();
	} finally {
		fixture.cleanup();
		restoreAgentDir?.();
		process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

async function start(script: FauxResponseStep[]) {
	const harness = await startSelfdriveSession({
		cwd: fixture.dir,
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
		api: "selfdrive-herder-test-api",
		provider: "selfdrive-herder-test",
		keepRecentTokens: 1,
		settleTimeoutMs: 20_000,
		additionalExtensionPaths: [SELFDRIVE, HERDER],
		script,
	});
	started.push(harness);
	return harness;
}

describe("selfdrive with Herder", () => {
	it("approves goals under the grant, guards the checkout and delivery, and asks again once the user is back", { timeout: 60_000 }, async () => {
		const paths: { goal?: string; plan?: string } = {};
		const writeGoal: FauxResponseStep = (context) => {
			paths.goal = artifactPath(context, "goal.md");
			paths.plan = artifactPath(context, "plan.md");
			return calls(fauxToolCall("write", { path: paths.goal, content: GOAL }));
		};
		const readme = join(fixture.dir, "README.md");
		const h = await start([
			// The kickoff run: a Herder run under the grant, then what the guard refuses and allows.
			calls(fauxToolCall("herder_run", { action: "start", goal: "Fix the docs" })),
			writeGoal,
			calls(fauxToolCall("herder_run", { action: "approve_goal" })),
			calls(fauxToolCall("write", { path: readme, content: "# rewritten\n" })),
			calls(fauxToolCall("bash", { command: "git push origin main" })),
			() => calls(fauxToolCall("write", { path: paths.plan!, content: PLAN })),
			calls(fauxToolCall("herder_deliver", {})),
			calls(fauxToolCall("herder_run", { action: "abort" })),
			calls(fauxToolCall("selfdrive_next", { action: "wait", seconds: 60, reason: "test" })),
			fauxAssistantMessage("waiting"),
			// After the user is back: a fresh run, whose goal needs the user again.
			calls(fauxToolCall("herder_run", { action: "start", goal: "Fix the docs again" })),
			writeGoal,
			calls(fauxToolCall("herder_run", { action: "approve_goal" })),
			fauxAssistantMessage("approved"),
		]);

		// 1. Turning the mode on publishes a grant for the fixture repository.
		await h.command("/selfdrive on fix the docs");
		expect(h.confirms).toHaveLength(1);
		expect(h.confirms[0]!.title).toContain("self-driving");
		const grant = h.grant!;
		expect(grant).toMatchObject({ id: h.id, toplevel: fixture.dir, commonDir: fixture.commonDir });
		expect(grant.text).toContain("Focus: fix the docs.");
		await h.settle(10);

		const results = h.toolResults();
		expect(results.map((result) => [result.toolName, result.isError])).toEqual([
			["herder_run", false], ["write", false], ["herder_run", false],
			["write", true], ["bash", true], ["write", false], ["herder_deliver", true], ["herder_run", false],
			["selfdrive_next", false],
		]);
		const [started1, goalWrite, approval, checkoutWrite, push, planWrite, delivery, abort] = results as [ToolResult, ToolResult, ToolResult, ToolResult, ToolResult, ToolResult, ToolResult, ToolResult];

		// 2. The goal is approved under the grant: no dialog, and the journal names the grant.
		const runId = started1.details!.runId as string;
		expect(textOf(started1)).toContain("A standing authorization from the user is in effect for this repository");
		expect(paths.goal!.startsWith(join(fixture.commonDir, "herder"))).toBe(true);
		expect(textOf(goalWrite)).not.toContain("Blocked");
		expect(approval.details).toMatchObject({ approved: true, approvedBy: "standing", grant: grant.id });
		expect(h.confirms).toHaveLength(1);
		const journal = openRun(fixture.commonDir, runId).journal.read();
		expect(journal.filter((event) => event.t === "goal.approved")).toEqual([
			expect.objectContaining({ approvedBy: "standing", authorization: grant.text, grant: grant.id }),
		]);

		// 3. The guard refuses the checkout write and the push, allows the run directory, and refuses delivery without a dialog.
		expect(textOf(checkoutWrite)).toBe(reasons.checkout(`write ${readme}`));
		expect(fixture.read("README.md")).toBe("# fixture\n");
		expect(textOf(push)).toBe(reasons.remote("git push"));
		expect(paths.plan!.startsWith(join(fixture.commonDir, "herder"))).toBe(true);
		expect(readFileSync(paths.plan!, "utf8")).toBe(PLAN);
		expect(readFileSync(paths.goal!, "utf8")).toBe(GOAL);
		expect(textOf(planWrite)).not.toContain("Blocked");
		expect(textOf(delivery)).toBe(reasons.deliver);
		// The run approved under the grant is abandoned unasked, so a fresh one can start.
		expect(abort.details).toMatchObject({ runId, aborted: true, grant: grant.id });
		expect(h.confirms).toHaveLength(1);
		expect(fixture.status()).toBe("");
		expect(h.grant).toBeDefined();

		// 4. The user's own input ends the mode and withdraws the grant; a fresh run's goal asks the user again.
		await h.session.prompt("I'm back: start another run", { source: "interactive" });
		expect(h.entries().at(-1)).toMatchObject({ active: false, reason: "returned" });
		expect(grants().some((value) => value.id === grant.id)).toBe(false);
		await h.settle(14);
		expect(h.requests[10]!.texts.at(-1)).toBe("I'm back: start another run");
		const later = h.toolResults().slice(results.length);
		expect(later.map((result) => [result.toolName, result.isError])).toEqual([["herder_run", false], ["write", false], ["herder_run", false]]);
		const runId2 = later[0]!.details!.runId as string;
		expect(runId2).not.toBe(runId);
		expect(textOf(later[0]!)).not.toContain("A standing authorization from the user is in effect");
		expect(h.confirms).toHaveLength(2);
		expect(h.confirms[1]!.title).toBe("Approve Herder goal: Fix the docs");
		expect(later[2]!.details).toMatchObject({ approved: true });
		expect(later[2]!.details).not.toHaveProperty("approvedBy");
		const approved = openRun(fixture.commonDir, runId2).journal.read().filter((event) => event.t === "goal.approved");
		expect(approved).toEqual([expect.objectContaining({ approvedBy: "user" })]);
		expect(approved[0]).not.toHaveProperty("grant");
	});
});
