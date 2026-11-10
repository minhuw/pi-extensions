import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A steer after `lookupStreak` direct lookups in a row, and once when the context is `contextShare` percent full. */
export const COACH = { lookupStreak: 5, contextShare: 50 } as const;

/** Not "boom": boom's own state reads its "boom" messages to tell what the model was told. */
const ENTRY = "boom-coach";
const LOOKUPS = new Set(["read", "grep", "find", "ls", "ffgrep", "fffind", "bash"]);
const DELEGATIONS = new Set(["Agent", "SubagentWorkflow", "herder_step", "herder_workflow"]);

export const streakText = (count: number) => `Boom mode: you made ${count} direct lookups in a row. Hand the rest of this exploration to recon agents, several in parallel, and keep your context for planning, integration, and review.`;
export const contextText = (percent: number) => `Boom mode: your context is ${percent}% full. Delegate the remaining investigation and implementation to background agents and keep only their summaries.`;

/**
 * Hidden steers toward delegation while boom mode is on, sent only into a streaming run: they never start a turn, and
 * appended messages leave the cached prefix intact. `isOn` tells whether boom mode applies to the session and branch.
 */
export function registerCoach(pi: ExtensionAPI, isOn: (ctx: ExtensionContext) => boolean): void {
	let streak = 0;
	let nudged = false;

	function steer(ctx: ExtensionContext, content: string): void {
		if (ctx.isIdle()) return;
		try { pi.sendMessage({ customType: ENTRY, content, display: false }, { deliverAs: "steer" }); } catch {}
	}

	pi.on("session_start", () => {
		streak = 0;
		nudged = false;
	});
	pi.on("session_tree", () => { streak = 0; });
	pi.on("session_compact", () => { nudged = false; });

	// The session's own calls only: calls made by another tool, such as a codemode script, carry `parentToolCallId`.
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.parentToolCallId !== undefined) return;
		const lookup = LOOKUPS.has(event.toolName);
		// Other tools, such as edit and write, neither count nor break the streak.
		if (!lookup && !DELEGATIONS.has(event.toolName)) return;
		if (!lookup || !isOn(ctx)) {
			streak = 0;
			return;
		}
		if (++streak < COACH.lookupStreak) return;
		steer(ctx, streakText(streak));
		streak = 0;
	});

	pi.on("turn_end", (event, ctx) => {
		// Only before a turn that follows anyway: a steer after the final turn would make one more request.
		if (nudged || event.toolResults.length === 0) return;
		const percent = ctx.getContextUsage()?.percent;
		if (percent == null || percent < COACH.contextShare || !isOn(ctx)) return;
		nudged = true;
		steer(ctx, contextText(Math.floor(percent)));
	});
}
