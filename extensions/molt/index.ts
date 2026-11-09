import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface Carryover {
	previousSessionFile: string | undefined;
	model: { provider: string; id: string } | undefined;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	handoff: boolean;
}

// Pi caches extension modules for one cwd, so the replacement session can load a
// fresh copy of this module (for example after a worktree subagent loaded
// extensions elsewhere). The carryover therefore lives on globalThis.
const CARRYOVER = Symbol.for("pi-extensions.molt.carryover");
const shared = globalThis as { [CARRYOVER]?: Carryover };

type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;

/** A `/handoff` between its request and the switch, in the session that wrote it. */
interface PendingHandoff {
	/** Argument of the internal `/handoff` dispatch that performs the switch. */
	token: string;
	request: string;
	started: boolean;
	document: string | undefined;
	/** The request settled with a document; the switch is queued. */
	ready: boolean;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function handoverRequest(focus: string): string {
	return [
		"Write a handover for a fresh agent that continues this work in a new session. That agent cannot see this conversation; your reply is sent to it verbatim as its first message.",
		focus ? `The new session's task: ${focus}` : "The new session continues the current work from where it stands.",
		"",
		"Before writing, check facts that may have changed and that the new agent depends on, such as git status or running jobs. Do not continue the work or change anything. Do not save the handover to a file: your reply is the handover.",
		"",
		"Address the new agent directly and include:",
		"- the goal and scope, and the user's requirements, preferences, and constraints from this conversation;",
		"- the current state: what is done and how it was verified, what is in progress, and what is still unverified, with exact paths, branches, commits, commands, hosts, and identifiers;",
		"- decisions with their reasons, and approaches that were tried and rejected;",
		"- open questions, risks, and pitfalls;",
		"- the next steps in order, and how to verify each.",
		"Leave out how the conversation went unless the next steps depend on it. Reply with the handover only, without a preamble.",
	].join("\n");
}

/** `/molt` and `/handoff`: start a new session that keeps the current model and thinking level. */
export default function moltExtension(pi: ExtensionAPI): void {
	let pending: PendingHandoff | undefined;

	pi.on("session_start", async (event, ctx) => {
		const carryover = shared[CARRYOVER];
		if (event.reason !== "new" || !carryover || event.previousSessionFile !== carryover.previousSessionFile) return;
		delete shared[CARRYOVER];
		let problem: string | undefined;
		const wanted = carryover.model;
		if (wanted && (ctx.model?.provider !== wanted.provider || ctx.model.id !== wanted.id)) {
			const model = ctx.modelRegistry.find(wanted.provider, wanted.id);
			if (!model) problem = `${wanted.provider}/${wanted.id} is no longer available`;
			else if (!(await pi.setModel(model))) problem = `no credentials are configured for ${wanted.provider}`;
		}
		pi.setThinkingLevel(carryover.thinkingLevel);
		const current = `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"}, thinking ${pi.getThinkingLevel()}`;
		const started = carryover.handoff ? "Handed off to a new session" : "New session started";
		if (problem) ctx.ui.notify(`${started} with ${current}: ${problem}.`, "warning");
		else ctx.ui.notify(`${started} with ${current}.`, "info");
	});

	/** Starts the new session, with `withSession` running in it; reports whether the switch happened. */
	async function replaceSession(ctx: ExtensionCommandContext, handoff: boolean, withSession?: NewSessionOptions["withSession"]): Promise<boolean> {
		shared[CARRYOVER] = {
			previousSessionFile: ctx.sessionManager.getSessionFile(),
			model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id },
			thinkingLevel: pi.getThinkingLevel(),
			handoff,
		};
		try {
			return !(await ctx.newSession(withSession ? { withSession } : undefined)).cancelled;
		} finally {
			// A cancelled or failed switch must not leak into a later plain /new.
			delete shared[CARRYOVER];
		}
	}

	pi.registerCommand("molt", {
		description: "Start a new session that keeps the current model and thinking level",
		handler: async (_args, ctx) => {
			await replaceSession(ctx, false);
		},
	});

	pi.on("message_end", (event) => {
		if (!pending || pending.ready) return;
		const message = event.message;
		if (message.role === "user") {
			if (!pending.started && textOf(message.content) === pending.request) pending.started = true;
		} else if (message.role === "assistant" && pending.started) {
			// Only the run's last final reply counts. Molt loads before Spokesman, so this is the
			// model's own text rather than its rewrite.
			const final = message.stopReason === "stop" && !message.content.some((part) => part.type === "toolCall");
			pending.document = (final && textOf(message.content).trim()) || undefined;
		}
	});

	pi.on("agent_settled", (event, ctx) => {
		const handoff = pending;
		if (!handoff || handoff.ready) return;
		if (!handoff.started) {
			// The request never ran (for example a provider error before the run); this run is someone else's.
			pending = undefined;
			ctx.ui.notify("The handover request did not run; staying in this session.", "warning");
		} else if (event.aborted) {
			pending = undefined;
			ctx.ui.notify("Handoff cancelled.", "info");
		} else if (!handoff.document) {
			pending = undefined;
			ctx.ui.notify("The model did not finish a handover; staying in this session.", "warning");
		} else {
			// A session switch must wait until every agent_settled handler is done. A command sent
			// from here runs after them, with a command context that can start the new session.
			handoff.ready = true;
			pi.sendUserMessage(`/handoff ${handoff.token}`, { expandPromptTemplates: true });
		}
	});

	pi.registerCommand("handoff", {
		description: "Have the model write a handover, then continue in a new session that starts from it",
		handler: async (args, ctx) => {
			const ready = pending;
			if (ready?.ready && ready.document && args.trim() === ready.token) {
				pending = undefined;
				const kickoff = `${ready.document}\n\n---\nHanded off from pi session ${ctx.sessionManager.getSessionId()}.`;
				const switched = await replaceSession(ctx, true, async (next) => {
					// Not awaited: the old session's settle must not wait for the new session's run.
					next.sendUserMessage(kickoff).catch((error: unknown) => {
						next.ui.notify(`Could not send the handover: ${error instanceof Error ? error.message : String(error)}`, "error");
					});
				});
				if (!switched) ctx.ui.notify("The new session was cancelled; the handover is the last reply in this session.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish, or press Escape, before /handoff.", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("Select a model before /handoff.", "error");
				return;
			}
			if (!ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) {
				ctx.ui.notify("Nothing to hand off yet; /molt starts an empty session.", "warning");
				return;
			}
			const request = handoverRequest(args.trim());
			pending = { token: randomUUID(), request, started: false, document: undefined, ready: false };
			ctx.ui.notify("Writing the handover; Pi continues in a new session when it is done.", "info");
			pi.sendUserMessage(request);
		},
	});
}
