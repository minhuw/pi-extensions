// The local host replaces upstream's unrestricted manager registry. Keep the
// cross-activation and forged-capability regression guards at this boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSubagentHost } from "../src/host-registry.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ctx, hermeticDir, makePi, type Hermetic } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js"),
  runAgent: vi.fn(),
}));
import { runAgent } from "../src/agent-runner.js";

let env: Hermetic;
let activations: ReturnType<typeof makePi>[];
beforeEach(() => {
  env = hermeticDir({ settings: { schedulingEnabled: false } });
  activations = [];
  delete (globalThis as any)[Symbol.for("pi-subagents:host")];
  vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
});
afterEach(async () => {
  for (const activation of activations.reverse()) await activation.lifecycle.get("session_shutdown")?.({}, ctx());
  delete (globalThis as any)[Symbol.for("pi-subagents:host")];
  env.restore();
  vi.clearAllMocks();
});
async function boot() {
  const activation = makePi();
  activations.push(activation);
  subagentsExtension(activation.pi);
  await activation.lifecycle.get("session_start")?.({ reason: "startup" }, ctx());
  return activation;
}
const request = () => ({ type: "worker", prompt: "go", description: "host test", isolated: true as const, cwd: env.dir });

describe("local host registry lifecycle", () => {
  it("registers only after session_start; a child cannot replace or release the root", async () => {
    const root = makePi();
    activations.push(root);
    subagentsExtension(root.pi);
    expect(getSubagentHost()).toBeUndefined();
    await root.lifecycle.get("session_start")?.({ reason: "startup" }, ctx());
    const host = getSubagentHost();
    expect(host).toBeDefined();
    expect((globalThis as any)[Symbol.for("pi-subagents:manager")]).toBeUndefined();
    const child = await boot();
    expect(getSubagentHost()).toBe(host);
    await child.lifecycle.get("session_shutdown")?.({}, ctx());
    expect(getSubagentHost()).toBe(host);
    await root.lifecycle.get("session_shutdown")?.({}, ctx());
    expect(getSubagentHost()).toBeUndefined();
  });

  it("exposes the local fleet without mutation or interactive control capabilities", async () => {
    await boot();
    const host = getSubagentHost()!;
    expect(host.describeTypes().map(type => type.name)).toEqual(["recon", "worker", "reviewer", "expert"]);
    expect(host.resolveType("RECON")).toMatchObject({ name: "recon", readOnly: true });
    expect(host.resolveType("worker")).toMatchObject({ readOnly: false });
    expect(host.resolveType("expert")).toMatchObject({
      name: "expert", displayName: "Expert", readOnly: true,
      builtinToolNames: ["read", "bash", "grep", "find", "ls"],
    });
    for (const capability of ["spawn", "abort", "steer", "getRecord"]) expect(host).not.toHaveProperty(capability);
  });

  it("rejects unknown types and non-isolated requests before spawning", async () => {
    const root = await boot();
    const host = getSubagentHost()!;
    await expect(host.spawnAndWait(root.pi, ctx(), { ...request(), type: "missing" })).rejects.toThrow("Unknown or disabled");
    await expect(host.spawnAndWait(root.pi, ctx(), { ...request(), isolated: false } as any)).rejects.toThrow("isolated: true");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects frontmatter that would disable mandatory host isolation", async () => {
    const root = await boot();
    registerAgents(new Map([["unisolated", {
      ...getAgentConfig("worker")!, name: "unisolated", isolated: false,
    }]]));
    await expect(getSubagentHost()!.spawnAndWait(root.pi, ctx(), {
      ...request(), type: "unisolated",
    })).rejects.toThrow("cannot satisfy the host's mandatory isolation");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each([
    { parentAgentId: "forged", depth: 99, rootSessionId: "forged" },
    { configCwd: "/forged", outputDir: "/forged" },
    { sessionFile: "/forged/session.jsonl" },
    { reclaimHandle: "stolen" },
  ])("does not forward forged internal capabilities: %j", async (forged) => {
    const root = await boot();
    await getSubagentHost()!.spawnAndWait(root.pi, ctx(), { ...request(), ...forged } as any);
    const options = vi.mocked(runAgent).mock.calls.at(-1)![3];
    for (const [key, value] of Object.entries(forged)) expect((options as any)[key]).not.toBe(value);
    expect(options).toMatchObject({ isolated: true, inheritContext: false });
  });
});
