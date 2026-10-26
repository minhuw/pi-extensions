// Real pi sessions in this suite read settings from the agent dir and install the packages listed
// there, so each test file gets an empty one instead of the developer's ~/.pi/agent. Tests that set
// PI_CODING_AGENT_DIR themselves restore this value afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "subagents-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => rmSync(agentDir, { recursive: true, force: true }));
