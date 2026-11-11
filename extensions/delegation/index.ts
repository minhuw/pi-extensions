import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCoach } from "./coach.ts";
import { registerSwarm } from "./swarm.ts";

/** `/swarm`: background-agent coordination on a cache-safe switch, on by default, with a coach for context and stalled agents. */
export default function delegationExtension(pi: ExtensionAPI): void {
	const isSwarmOn = registerSwarm(pi);
	registerCoach(pi, isSwarmOn);
}
