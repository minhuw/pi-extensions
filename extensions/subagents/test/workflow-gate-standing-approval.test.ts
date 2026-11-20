/**
 * workflow-gate-standing-approval.test.ts — `executeGate()` in `WorkflowHost`
 * must enforce active selfdrive standing-approval command guards via
 * `Symbol.for("pi-extensions.standing-approval")` without altering gate
 * behavior when no grant is active.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js"),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";
import { runWorkflow, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx } from "./helpers/boot-extension.js";

const STANDING_APPROVAL_KEY = Symbol.for("pi-extensions.standing-approval");

interface TestStandingGrant {
  id: string;
  commonDir: string;
  toplevel: string;
  checkCommand?: (command: string, cwd: string) => string | undefined;
}

function setStandingGrants(grants: TestStandingGrant[]): void {
  const map = new Map<string, TestStandingGrant>();
  for (const grant of grants) {
    map.set(grant.id, grant);
  }
  (globalThis as Record<symbol, unknown>)[STANDING_APPROVAL_KEY] = { grants: map };
}

function clearStandingGrants(): void {
  delete (globalThis as Record<symbol, unknown>)[STANDING_APPROVAL_KEY];
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

const execOk = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const execFail = (stderr: string): ExecResult => ({ stdout: "", stderr, code: 1, killed: false });

function makePi(gate: (command: string, cwd: string) => ExecResult | Promise<ExecResult> = () => execOk("ok")) {
  const gateRuns: Array<{ command: string; cwd: string }> = [];
  const exec = vi.fn(
    async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (command === "git") {
        try {
          const stdout = execFileSync(command, args, {
            cwd: options?.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { stdout, stderr: "", code: 0, killed: false };
        } catch (err: any) {
          return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false };
        }
      }
      const cwd = options?.cwd ?? "";
      const shellCommand = args[args.length - 1];
      gateRuns.push({ command: shellCommand, cwd });
      return await gate(shellCommand, cwd);
    },
  );
  return { pi: { exec } as any, gateRuns, exec };
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-gate-standing-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# standing gate test");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function spawnRequest(overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest {
  return {
    agentId: "agent-1",
    index: 0,
    label: "x",
    prompt: "do the work",
    agentType: "worker",
    ...overrides,
  };
}

function agentEntries(progress: readonly WorkflowEntry[]): WorkflowAgentEntry[] {
  return progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");
}

const HEAD = 'export const meta = { name: "standing-gate", description: "gate standing-approval guard" };\n';
const BLOCK_REASON = "Blocked by self-driving mode: git push leaves this machine, and that waits for your user.";

describe("WorkflowHost executeGate standing-approval guard", () => {
  let repo: string;
  let manager: AgentManager;
  let previousRegistry: unknown;
  let hadPreviousRegistry: boolean;

  beforeEach(() => {
    const globalObj = globalThis as Record<symbol, unknown>;
    hadPreviousRegistry = STANDING_APPROVAL_KEY in globalObj;
    previousRegistry = globalObj[STANDING_APPROVAL_KEY];
    clearStandingGrants();

    registerAgents(new Map());
    repo = initRepo();
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      const target = opts.cwd ?? repo;
      writeFileSync(join(target, "child-work.txt"), "child output");
      return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
    });
  });

  afterEach(() => {
    const globalObj = globalThis as Record<symbol, unknown>;
    if (hadPreviousRegistry) {
      globalObj[STANDING_APPROVAL_KEY] = previousRegistry;
    } else {
      clearStandingGrants();
    }
    manager.dispose();
    rmSync(repo, { recursive: true, force: true });
    vi.mocked(runAgent).mockReset();
  });

  it("refuses a violating gate command via runGate without spawning the shell", async () => {
    const checkCommand = vi.fn((command: string) =>
      /\bgit\s+push\b/.test(command) ? BLOCK_REASON : undefined,
    );
    setStandingGrants([
      { id: "grant-1", commonDir: join(repo, ".git"), toplevel: repo, checkCommand },
    ]);

    const { pi, gateRuns, exec } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const command = "git push origin main";
    const result = await host.runGate!(command, { agentId: "agent-1" });

    expect(checkCommand).toHaveBeenCalledTimes(1);
    expect(checkCommand).toHaveBeenCalledWith(command, repo);
    expect(exec).not.toHaveBeenCalled();
    expect(gateRuns).toEqual([]);
    expect(result).toEqual({ ok: false, output: BLOCK_REASON });
  });

  it("refuses a violating gate command on an isolated worktree child before spawning the shell", async () => {
    const checkCommand = vi.fn((command: string) =>
      /\bgit\s+push\b/.test(command) ? BLOCK_REASON : undefined,
    );
    setStandingGrants([
      { id: "grant-1", commonDir: join(repo, ".git"), toplevel: repo, checkCommand },
    ]);

    const { pi, gateRuns } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const command = "git push origin main";
    const result = await host.spawnAgent(spawnRequest({ isolation: "worktree", gate: command }));

    const worktreePath = manager.listAgents()[0].worktree?.path;
    expect(worktreePath).toBeTruthy();
    expect(checkCommand).toHaveBeenCalledTimes(1);
    expect(checkCommand).toHaveBeenCalledWith(command, worktreePath);
    expect(gateRuns).toEqual([]);
    expect(result.gate).toEqual({ ok: false, output: BLOCK_REASON });
    expect(existsSync(worktreePath!)).toBe(false);
  });

  it("propagates the standing-approval block reason through runWorkflow and never executes the gate", async () => {
    const checkCommand = vi.fn((command: string) =>
      /\bnpm\s+publish\b/.test(command) ? "Blocked by self-driving mode: npm publish leaves this machine." : undefined,
    );
    setStandingGrants([
      { id: "grant-1", commonDir: join(repo, ".git"), toplevel: repo, checkCommand },
    ]);

    const { pi, gateRuns } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await runWorkflow({
      script: `${HEAD}return await agent("x", { gate: "npm publish" });`,
      host,
    });

    expect(result.value).toBeNull();
    expect(gateRuns).toEqual([]);
    expect(checkCommand).toHaveBeenCalledWith("npm publish", repo);
    expect(agentEntries(result.progress).at(-1)?.error).toBe(
      "Blocked by self-driving mode: npm publish leaves this machine.",
    );
  });

  it("allows a safe gate command when a standing-approval grant is active", async () => {
    const checkCommand = vi.fn((command: string) =>
      /\bgit\s+push\b/.test(command) ? BLOCK_REASON : undefined,
    );
    setStandingGrants([
      { id: "grant-1", commonDir: join(repo, ".git"), toplevel: repo, checkCommand },
    ]);

    const { pi, gateRuns } = makePi(() => execOk("42 passing"));
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.runGate!("npm test", { agentId: "agent-1" });

    expect(checkCommand).toHaveBeenCalledTimes(1);
    expect(checkCommand).toHaveBeenCalledWith("npm test", repo);
    expect(gateRuns).toEqual([{ command: "npm test", cwd: repo }]);
    expect(result).toEqual({ ok: true, output: "42 passing" });
  });

  it("checks all active grants and blocks if any grant rejects the command", async () => {
    const allowCheck = vi.fn(() => undefined);
    const blockCheck = vi.fn(() => BLOCK_REASON);
    setStandingGrants([
      { id: "grant-no-check", commonDir: join(repo, ".git"), toplevel: repo },
      { id: "grant-allow", commonDir: join(repo, ".git"), toplevel: repo, checkCommand: allowCheck },
      { id: "grant-block", commonDir: join(repo, ".git"), toplevel: repo, checkCommand: blockCheck },
    ]);

    const { pi, gateRuns, exec } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.runGate!("git push origin main", { agentId: "agent-1" });

    expect(allowCheck).toHaveBeenCalledWith("git push origin main", repo);
    expect(blockCheck).toHaveBeenCalledWith("git push origin main", repo);
    expect(exec).not.toHaveBeenCalled();
    expect(gateRuns).toEqual([]);
    expect(result).toEqual({ ok: false, output: BLOCK_REASON });
  });

  it("fails closed when a grant's checkCommand throws", async () => {
    setStandingGrants([
      {
        id: "grant-throws",
        commonDir: join(repo, ".git"),
        toplevel: repo,
        checkCommand: () => {
          throw new Error("parser crash");
        },
      },
    ]);

    const { pi, gateRuns, exec } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.runGate!("echo ok", { agentId: "agent-1" });

    expect(exec).not.toHaveBeenCalled();
    expect(gateRuns).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("parser crash");
  });

  it("preserves normal gate execution when no standing-approval grant is active", async () => {
    const { pi, gateRuns } = makePi((command) =>
      command === "fail-cmd" ? execFail("test failed") : execOk("all green"),
    );
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const okResult = await host.runGate!("git push origin main", { agentId: "agent-1" });
    const failResult = await host.runGate!("fail-cmd", { agentId: "agent-1" });

    expect(okResult).toEqual({ ok: true, output: "all green" });
    expect(failResult).toEqual({ ok: false, output: "test failed" });
    expect(gateRuns).toEqual([
      { command: "git push origin main", cwd: repo },
      { command: "fail-cmd", cwd: repo },
    ]);
    // Reading the contract when absent should not allocate the global symbol.
    expect(STANDING_APPROVAL_KEY in (globalThis as Record<symbol, unknown>)).toBe(false);
  });

  it("preserves normal gate execution when the standing-approval registry has an empty grants map", async () => {
    setStandingGrants([]);

    const { pi, gateRuns } = makePi(() => execOk("ran"));
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.runGate!("git push origin main", { agentId: "agent-1" });

    expect(result).toEqual({ ok: true, output: "ran" });
    expect(gateRuns).toEqual([{ command: "git push origin main", cwd: repo }]);
  });
});
