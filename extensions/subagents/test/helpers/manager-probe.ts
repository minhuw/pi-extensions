import { afterEach, beforeEach, vi } from "vitest";
import type { AgentManager } from "../../src/agent-manager.js";

const probe = vi.hoisted(() => ({ managers: [] as AgentManager[] }));

// Observe real managers without restoring upstream's unrestricted global API.
vi.mock("../../src/agent-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent-manager.js")>();
  return {
    ...actual,
    AgentManager: class extends actual.AgentManager {
      constructor(...args: ConstructorParameters<typeof actual.AgentManager>) {
        super(...args);
        probe.managers.push(this);
      }
    },
  };
});

export function nextManager() {
  const index = probe.managers.length;
  return () => probe.managers[index];
}

export const rootManager = (): AgentManager | undefined => probe.managers[0];

beforeEach(() => { probe.managers.length = 0; });
afterEach(async () => {
  await Promise.all(probe.managers.map(manager => manager.dispose()));
  probe.managers.length = 0;
});
