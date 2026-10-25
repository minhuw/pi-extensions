import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { Herder, type HerderOptions } from "./session.ts";
import { registerTools } from "./tools.ts";

/** Registers `/herder`, the `herder_*` tools, and shutdown cleanup. Starts no timers, locks, or processes. */
export function registerHerder(pi: ExtensionAPI, options: HerderOptions): Herder {
	const herder = new Herder(pi, options);
	registerCommands(pi, herder);
	registerTools(pi, herder);
	pi.on("session_shutdown", (_event, ctx) => herder.shutdown(ctx));
	return herder;
}
