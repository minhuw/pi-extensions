// herder_run { action: "start" } and the /herder-improve and /herder-simplify audit commands.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAudit, PROMPT_TYPE } from "../../src/adapter/commands.ts";
import { auditSkillDir, skillText } from "../../src/adapter/prompts.ts";
import { createRuntimeFactory } from "../../src/adapter/runtime.ts";
import { loadRoles } from "../../src/agents/roles.ts";
import { MAX_CLARIFYING_QUESTIONS, STATUS_KEY } from "../../src/config.ts";
import { readLock } from "../../src/run/lock.ts";
import { refPrefix } from "../../src/run/paths.ts";
import { activeRun, listRuns, openRun } from "../../src/run/store.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { FakeRuntime, harness, VALID_GOAL } from "./harness.ts";

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup(options: Partial<Parameters<typeof harness>[0]> = {}) {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	const h = harness({ cwd: fixture.dir, ...options });
	cleanups.push(h.shutdown);
	const audit = (kind: "improve" | "simplify", args: string) => h.commands.get(`herder-${kind}`).handler(args, h.ctx) as Promise<void>;
	return { fixture, h, audit };
}

describe("herder_run start", () => {
	it("creates a run with its refs, lock, and draft goal.md and returns the start prompt", async () => {
		const factory = createRuntimeFactory({ roles: () => loadRoles({ overrideDir: join(tmpdir(), "herder-no-role-overrides") }) });
		const { fixture, h } = setup({ options: { createRuntime: factory } });
		const base = fixture.head();
		const result = await h.tool("herder_run", { action: "start", goal: "Simplify: retire the old parser\n\n1. The parser in src/old.ts is unused." });
		const runId = activeRun(fixture.commonDir)!;
		expect(result.details).toEqual({ runId, action: "start" });
		const run = openRun(fixture.commonDir, runId);
		expect(fixture.git("rev-parse", `${refPrefix(runId)}/base`, `${refPrefix(runId)}/integration`)).toBe(`${base}\n${base}`);
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-a#[0-9a-f]{8}$/);
		expect(readFileSync(run.paths.goal, "utf8")).toMatch(/^# Goal: Simplify: retire the old parser\n/);
		expect(run.state().title).toBe("Simplify: retire the old parser");
		const prompt = result.content[0].text as string;
		expect(prompt).toContain(runId);
		expect(prompt).toContain("The parser in src/old.ts is unused.");
		for (const path of [run.paths.goal, run.paths.plan]) expect(prompt).toContain(path);
		// The conversation or audit that led to the tool call already clarified; /herder <goal> keeps its question limit.
		expect(prompt).toContain("Ask the user only what is still open");
		expect(prompt).not.toContain(`at most ${MAX_CLARIFYING_QUESTIONS} clarifying questions`);
		expect(prompt).toContain(skillText());
		expect(h.sent).toHaveLength(0);
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: drafting goal");
		expect(fixture.status()).toBe("");
	});

	it("needs no UI to start but still refuses approval without one", async () => {
		const { fixture, h } = setup({ hasUI: false });
		await h.tool("herder_run", { action: "start", goal: "add a greeting" });
		const run = openRun(fixture.commonDir, activeRun(fixture.commonDir)!);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await expect(h.tool("herder_run", { action: "approve_goal" })).rejects.toThrow(/interactive/);
	});

	it("refuses without goal text, without a commit, and while a run is unfinished", async () => {
		const { fixture, h } = setup();
		await expect(h.tool("herder_run", { action: "start" })).rejects.toThrow(/goal text/);
		await expect(h.tool("herder_run", { action: "start", goal: "  " })).rejects.toThrow(/goal text/);
		const result = await h.tool("herder_run", { action: "start", goal: "first goal" });
		const runId = result.details.runId as string;
		await expect(h.tool("herder_run", { action: "start", goal: "second goal" })).rejects.toThrow(`/herder resume ${runId}, or abandon it with /herder abort ${runId}`);
		await h.command("third goal");
		expect(h.lastNotice()).toMatchObject({ level: "error", text: expect.stringContaining(`/herder resume ${runId}`) });
		expect(listRuns(fixture.commonDir)).toEqual([runId]);
		const empty = setup();
		empty.fixture.git("update-ref", "-d", "HEAD");
		await expect(empty.h.tool("herder_run", { action: "start", goal: "a goal" })).rejects.toThrow(/at least one commit/);
	});

	it("journals a run whose runtime cannot start as failed, releases its lock, and starts the next one", async () => {
		let fail = true;
		const { fixture, h } = setup({ options: { createRuntime: (env) => Object.assign(new FakeRuntime(env), { start() { if (fail) throw new Error("no refs"); } }) } });
		await expect(h.tool("herder_run", { action: "start", goal: "first goal" })).rejects.toThrow("no refs");
		const [failed] = listRuns(fixture.commonDir);
		const run = openRun(fixture.commonDir, failed!);
		expect(run.state().status).toBe("failed");
		expect(readLock(run.paths.lock)).toBeNull();
		expect(activeRun(fixture.commonDir)).toBeNull();
		fail = false;
		const result = await h.tool("herder_run", { action: "start", goal: "second goal" });
		expect(activeRun(fixture.commonDir)).toBe(result.details.runId);
		expect(listRuns(fixture.commonDir)).toHaveLength(2);
	});

	it("is not blocked by a finished, idle run this session still holds", async () => {
		const { fixture, h, audit } = setup();
		const first = (await h.tool("herder_run", { action: "start", goal: "first goal" })).details.runId as string;
		openRun(fixture.commonDir, first).journal.append({ t: "run.finished", status: "failed", reason: "test" });
		await audit("simplify", "");
		expect(h.lastNotice()).toMatchObject({ level: "info" });
		expect(h.sent).toHaveLength(1);
		const second = (await h.tool("herder_run", { action: "start", goal: "second goal" })).details.runId as string;
		expect(second).not.toBe(first);
		expect(activeRun(fixture.commonDir)).toBe(second);
		expect(readLock(openRun(fixture.commonDir, first).paths.lock)).toBeNull();
	});

	it("refuses while this session's run is busy", async () => {
		const { fixture, h } = setup();
		await h.command("add a greeting");
		const run = openRun(fixture.commonDir, activeRun(fixture.commonDir)!);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await h.tool("herder_run", { action: "approve_goal" });
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		// The run finished elsewhere while its launch still runs here: nothing is unfinished, but the session is busy.
		run.journal.append({ t: "run.finished", status: "failed", reason: "test" });
		await expect(h.tool("herder_run", { action: "start", goal: "another goal" })).rejects.toThrow(/still has a launch or tool call running/);
		expect(listRuns(fixture.commonDir)).toHaveLength(1);
	});
});

describe("audit arguments", () => {
	it("parses effort, focus, --lang, and --auto leniently", () => {
		expect(parseAudit("")).toEqual({ args: "", auto: false });
		expect(parseAudit("deep security --lang zh-CN --auto")).toEqual({ args: "deep security --lang zh-CN --auto", effort: "deep", focus: "security", lang: "zh-CN", auto: true });
		expect(parseAudit('--lang "Traditional Chinese" src/api branch')).toMatchObject({ lang: "Traditional Chinese", focus: "src/api branch", auto: false });
		expect(parseAudit("--lang=ja quick next")).toMatchObject({ lang: "ja", effort: "quick", focus: "next" });
		expect(parseAudit("quick deep")).toMatchObject({ effort: "quick", focus: "deep" });
		expect(parseAudit("--lang --auto")).toMatchObject({ lang: "", auto: true });
		expect(parseAudit("tests --lang")).toMatchObject({ lang: "", focus: "tests" });
		expect(parseAudit("--weird flow")).toMatchObject({ focus: "--weird flow" });
	});
});

describe("/herder-improve and /herder-simplify", () => {
	it("registers both commands with descriptions and argument completions", () => {
		const { h } = setup();
		for (const kind of ["improve", "simplify"]) {
			const command = h.commands.get(`herder-${kind}`);
			expect(command.description).toMatch(/read-only/i);
			expect(command.description).toContain("--auto");
			const values = (prefix: string) => command.getArgumentCompletions(prefix)?.map((item: { value: string }) => item.value);
			expect(values("")).toEqual(expect.arrayContaining(["quick", "standard", "deep", "branch", "--lang", "--auto"]));
			expect(values("de")).toEqual(kind === "improve" ? ["deep"] : ["deep", "deletion", "dependencies"]);
			expect(values("deep --a")).toEqual(["deep --auto"]);
			expect(command.getArgumentCompletions("deep --auto --a")).toBeNull();
			expect(command.getArgumentCompletions("zzz")).toBeNull();
			// An open menu takes the Enter that should run the command, so a complete word gets none.
			expect(command.getArgumentCompletions("deep")).toBeNull();
			expect(command.getArgumentCompletions("deep --auto")).toBeNull();
		}
		expect(h.commands.get("herder-improve").getArgumentCompletions("ro").map((item: { value: string }) => item.value)).toEqual(["roadmap"]);
		expect(h.commands.get("herder-simplify").getArgumentCompletions("ro")).toBeNull();
	});

	it.each(["improve", "simplify"] as const)("/herder-%s sends one prompt with the skill, its directory, the invocation, and the repository", async (kind) => {
		const { fixture, h, audit } = setup();
		await audit(kind, "deep src/api --lang zh-CN --auto");
		expect(h.lastNotice()).toMatchObject({ level: "info" });
		expect(h.sent).toHaveLength(1);
		const message = h.sent[0];
		expect(message).toMatchObject({ customType: PROMPT_TYPE, display: true, details: { action: kind, skillDir: auditSkillDir(kind), invocation: { effort: "deep", focus: "src/api", lang: "zh-CN", auto: true } } });
		expect(h.pi.sendMessage).toHaveBeenLastCalledWith(expect.anything(), { triggerTurn: true, deliverAs: "followUp" });
		const prompt = message.content as string;
		expect(prompt).toContain(skillText(join(auditSkillDir(kind), "SKILL.md")));
		expect(prompt).not.toMatch(new RegExp(`^name: herder-${kind}$`, "m"));
		expect(prompt).toContain(`Skill directory: ${auditSkillDir(kind)}`);
		expect(prompt).toContain(`Repository: ${fixture.dir}`);
		expect(prompt).toContain(`Invocation: /herder-${kind} deep src/api --lang zh-CN --auto`);
		expect(prompt).toContain("- effort: deep");
		expect(prompt).toContain("- focus: src/api");
		expect(prompt).toContain("- language: zh-CN");
		expect(prompt).toContain("- auto: yes: take the recommended findings and every finding they depend on, transitively");
		// No run, no lock, no footer.
		expect(listRuns(fixture.commonDir)).toEqual([]);
		expect(h.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(fixture.status()).toBe("");
	});

	it("defaults to a standard whole-repository audit with the picker", async () => {
		const { h, audit } = setup();
		await audit("improve", "");
		const prompt = h.sent[0].content as string;
		expect(prompt).toContain("Invocation: /herder-improve\n");
		expect(prompt).toContain("- effort: standard (default)");
		expect(prompt).toContain("- focus: the whole repository");
		expect(prompt).toContain("- language: the user's conversation language");
		expect(prompt).toContain("- auto: no: the user picks findings with herder_pick_findings");
		await audit("simplify", "--lang");
		expect(h.sent[1].content).toContain("ask the user which language");
	});

	it("refuses without UI, without a commit, and while a run is unfinished", async () => {
		const headless = setup({ hasUI: false });
		await headless.audit("improve", "");
		expect(headless.h.lastNotice()).toEqual({ level: "error", text: "/herder-improve needs an interactive session (TUI or RPC): the audit ends in a run you approve." });
		const empty = setup();
		empty.fixture.git("update-ref", "-d", "HEAD");
		await empty.audit("simplify", "quick");
		expect(empty.h.lastNotice()).toMatchObject({ level: "error", text: expect.stringMatching(/at least one commit/) });
		const { h, audit } = setup();
		await h.command("a goal");
		const runId = h.sent[0].details.runId as string;
		await audit("simplify", "");
		expect(h.lastNotice()).toMatchObject({ level: "error" });
		expect(h.lastNotice()!.text).toContain(`/herder resume ${runId}`);
		expect(h.lastNotice()!.text).toContain(`/herder abort ${runId}`);
		for (const s of [headless, empty]) expect(s.h.sent).toHaveLength(0);
		expect(h.sent).toHaveLength(1);
	});
});
