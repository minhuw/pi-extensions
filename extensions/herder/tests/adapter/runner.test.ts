// The adapter's default step runner: real Pi agent sessions on the main session's model runtime, with Pi's faux provider.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeFactory } from "../../src/adapter/runtime.ts";
import { loadRoles } from "../../src/agents/roles.ts";
import { activeRun, openRun } from "../../src/run/store.ts";
import type { StepCompletedEvent, StepFailedEvent } from "../../src/types.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { harness } from "./harness.ts";

const GOAL = `# Goal: Look around

## Intent
The project needs a survey.

## Acceptance criteria
- AC-1: WHEN the survey is done THE SYSTEM SHALL report it. verify: check:ok

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| ok | true | 1m | yes |
`;

let dir: string;
let previousAgentDir: string | undefined;
const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "herder-runner-"));
	// The default runner reads settings and context files from the agent dir; keep it away from the user's.
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

const emptyRuntime = () => ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });

/** An approved run held by `session-a`, whose context exposes `runtime` and `model` as a Pi session's would. */
async function approvedRun(runtime: ModelRuntime, context: Record<string, unknown>, sessionFile?: string) {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	const createRuntime = createRuntimeFactory({ roles: () => loadRoles({ overrideDir: join(dir, "no-role-overrides") }) });
	const h = harness({ cwd: fixture.dir, sessionFile, context: { modelRegistry: new ModelRegistry(runtime), ...context }, options: { createRuntime } });
	cleanups.push(h.shutdown);
	await h.command("look around");
	const run = openRun(fixture.commonDir, activeRun(fixture.commonDir)!);
	writeFileSync(run.paths.goal, GOAL);
	writeFileSync(run.paths.plan, "- [ ] T1 (AC-1) look around\n");
	await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true } });
	return { fixture, h, run };
}

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const sessionFiles = (sessions: string) => existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith(".jsonl")) : [];

describe("default step runner", () => {
	it.each([
		["the holding session's file as parent", true],
		["no parent header when the holding session has no file", false],
	])("persists each step session in the run with its link and %s", async (_name, withFile) => {
		const runtime = await emptyRuntime();
		const faux = fauxProvider({ api: "herder-faux-api", provider: "herder-faux", models: [{ id: "main", reasoning: true }] });
		runtime.registerNativeProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("looked around")]);
		const parentFile = withFile ? join(dir, "main-session.jsonl") : undefined;
		const { fixture, h, run } = await approvedRun(runtime, { model: faux.getModel("main") }, parentFile);

		const step = await h.tool("herder_step", { prompt: "look around", role: "explorer", task: "T1" });
		expect(step.details).toMatchObject({ status: "ok" });
		expect(h.notices.filter((notice) => notice.level === "warning")).toEqual([]);

		const files = sessionFiles(run.paths.sessions);
		expect(files).toHaveLength(1);
		const file = join(run.paths.sessions, files[0]!);
		const entries = lines(file);
		const header = entries[0];
		expect(header).toMatchObject({ type: "session" });
		if (parentFile) expect(header.parentSession).toBe(parentFile);
		else expect(header).not.toHaveProperty("parentSession");
		const link = entries.find((entry) => entry.type === "custom" && entry.customType === "pi-extensions.session-link");
		expect(link.data).toEqual({
			kind: "herder-step", parentSessionId: "session-a", ...(parentFile && { parentSessionFile: parentFile }), agentType: "explorer", description: "T1",
			herder: { runId: run.runId, stepKey: step.details.key, stepId: expect.any(String), task: "T1", role: "explorer", attempt: 1, repo: basename(fixture.dir) },
		});
		const completed = run.journal.read().find((event): event is StepCompletedEvent => event.t === "step.completed");
		expect(completed).toMatchObject({ key: step.details.key, sessionId: header.id, sessionFile: file });
	});

	it("journals no session file for a step whose prompt fails before the first message", async () => {
		const { h, run } = await approvedRun(await emptyRuntime(), { model: undefined });

		const step = await h.tool("herder_step", { prompt: "look around", role: "explorer" });
		expect(step.details).toMatchObject({ status: "failed", error: { class: "auth", message: expect.stringContaining("No API key") } });
		expect(sessionFiles(run.paths.sessions)).toEqual([]);
		const failed = run.journal.read().filter((event): event is StepFailedEvent => event.t === "step.failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ final: true });
		expect(failed[0]).not.toHaveProperty("sessionId");
		expect(failed[0]).not.toHaveProperty("sessionFile");
		expect(run.state().steps.get(step.details.key)).not.toHaveProperty("sessionFile");
	});
});
