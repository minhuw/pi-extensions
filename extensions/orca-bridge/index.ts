import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Activities } from "./activity.ts";
import { activate, ManagedRelay, type Activation } from "./compatibility.ts";
import { endpoint, HookTransport, sessionMetadata } from "./transport.ts";
import { Titles } from "./titles.ts";
import { registerNavigationCommands } from "./navigation.ts";

export default function orcaBridge(pi: ExtensionAPI): void {
	const activities = new Activities();
	const titles = new Titles();
	registerNavigationCommands(pi);
	const subscriptions: Array<() => void> = [];
	let activation: Activation = { mode: "inactive", reason: "session has not started" };
	let ctx: ExtensionContext | undefined;
	let transport: HookTransport | undefined;
	let relay: ManagedRelay | undefined;
	let started = false;
	let replaying = false;
	let disposed = false;
	let parent = false;
	let promptDepth = 0;
	let previousBusy = false;
	let previousPrompt = false;
	let postedStatus = false;
	let shutdown: Promise<void> | undefined;
	let managedRootHeld = false;
	let managedPromptOwned = false;
	let supplementalPrompt = false;
	let relaying = false;
	let managedRefreshQueued = false;

	function foreignCount(): number {
		const count = relay?.foreignCount() ?? 0;
		// Orca's lexical turn flag outlives parent settlement while any child holds it.
		if (!parent && !activities.size && !count) managedRootHeld = false;
		return count;
	}

	function reconcile(): void {
		if (!started || replaying || disposed) return;
		const rows = activities.entries();
		if (activation.mode === "inactive") return;
		const prompt = promptDepth > 0;
		relaying = true;
		try { relay?.sync(rows); }
		finally { relaying = false; }
		const busy = parent || rows.length > 0 || foreignCount() > 0;
		if (activation.mode === "managed") {
			if (prompt && !previousPrompt) managedPromptOwned = managedRootHeld;
			// A child-only run never sets Orca's lexical piTurnInFlight flag. Keep
			// prompt ownership through the matching close, even if children finish.
			if (prompt && !managedPromptOwned && (busy || supplementalPrompt)) {
				supplementalPrompt = true;
				// Reassert after child deltas: managed child hooks otherwise report work
				// (or completion) without knowing that this dialog is still open.
				transport?.post({ hook_event_name: "ui_prompt_start", ui_prompt_active: true });
			} else if (!prompt && supplementalPrompt) {
				supplementalPrompt = false;
				transport?.post({ hook_event_name: "ui_prompt_end", ui_prompt_active: false, is_idle: !busy });
			}
			if (!prompt) managedPromptOwned = false;
		} else if (transport && (busy !== previousBusy || prompt !== previousPrompt)) {
			const event = prompt !== previousPrompt ? prompt ? "ui_prompt_start" : "ui_prompt_end" : busy ? "agent_start" : "agent_end";
			postedStatus = true;
			transport.post({ hook_event_name: event, ui_prompt_active: prompt, ...(event === "ui_prompt_end" ? { is_idle: !busy } : {}) });
		}
		previousBusy = busy;
		previousPrompt = prompt;
		titles.update(ctx, { managed: activation.mode === "managed", parent, prompt, labels: rows.map(row => row.label), foreignCount });
	}

	// Defer until all managed bus receivers have updated the roster, regardless of
	// factory order. One queued refresh bounds bursts; our own relays reconcile here.
	for (const channel of ["task:subagent:lifecycle", "subagent:async-started", "subagent:async-complete", "subagent:process-terminal"]) {
		subscriptions.push(pi.events.on(channel, () => {
			if (disposed || !relay || relaying) return;
			// Observe gaps between completion/start events before coalescing. Depending
			// on factory order, either callback can see the now-empty managed roster.
			foreignCount();
			if (managedRefreshQueued) return;
			managedRefreshQueued = true;
			queueMicrotask(() => { managedRefreshQueued = false; reconcile(); });
		}));
	}

	subscriptions.push(pi.events.on("pi-extensions:activity", value => {
		if (!disposed && activities.update(value)) reconcile();
	}));
	subscriptions.push(pi.on("session_start", (_event, context) => {
		if (disposed || started) return;
		ctx = context;
		activation = context.mode === "rpc"
			? { mode: "inactive", reason: "background activity is unsupported by stock Orca native chat; terminal hooks are disabled" }
			: activate();
		started = true;
		if (activation.mode === "managed") relay = new ManagedRelay((channel, value) => pi.events.emit(channel, value));
		if (activation.mode !== "inactive") transport = new HookTransport(() => sessionMetadata(ctx));
		// All factories have run. Listen before asking producers to replay, and apply
		// synchronous replies together with any snapshots captured during loading.
		replaying = true;
		try { pi.events.emit("pi-extensions:activity-request", { consumer: "orca-bridge" }); }
		catch { /* An unrelated replay listener must not prevent activation. */ }
		finally { replaying = false; }
		reconcile();
	}));
	subscriptions.push(pi.on("agent_start", (_event, context) => {
		if (disposed) return;
		ctx = context; parent = true; managedRootHeld = true; reconcile();
	}));
	// agent_end can precede retry, compaction or queued continuations in modern Pi.
	subscriptions.push(pi.on("agent_settled", (_event, context) => {
		if (disposed) return;
		ctx = context; parent = false; reconcile();
	}));
	subscriptions.push(pi.on("ui_prompt_start", (_event, context) => {
		if (disposed) return;
		ctx = context; promptDepth++; if (promptDepth === 1) reconcile();
	}));
	subscriptions.push(pi.on("ui_prompt_end", (_event, context) => {
		if (disposed) return;
		ctx = context;
		if (promptDepth && --promptDepth === 0) reconcile();
	}));
	subscriptions.push(pi.on("session_shutdown", () => {
		if (shutdown) return shutdown;
		disposed = true;
		titles.close();
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
		relay?.close();
		activities.clear();
		const final = activation.mode === "standalone" && postedStatus
			? { hook_event_name: "agent_end", session_boundary: true, ui_prompt_active: false }
			: supplementalPrompt
				? { hook_event_name: "ui_prompt_end", ui_prompt_active: false, is_idle: !(parent || foreignCount() > 0) }
				: undefined;
		parent = false;
		promptDepth = 0;
		previousBusy = false;
		previousPrompt = false;
		shutdown = (async () => {
			try { await transport?.close(final); }
			finally {
				if (activation.mode !== "inactive") activation.release();
				activation = { mode: "inactive", reason: "session shut down" };
				ctx = undefined;
			}
		})();
		return shutdown;
	}));

	pi.registerCommand("orca-status", {
		description: "Show Orca bridge mode, activity and redacted delivery status",
		handler: async (_args, context) => {
			const coords = endpoint();
			const mode = activation.mode === "inactive" ? `inactive (${activation.reason})` : activation.mode;
			const rows = activities.entries();
			const report = [
				`Orca bridge: ${mode}`,
				`Endpoint: ${coords ? `ready (127.0.0.1:${coords.port}/hook/pi)` : "unavailable"}`,
				...(context.mode === "rpc" ? ["RPC mode: background activity reporting is unavailable in stock Orca native chat"] : []),
				`Main: ${parent ? 1 : 0}; background: ${rows.length}; prompts: ${promptDepth}${relay ? `; external: ${foreignCount()}` : ""}`,
				...rows.map(row => `- ${row.source}/${row.id}: ${row.label}`),
				`Last HTTP: ${transport?.lastResult === "not sent" && relay ? "managed by Orca (supplemental prompts not sent)" : transport?.lastResult ?? "not sent"}`,
			].join("\n");
			try { context.ui.notify(report, "info"); } catch { /* stale/noninteractive UI */ }
		},
	});
}
