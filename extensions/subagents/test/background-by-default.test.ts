// Local foreground default, with explicit and configured background opt-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { hermeticDir, type Hermetic } from "./helpers/boot-extension.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

const settled = (text: string) =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  } as any);

function spawn(tools: Map<string, any>, params: Record<string, unknown> = {}) {
  return tools.get("Agent").execute(
    "tc",
    { prompt: "go", description: "d", subagent_type: "worker", ...params },
    undefined,
    undefined,
    ctx(),
  );
}

describe("backgroundByDefault", () => {
  let env: Hermetic;
  beforeEach(() => { env = hermeticDir(); });
  afterEach(() => { env.restore(); vi.clearAllMocks(); });

  it("returns output inline by default", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");
    expect(textOf(await spawn(tools))).toContain("THE-PAYLOAD");
  });
  it("returns an agent ID when backgroundByDefault is enabled", async () => {
    env.restore();
    env = hermeticDir({ settings: { backgroundByDefault: true } });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools));

    expect(out).toContain("Agent ID:");
    // The whole point of backgrounding: the orchestrator does NOT get the
    // output here — it arrives later as a notification preview.
    expect(out).not.toContain("THE-PAYLOAD");
  });

  it("still blocks and returns the output inline when run_in_background is false", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools, { run_in_background: false }));

    expect(out).toContain("THE-PAYLOAD");
    expect(out).not.toContain("started in background");
  });

  it("starts a six-way fan-out concurrently instead of queueing the tail", async () => {
    // Six is the shape the Agent tool description tells the model to send.
    // With maxConcurrent at its old 4 this queued two of them.
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    // Never settles — every agent stays occupying its slot for the whole test.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const outs: string[] = [];
    for (let i = 0; i < 6; i++) outs.push(textOf(await spawn(tools, { run_in_background: true })));

    expect(outs).toHaveLength(6);
    for (const out of outs) expect(out).not.toContain("queued");
  });
});
