import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const ENTRY = "boom";
const SESSION_LINK_TYPE = "pi-extensions.session-link";
const STATUS = "💥 boom";
const ON_PREFIX = "Boom mode 💥 is on";
const ON_TEXT = `${ON_PREFIX}: the user wants maximum development speed and explicitly opts in to background agents and, when available, SubagentWorkflow. `
	+ "Work as an orchestrator: split each task into independent pieces and launch them together in one message, recon for any lookup beyond one known file and worker for implementation, tests, and verification. "
	+ 'Give concurrent writers isolation: "worktree" when their files could overlap, and apply the branches they report. '
	+ "Run agents in the background while you have other work, and keep your own context for planning, integration, and review. "
	+ "Use direct tools only for a known target or a short sequential edit. Check agents' changes before reporting them. This overrides more conservative subagent guidance.";
const OFF_TEXT = "Boom mode is off. Ignore earlier boom mode instructions: the user no longer opts in to background agents or SubagentWorkflow, and the standard subagent guidance applies.";
const SECTION_TEXT = `${ON_TEXT} A later boom mode message overrides this.`;

/** The pin, written once at a branch's first run, or a switch. */
type BoomEntry = { base: boolean } | { active: boolean };

interface BoomState {
	/** The pin: undefined until the session's first run, true when the section carries boom mode. */
	base: boolean | undefined;
	/** Whether the current branch holds the pin. `/tree` can move to before it. */
	pinned: boolean;
	active: boolean;
	/** What the model was last told on this branch: the latest boom message, else the section. */
	told: boolean;
}

const hidden = (content: string) => ({ message: { customType: ENTRY, content, display: false } });
const isPin = (entry: SessionEntry): entry is CustomEntry<{ base: boolean }> => entry.type === "custom" && entry.customType === ENTRY && "base" in (entry.data as BoomEntry);
const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

/** The boom state of the current branch. */
function readBranch(ctx: ExtensionContext): BoomState {
	let pin: boolean | undefined;
	let active: boolean | undefined;
	let told: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		// What the latest message said, not which switch it followed: a run already starting can land its message after a later switch.
		if (entry.type === "custom_message" && entry.customType === ENTRY && typeof entry.content === "string") told = entry.content.startsWith(ON_PREFIX);
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = entry.data as BoomEntry;
		if ("base" in data) pin = data.base;
		else active = data.active;
	}
	// Off the branch only for this: a session's first run fixes its prompt on every branch, even one that leaves before the pin.
	const base = pin ?? ctx.sessionManager.getEntries().find(isPin)?.data?.base;
	return { base, pinned: pin !== undefined, active: active ?? base ?? false, told: told ?? base ?? false };
}

/**
 * Top-level TUI and RPC sessions. Live children bind extensions with no mode, which Pi runs as print, and persisted
 * children carry a session link when child-session hooks are registered. `parentSession` cannot identify a child: Pi
 * also sets it on forks.
 */
function isEligible(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;
	return !ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
}

function setStatus(ctx: ExtensionContext, active: boolean): void {
	try { ctx.ui.setStatus(ENTRY, active ? STATUS : undefined); } catch {}
}

/** `/boom`: subagent-first orchestration, in the section from a session's start or by hidden per-run messages after it. */
export default function boomExtension(pi: ExtensionAPI): void {
	function writePin({ base, active }: BoomState, ctx: ExtensionContext): void {
		// The pin holds across the session, so conversation on any branch counts: such a prefix may be cached and never gains a section.
		const pinned = base ?? (active && !ctx.sessionManager.getEntries().some(isConversation));
		pi.appendEntry<BoomEntry>(ENTRY, { base: pinned });
	}

	async function showBranch(_event: unknown, ctx: ExtensionContext): Promise<void> {
		if (isEligible(ctx)) setStatus(ctx, readBranch(ctx).active);
	}

	pi.on("session_start", showBranch);
	pi.on("session_tree", showBranch);

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isEligible(ctx)) return undefined;
		let state = readBranch(ctx);
		if (!state.pinned) {
			writePin(state, ctx);
			state = readBranch(ctx);
		}
		// Set on every run: Pi diffs each run's sections against the transcript, so a missing one would be removed.
		if (state.base) event.systemPromptOptions.sections.boom = SECTION_TEXT;
		// Repeated while the switch differs from the section, so a compaction cannot drop it for long.
		if (state.active !== state.base || state.told !== state.active) return hidden(state.active ? ON_TEXT : OFF_TEXT);
		return undefined;
	});

	pi.registerCommand("boom", {
		description: "Toggle boom mode 💥, subagent-first development: /boom [on | off | status]",
		handler: async (args, ctx) => {
			if (!isEligible(ctx)) {
				ctx.ui.notify("/boom works only in top-level TUI and RPC sessions.", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			const { active } = readBranch(ctx);
			if (action === "status") {
				ctx.ui.notify(active ? "Boom mode 💥 is on." : "Boom mode is off.", "info");
				return;
			}
			if (!["", "on", "off"].includes(action)) {
				ctx.ui.notify("Usage: /boom [on | off | status]", "warning");
				return;
			}
			const next = action === "" ? !active : action === "on";
			if (next !== active) pi.appendEntry<BoomEntry>(ENTRY, { active: next });
			setStatus(ctx, next);
			if (next === active) ctx.ui.notify(next ? "Boom mode 💥 is already on." : "Boom mode is already off.", "info");
			else ctx.ui.notify(next
				? "Boom mode 💥 on: the model fans work out to subagents, background agents included. Takes effect with the next prompt; usage may increase."
				: "Boom mode off. Takes effect with the next prompt.", "info");
		},
	});
}
