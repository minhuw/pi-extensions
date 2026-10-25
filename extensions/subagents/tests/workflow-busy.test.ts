import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/workflow/runtime.js", async () => ({
  ...await vi.importActual<typeof import("../src/workflow/runtime.js")>("../src/workflow/runtime.js"),
  runWorkflow: vi.fn(),
}));
vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js"),
  runAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { getSubagentHost } from "../src/host-registry.js";
import subagentsExtension, { WORKFLOW_FILE_FLAG } from "../src/index.js";
import { runWorkflow } from "../src/workflow/runtime.js";
import { ctx, flush, hermeticDir, makePi, textOf, type Hermetic } from "../test/helpers/boot-extension.js";

const script = 'export const meta = { name: "busy-test", description: "lease regression" }; return "done";';
let env: Hermetic;
let activations: ReturnType<typeof makePi>[];
let runs: { signal: AbortSignal; finish(status?: "completed" | "failed" | "killed"): void; fail(): void }[];
let snapshots: { source: string; activities: { id: string; label: string }[] }[];
const context = () => ctx({ mode: "print", isIdle: () => true });
const busy = () => snapshots.at(-1)!.activities.length !== 0;

beforeEach(() => {
  env = hermeticDir({ settings: { workflowsEnabled: true, schedulingEnabled: false, widgetMode: "off", fleetView: false } });
  activations = [];
  snapshots = [];
  runs = [];
  vi.mocked(runWorkflow).mockImplementation(options => new Promise((resolve, reject) => {
    runs.push({
      signal: options.signal!,
      finish: (status = "completed") => resolve({ status, meta: { name: "busy-test" }, agentCount: 0, replayedCount: 0 } as any),
      fail: () => reject(new Error("startup failed")),
    });
  }));
});

afterEach(async () => {
  for (const activation of activations.reverse()) await activation.lifecycle.get("session_shutdown")?.({}, context());
  for (const run of runs) run.finish("killed");
  await flush();
  env.restore();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function activate(flags = {}) {
  const activation = makePi(flags);
  activations.push(activation);
  activation.pi.events.emit.mockImplementation((channel: string, value: any) => {
    if (channel === "pi-extensions:activity") snapshots.push(value);
  });
  // Pi dispatches every registered handler, not just the last one for an event.
  activation.pi.on.mockImplementation((event: string, handler: (...args: any[]) => any) => {
    const prior = activation.lifecycle.get(event);
    activation.lifecycle.set(event, prior ? async (...args: any[]) => {
      await prior(...args);
      return handler(...args);
    } : handler);
  });
  subagentsExtension(activation.pi);
  return activation;
}
async function boot(flags = {}) {
  const activation = activate(flags);
  await activation.lifecycle.get("session_start")({}, context());
  return activation;
}
async function start(activation: ReturnType<typeof makePi>) {
  return activation.tools.get("SubagentWorkflow").execute("workflow-call", { script }, undefined, undefined, context());
}

describe("workflow activity publication", () => {
  it.each(["completed", "failed", "killed"] as const)("holds a workflow-only headless run until %s", async status => {
    const activation = await boot();
    expect(busy()).toBe(false);
    await start(activation);
    expect(runs).toHaveLength(1);
    expect(busy()).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
    // UI visibility and parent settlement must not clear a workflow-only lease.
    await activation.lifecycle.get("agent_settled")({}, context());
    expect(snapshots.at(-1)?.source).toBe("subagents");
    expect(busy()).toBe(true);
    runs[0].finish(status);
    await flush();
    expect(busy()).toBe(false);
  });

  it("releases on a runtime rejection before any child starts", async () => {
    const activation = await boot();
    await start(activation);
    runs[0].fail();
    await flush();
    expect(busy()).toBe(false);
  });

  it("does not release another active workflow when one finishes", async () => {
    const activation = await boot();
    await start(activation);
    await start(activation);
    const ids = snapshots.at(-1)!.activities.map(row => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    runs[0].finish();
    await flush();
    expect(snapshots.at(-1)!.activities.map(row => row.id)).toEqual([ids[1]]);
    expect(busy()).toBe(true);
    runs[1].finish();
    await flush();
    expect(busy()).toBe(false);
  });

  it.each([false, true])("keeps the lease until both an agent and workflow finish (workflow first=%s)", async workflowFirst => {
    const activation = await boot();
    let finish!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await activation.tools.get("Agent").execute("agent-call", {
      prompt: "work", description: "ordinary", subagent_type: "worker", run_in_background: true,
    }, undefined, undefined, context());
    await start(activation);
    expect(busy()).toBe(true);
    const finishAgent = () => finish({ responseText: "done", aborted: false, steered: false });
    if (workflowFirst) runs[0].finish();
    else finishAgent();
    await flush();
    expect(busy()).toBe(true);
    if (workflowFirst) finishAgent();
    else runs[0].finish();
    await flush();
    expect(busy()).toBe(false);
  });

  it("replays current activity for a bridge that starts after the producer", async () => {
    const activation = await boot();
    await start(activation);
    const request = activation.pi.events.on.mock.calls.find(([channel]: [string]) => channel === "pi-extensions:activity-request")![1];
    const latest = snapshots.at(-1);
    snapshots = [];
    request({ consumer: "orca-bridge" });
    expect(snapshots).toEqual([latest]);
  });

  it("represents fleets larger than the bridge snapshot bound with a counted overflow", async () => {
    const activation = await boot();
    const list = vi.spyOn(AgentManager.prototype, "listAgents").mockReturnValue(
      Array.from({ length: 140 }, (_, index) => ({ id: String(index), status: "running" } as any)),
    );
    const request = activation.pi.events.on.mock.calls.find(([channel]: [string]) => channel === "pi-extensions:activity-request")![1];
    request({});
    expect(snapshots.at(-1)!.activities).toHaveLength(128);
    expect(snapshots.at(-1)!.activities.at(-1)).toEqual({ id: "overflow", label: "13 more activities" });
    list.mockReturnValue([]);
    request({});
    expect(busy()).toBe(false);
  });

  it("claims startup workflow activity only after the host owns session_start", async () => {
    const path = join(env.dir, "startup.js");
    writeFileSync(path, script);
    const activation = activate({ [WORKFLOW_FILE_FLAG]: path });
    expect(snapshots).toHaveLength(0);
    expect(runWorkflow).not.toHaveBeenCalled();
    await activation.lifecycle.get("session_start")({}, context());
    expect(getSubagentHost()).toBeDefined();
    expect(busy()).toBe(true);
    runs[0].finish();
    await flush();
    expect(busy()).toBe(false);
  });

  it("a second activation cannot clear the root lease or release its host", async () => {
    const root = await boot();
    await start(root);
    const host = getSubagentHost();
    const calls = snapshots.length;
    const child = await boot();
    await child.lifecycle.get("agent_settled")({}, context());
    await child.lifecycle.get("session_shutdown")({}, context());
    expect(getSubagentHost()).toBe(host);
    expect(snapshots).toHaveLength(calls);
    expect(busy()).toBe(true);
  });

  it.each([false, true])("shutdown aborts and releases, with no late notifications (startup=%s)", async startup => {
    const path = join(env.dir, "startup.js");
    writeFileSync(path, script);
    const activation = await boot(startup ? { [WORKFLOW_FILE_FLAG]: path } : {});
    if (!startup) await start(activation);
    expect(busy()).toBe(true);
    await activation.lifecycle.get("session_shutdown")({}, context());
    expect(runs[0].signal.aborted).toBe(true);
    expect(busy()).toBe(false);
    expect(getSubagentHost()).toBeUndefined();
    const calls = snapshots.length;
    runs[0].finish("killed");
    await flush();
    expect(snapshots).toHaveLength(calls);
    expect(activation.pi.sendMessage).not.toHaveBeenCalled();
    expect(activation.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("keeps external-owned agents outside the lease and public resume/detach controls", async () => {
    const activation = await boot();
    let finish!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const spawn = vi.spyOn(AgentManager.prototype, "spawnAndWait");
    const pending = getSubagentHost()!.spawnAndWait(activation.pi, context(), {
      type: "worker", description: "owned", prompt: "work", isolated: true, cwd: env.dir,
      metadata: { owner: "herder" },
    });
    await flush();
    const manager = spawn.mock.contexts[0] as AgentManager;
    const record = manager.listAgents()[0];
    expect(record.owner).toBe("herder");
    expect(busy()).toBe(false);
    expect(manager.sendToBackground(record.id)).toBe(false);
    for (const background of [false, true]) {
      const result = await activation.tools.get("Agent").execute("resume", {
        prompt: "continue", description: "resume", subagent_type: "worker",
        resume: record.id, run_in_background: background,
      }, undefined, undefined, context());
      expect(textOf(result)).toContain("not found");
    }
    for (const name of ["get_subagent_result", "steer_subagent"]) {
      const result = await activation.tools.get(name).execute("control", { agent_id: record.id, message: "steer" }, undefined, undefined, context());
      expect(textOf(result)).toContain("not found");
    }
    finish({ responseText: "done", aborted: false, steered: false });
    await pending;
  });
});
