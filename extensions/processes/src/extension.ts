// Wiring, with the manager factory passed in so tests can drive it with a fake. One manager serves the whole Node
// process (see state.ts); each extension instance subscribes for its session between session_start and shutdown.
import { join } from "node:path";
import { getAgentDir, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { announceChange, serveFooter } from "./footer.ts";
import { registerBash } from "./bash.ts";
import { registerBashGuard } from "./guard.ts";
import { createNotifier, MESSAGE_TYPE, type ProcessEventDetails } from "./notify.ts";
import { requireManager, sharedState } from "./state.ts";
import { registerTools } from "./tools.ts";
import type { ManagerOptions, ProcessManager } from "./types.ts";
import { registerPsCommand } from "./ui.ts";

export type CreateManager = (options: ManagerOptions) => ProcessManager;

function startManager(create: CreateManager): ProcessManager {
	const state = sharedState();
	const shell = getShellConfig();
	if (shell.commandTransport === "stdin") throw new Error(`processes: shell ${shell.shell} takes commands on stdin, which process_start does not support.`);
	const manager = create({ stateDir: join(getAgentDir(), "processes"), shell: { shell: shell.shell, args: shell.args } });
	state.manager = manager;
	if (!state.exitHookInstalled) {
		state.exitHookInstalled = true;
		// The last resort on any exit, a crash included: no process group outlives Pi.
		process.on("exit", () => sharedState().manager?.killAllSync());
	}
	return manager;
}

export function registerProcesses(pi: ExtensionAPI, create: CreateManager): void {
	const instance = Symbol("processes instance");
	let close: (() => void) | undefined;

	registerTools(pi, requireManager);
	registerPsCommand(pi, requireManager);
	registerBash(pi, requireManager);
	registerBashGuard(pi);
	pi.registerMessageRenderer<ProcessEventDetails>(MESSAGE_TYPE, (message, { expanded }, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const shown = expanded ? content : (message.details?.events.map((event) => event.text.split("\n")[0]!).join("\n") ?? content);
		return new Text(theme.fg("muted", shown), 1, 0);
	});

	pi.on("session_start", (event, ctx) => {
		const state = sharedState();
		if (!state.manager) {
			startManager(create);
			state.root = instance;
			state.handoff = false;
		} else if (state.handoff && event.reason !== "startup") {
			state.root = instance;
			state.handoff = false;
		}
		close?.();
		const sessionId = ctx.sessionManager.getSessionId();
		const notifier = createNotifier(pi, ctx, sessionId);
		const unsubscribe = state.manager!.subscribe((processEvent) => {
			if (processEvent.type === "changed") announceChange(pi.events);
			else notifier.handle(processEvent);
		});
		const stopFooter = serveFooter(pi.events, () => sharedState().manager);
		announceChange(pi.events);
		close = () => {
			unsubscribe();
			stopFooter();
			notifier.dispose();
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		close?.();
		close = undefined;
		const state = sharedState();
		if (state.root !== instance) {
			// A session that ends for good no longer collects the waits it registered.
			if (event.reason === "quit" && state.manager) {
				const sessionId = ctx.sessionManager.getSessionId();
				for (const [waitId, owner] of state.waits) {
					if (owner !== sessionId) continue;
					state.waits.delete(waitId);
					state.manager.cancelWait(waitId);
				}
			}
			return;
		}
		if (event.reason !== "quit") {
			state.handoff = true;
			return;
		}
		const manager = state.manager!;
		state.manager = undefined;
		state.root = undefined;
		state.waits.clear();
		await manager.shutdown();
	});
}
