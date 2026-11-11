// Process manager for long-lived commands (dev servers, watchers) and one-shot background jobs, whose events wake the
// agent. The substrate (src/manager.ts) imports nothing from Pi; src/extension.ts wires it into Pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProcesses } from "./src/extension.ts";
import { createProcessManager } from "./src/manager.ts";

export default function processes(pi: ExtensionAPI): void {
	registerProcesses(pi, createProcessManager);
}
