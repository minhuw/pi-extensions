import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activate, type Activation } from "./compatibility.ts";
import { registerNavigationCommands } from "./navigation.ts";
import type { BridgeStatus } from "./protocol.ts";
import { PaneStatus } from "./status.ts";
import { DaemonLink, LatestSender } from "./transport.ts";

const VERSION = "pika-node-bridge/1";

/** Reports pane status to the pika-node daemon that spawned this pi, and asks its web UI to open files or diffs. */
export default function pikaNodeBridge(pi: ExtensionAPI): void {
	const pane = new PaneStatus();
	const subscriptions: Array<() => void> = [];
	let activation: Activation = { mode: "inactive", reason: "session has not started" };
	let ctx: ExtensionContext | undefined;
	let link: DaemonLink | undefined;
	let sender: LatestSender<BridgeStatus> | undefined;
	let started = false;
	let replaying = false;
	let disposed = false;
	let shutdown: Promise<void> | undefined;

	registerNavigationCommands(pi, () => link && (request => link!.request(request)));

	function report(): void {
		if (!started || replaying || disposed || !sender) return;
		sender.post(pane.snapshot(ctx));
	}

	// Listen during factory loading so early snapshots count; replay at session_start fills in the rest.
	subscriptions.push(pi.events.on("pi-extensions:activity", value => {
		if (!disposed && pane.activities.update(value)) report();
	}));
	subscriptions.push(pi.on("session_start", (_event, context) => {
		if (disposed || started) return;
		ctx = context;
		// Live child sessions (subagents, Herder steps) bind extensions without a TUI or RPC mode.
		activation = context.mode === "tui" || context.mode === "rpc"
			? activate()
			: { mode: "inactive", reason: "not a top-level session" };
		started = true;
		if (activation.mode === "active") {
			const active = activation;
			link = new DaemonLink({ socket: active.socket, pane: active.pane, version: VERSION, onWelcome: () => report() });
			sender = new LatestSender((status, signal) => link!.writeStatus(status, signal));
			link.start();
		}
		replaying = true;
		try { pi.events.emit("pi-extensions:activity-request", { consumer: "pika-node-bridge" }); }
		catch { /* An unrelated replay listener must not prevent activation. */ }
		finally { replaying = false; }
		report();
	}));
	subscriptions.push(pi.on("session_info_changed", (_event, context) => {
		if (disposed) return;
		ctx = context; report();
	}));
	subscriptions.push(pi.on("model_select", (_event, context) => {
		if (disposed) return;
		ctx = context; report();
	}));
	subscriptions.push(pi.on("agent_start", (_event, context) => {
		if (disposed) return;
		ctx = context; pane.agentStart(); report();
	}));
	// agent_end can precede a retry, compaction, or queued continuation; only agent_settled ends the run.
	subscriptions.push(pi.on("agent_settled", (_event, context) => {
		if (disposed) return;
		ctx = context; pane.agentSettled(); report();
	}));
	subscriptions.push(pi.on("ui_prompt_start", (_event, context) => {
		if (disposed) return;
		ctx = context; pane.promptStart(); if (pane.promptDepth === 1) report();
	}));
	subscriptions.push(pi.on("ui_prompt_end", (_event, context) => {
		if (disposed) return;
		ctx = context;
		const open = pane.promptDepth > 0;
		pane.promptEnd();
		if (open && pane.promptDepth === 0) report();
	}));
	subscriptions.push(pi.on("session_shutdown", () => {
		if (shutdown) return shutdown;
		disposed = true;
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
		// The daemon keeps a closed bridge's last status, so leave it idle without activities.
		const final = sender ? pane.final(ctx) : undefined;
		pane.clear();
		// Release at once, so a replacement session in this process can take the pane.
		if (activation.mode === "active") activation.release();
		activation = { mode: "inactive", reason: "session shut down" };
		shutdown = (async () => {
			try { await sender?.close(final); }
			finally {
				link?.close();
				ctx = undefined;
			}
		})();
		return shutdown;
	}));
}
