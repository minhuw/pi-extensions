import type { AgentRunner, OutputStore } from "../types.ts";

export interface PiRunnerOptions { outputs?: OutputStore }

/** The production `AgentRunner`: one `createAgentSession` per attempt. */
export function createPiAgentRunner(options: PiRunnerOptions): AgentRunner { throw new Error("not implemented"); }
