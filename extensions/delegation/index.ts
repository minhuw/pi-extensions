import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBoard } from "./board.ts";
import { registerCoach } from "./coach.ts";
import { registerSwarm } from "./swarm.ts";

/** `/swarm`: background-agent coordination on a cache-safe switch, on by default, with a coach for context and stalled agents and a board shared with subagents. */
export default function delegationExtension(pi: ExtensionAPI): void {
	const isSwarmOn = registerSwarm(pi);
	// Restore the board before the coach seeds known blockers on session_start and session_tree.
	registerBoard(pi, isSwarmOn);
	registerCoach(pi, isSwarmOn);
}
