import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerActivation } from "./activation.ts";
import { registerCommands } from "./commands.ts";
import { registerPickerTool } from "./picker.ts";
import { Herder, type HerderOptions } from "./session.ts";
import { hasStandingGrants } from "./standing.ts";
import { registerTools } from "./tools.ts";

/** Registers the `/herder*` commands, the `herder_*` tools, and shutdown cleanup. Starts no timers, locks, or processes. */
export function registerHerder(pi: ExtensionAPI, options: HerderOptions): Herder {
	const herder = new Herder(pi, options);
	registerCommands(pi, herder);
	registerTools(pi, herder);
	registerPickerTool(pi, (ctx) => (hasStandingGrants() ? herder.standing(herder.session(ctx)) : undefined));
	registerActivation(pi);
	pi.on("session_shutdown", (_event, ctx) => herder.shutdown(ctx));
	return herder;
}
