import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Handoff {
	previousSessionFile: string | undefined;
	model: { provider: string; id: string } | undefined;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

// Pi caches extension modules for one cwd, so the replacement session can load a
// fresh copy of this module (for example after a worktree subagent loaded
// extensions elsewhere). The handoff therefore lives on globalThis.
const HANDOFF = Symbol.for("pi-extensions.molt.handoff");
const shared = globalThis as { [HANDOFF]?: Handoff };

/** `/molt`: start a new session that keeps the current model and thinking level. */
export default function moltExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		const handoff = shared[HANDOFF];
		if (event.reason !== "new" || !handoff || event.previousSessionFile !== handoff.previousSessionFile) return;
		delete shared[HANDOFF];
		let problem: string | undefined;
		const wanted = handoff.model;
		if (wanted && (ctx.model?.provider !== wanted.provider || ctx.model.id !== wanted.id)) {
			const model = ctx.modelRegistry.find(wanted.provider, wanted.id);
			if (!model) problem = `${wanted.provider}/${wanted.id} is no longer available`;
			else if (!(await pi.setModel(model))) problem = `no credentials are configured for ${wanted.provider}`;
		}
		pi.setThinkingLevel(handoff.thinkingLevel);
		const current = `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"}, thinking ${pi.getThinkingLevel()}`;
		if (problem) ctx.ui.notify(`New session started with ${current}: ${problem}.`, "warning");
		else ctx.ui.notify(`New session started with ${current}.`, "info");
	});

	pi.registerCommand("molt", {
		description: "Start a new session that keeps the current model and thinking level",
		handler: async (_args, ctx) => {
			shared[HANDOFF] = {
				previousSessionFile: ctx.sessionManager.getSessionFile(),
				model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id },
				thinkingLevel: pi.getThinkingLevel(),
			};
			try {
				await ctx.newSession();
			} finally {
				// A cancelled or failed switch must not leak into a later plain /new.
				delete shared[HANDOFF];
			}
		},
	});
}
