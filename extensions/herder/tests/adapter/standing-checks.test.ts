// Standing-approval check-command validation across approve_goal and runCheck via the standing-approval contract.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedCheckCommand, standingRegistry, type StandingApproval } from "../../src/adapter/standing.ts";
import { runCheck } from "../../src/checks/runner.ts";
import { openRun } from "../../src/run/store.ts";
import type { CheckSpec, OutputStore } from "../../src/types.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { harness } from "./harness.ts";

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	standingRegistry().grants.clear();
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function repo(): GitFixture {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	return fixture;
}

function session(fixture: GitFixture, options: Partial<Parameters<typeof harness>[0]> = {}) {
	const h = harness({ cwd: fixture.dir, ...options });
	cleanups.push(h.shutdown);
	return h;
}

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function tempOutputs(dir: string): OutputStore {
	return {
		put(content) {
			const ref = `outputs/${createHash("sha256").update(content).digest("hex")}.txt`;
			mkdirSync(join(dir, "outputs"), { recursive: true });
			writeFileSync(join(dir, ref), content);
			return ref;
		},
		read: (ref) => readFileSync(join(dir, ref), "utf8"),
	};
}

const AUTHORIZATION = "The user lets this session implement and verify Herder runs in this repository while away; delivery waits for their return.";

function publishStandingGrant(fixture: GitFixture, overrides: Partial<StandingApproval> = {}): StandingApproval {
	const value: StandingApproval = {
		id: "selfdrive-checks-1",
		commonDir: fixture.commonDir,
		toplevel: fixture.dir,
		text: AUTHORIZATION,
		since: new Date(Date.now() - 60_000).toISOString(),
		...overrides,
	};
	standingRegistry().grants.set(value.id, value);
	return value;
}

function goalWithChecks(rows: Array<{ id: string; command: string }>): string {
	const table = rows.map((row) => `| ${row.id} | ${row.command} | 1m | yes |`).join("\n");
	return `# Goal: Validate standing checks

## Intent
Ensure check commands obey standing-approval limits.

## Acceptance criteria
- AC-1: WHEN checks run THE SYSTEM SHALL verify the work. verify: check:${rows[0]!.id}

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
${table}
`;
}

const guardCommand = (command: string): string | undefined => {
	if (/\bgit\s+push\b/.test(command)) return "Blocked by self-driving mode: git push leaves this machine, and that waits for your user.";
	if (/\bnpm\s+publish\b/.test(command)) return "Blocked by self-driving mode: npm publish leaves this machine, and that waits for your user.";
	return undefined;
};

describe("blockedCheckCommand", () => {
	it("returns undefined when no grants exist or checkCommand is omitted", () => {
		const fixture = repo();
		expect(blockedCheckCommand("git push", fixture.dir)).toBeUndefined();
		const grant = publishStandingGrant(fixture);
		expect(blockedCheckCommand("git push", fixture.dir, grant)).toBeUndefined();
		expect(blockedCheckCommand("git push", fixture.dir)).toBeUndefined();
	});

	it("fails closed when a grant's checkCommand throws", () => {
		const fixture = repo();
		const grant = publishStandingGrant(fixture, {
			checkCommand: () => { throw new Error("guard exploded"); },
		});
		expect(blockedCheckCommand("echo ok", fixture.dir, grant)).toContain("guard exploded");
		expect(blockedCheckCommand("echo ok", fixture.dir)).toContain("guard exploded");
	});
});

describe("approve_goal check validation under a standing grant", () => {
	it("refuses goal.md with a disallowed check command and does not journal goal.approved", async () => {
		const fixture = repo();
		const checkCommand = vi.fn((command: string) => guardCommand(command));
		const grant = publishStandingGrant(fixture, { checkCommand });
		const h = session(fixture, { hasUI: false });
		const started = await h.tool("herder_run", { action: "start", goal: "verify checks" });
		const run = openRun(fixture.commonDir, started.details.runId as string);
		writeFileSync(run.paths.goal, goalWithChecks([
			{ id: "ok", command: "echo ok" },
			{ id: "push", command: "git push origin main" },
		]));

		const result = await h.tool("herder_run", { action: "approve_goal" });
		expect(result.details).toMatchObject({
			approved: false,
			blocked: true,
			grant: grant.id,
			blockedChecks: [
				{
					id: "push",
					command: "git push origin main",
					reason: expect.stringContaining("git push"),
				},
			],
		});
		expect(result.content[0].text).toContain("check push");
		expect(result.content[0].text).toContain("git push");
		expect(checkCommand).toHaveBeenCalledWith("echo ok", run.paths.worktrees);
		expect(checkCommand).toHaveBeenCalledWith("git push origin main", run.paths.worktrees);
		expect(run.journal.read().filter((event) => event.t === "goal.approved")).toHaveLength(0);
	});

	it("approves benign checks under a standing grant and allows revising after a refusal", async () => {
		const fixture = repo();
		const checkCommand = vi.fn((command: string) => guardCommand(command));
		const grant = publishStandingGrant(fixture, { checkCommand });
		const h = session(fixture, { hasUI: false });
		const started = await h.tool("herder_run", { action: "start", goal: "verify benign checks" });
		const run = openRun(fixture.commonDir, started.details.runId as string);

		writeFileSync(run.paths.goal, goalWithChecks([{ id: "bad", command: "npm publish" }]));
		const refused = await h.tool("herder_run", { action: "approve_goal" });
		expect(refused.details).toMatchObject({ approved: false, blocked: true });
		expect(run.journal.read().filter((event) => event.t === "goal.approved")).toHaveLength(0);

		writeFileSync(run.paths.goal, goalWithChecks([{ id: "unit", command: "echo ok" }]));
		const approved = await h.tool("herder_run", { action: "approve_goal" });
		expect(approved.details).toMatchObject({ approved: true, approvedBy: "standing", grant: grant.id });
		expect(run.journal.read().filter((event) => event.t === "goal.approved")).toEqual([
			expect.objectContaining({ approvedBy: "standing", grant: grant.id }),
		]);

		const workDir = tempDir("herder-standing-ok-");
		const outputs = tempOutputs(workDir);
		const checkResult = await runCheck(
			{ id: "unit", command: "echo ok", timeoutMs: 5_000, integrate: true },
			{ cwd: workDir, commit: "abc123", outputs },
		);
		expect(checkResult).toMatchObject({ id: "unit", passed: true, exitCode: 0, timedOut: false, tail: "ok" });
	});

	it("leaves user-approved approve_goal unchanged when no standing grant is active", async () => {
		const fixture = repo();
		const h = session(fixture, { hasUI: true });
		const started = await h.tool("herder_run", { action: "start", goal: "user approved goal" });
		const run = openRun(fixture.commonDir, started.details.runId as string);
		writeFileSync(run.paths.goal, goalWithChecks([{ id: "push", command: "git push origin main" }]));

		const approved = await h.tool("herder_run", { action: "approve_goal" });
		expect(h.confirm).toHaveBeenCalledTimes(1);
		expect(approved.details).toMatchObject({ approved: true });
		expect(approved.details).not.toHaveProperty("approvedBy");
		const events = run.journal.read().filter((event) => event.t === "goal.approved");
		expect(events).toEqual([expect.objectContaining({ approvedBy: "user" })]);
		expect(events[0]).not.toHaveProperty("grant");
	});
});

describe("runCheck under a standing grant", () => {
	const spec = (command: string, id = "check"): CheckSpec => ({ id, command, timeoutMs: 5_000, integrate: false });

	it("refuses to spawn /bin/sh when an active standing grant blocks the command", async () => {
		const fixture = repo();
		const dir = tempDir("herder-standing-run-");
		const outputs = tempOutputs(dir);
		const sentinel = join(dir, "ran.txt");
		const checkCommand = vi.fn((command: string) => guardCommand(command));
		publishStandingGrant(fixture, { checkCommand });

		const cmd = `echo ran > "${sentinel}" && git push origin main`;
		const result = await runCheck(spec(cmd, "push"), { cwd: dir, commit: "abc123", outputs });
		expect(checkCommand).toHaveBeenCalledWith(cmd, dir);
		expect(existsSync(sentinel)).toBe(false);
		expect(result).toMatchObject({
			id: "push",
			commit: "abc123",
			passed: false,
			exitCode: 126,
			timedOut: false,
		});
		expect(result.tail).toContain("Blocked by self-driving mode: git push");
		expect(outputs.read(result.logRef)).toContain("Blocked by self-driving mode: git push");
	});

	it("runs benign commands normally while a standing grant is active", async () => {
		const fixture = repo();
		const dir = tempDir("herder-standing-allow-");
		const outputs = tempOutputs(dir);
		const sentinel = join(dir, "ok.txt");
		publishStandingGrant(fixture, { checkCommand: (command) => guardCommand(command) });

		const result = await runCheck(spec(`echo ok > "${sentinel}" && cat "${sentinel}"`, "ok"), { cwd: dir, commit: "abc123", outputs });
		expect(existsSync(sentinel)).toBe(true);
		expect(result).toMatchObject({ id: "ok", passed: true, exitCode: 0, timedOut: false, tail: "ok" });
	});

	it("runs commands unchanged when no standing grant is active", async () => {
		const dir = tempDir("herder-no-standing-");
		const outputs = tempOutputs(dir);
		const sentinel = join(dir, "user-ran.txt");

		const result = await runCheck(spec(`echo user > "${sentinel}" && echo "git push" >/dev/null && cat "${sentinel}"`, "user"), { cwd: dir, commit: "abc123", outputs });
		expect(existsSync(sentinel)).toBe(true);
		expect(result).toMatchObject({ id: "user", passed: true, exitCode: 0, timedOut: false, tail: "user" });
	});
});
