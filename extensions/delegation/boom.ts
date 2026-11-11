import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCoach } from "./coach.ts";
import { registerMode } from "./switch.ts";

const ON_PREFIX = "Boom mode 💥 is on";
const ON_TEXT = `${ON_PREFIX}: the user wants maximum development speed and explicitly opts in to background agents and, when available, SubagentWorkflow. `
	+ "Work as an orchestrator: split each task into independent pieces and launch them together in one message, recon for any lookup beyond one known file and worker for implementation, tests, and verification. "
	+ 'Give concurrent writers isolation: "worktree" when their files could overlap, and apply the branches they report. '
	+ "Run agents in the background while you have other work, and keep your own context for planning, integration, and review. "
	+ "Use direct tools only for a known target or a short sequential edit. Check agents' changes before reporting them. This overrides more conservative subagent guidance.";
const OFF_PREFIX = "Boom mode is off";

/** `/boom`: subagent-first orchestration, with a coach that steers the model back to delegating. */
export function registerBoom(pi: ExtensionAPI): void {
	const isOn = registerMode(pi, {
		name: "boom",
		description: "Toggle boom mode 💥, subagent-first development: /boom [on | off | status]",
		status: "💥 boom",
		onPrefix: ON_PREFIX,
		onText: ON_TEXT,
		offPrefix: OFF_PREFIX,
		offText: `${OFF_PREFIX}. Ignore earlier boom mode instructions: the user no longer opts in to background agents or SubagentWorkflow, and the standard subagent guidance applies.`,
		sectionText: `${ON_TEXT} A later boom mode message overrides this.`,
		notes: {
			isOn: "Boom mode 💥 is on.",
			isOff: "Boom mode is off.",
			on: "Boom mode 💥 on: the model fans work out to subagents, background agents included. Takes effect with the next prompt; usage may increase.",
			off: "Boom mode off. Takes effect with the next prompt.",
			alreadyOn: "Boom mode 💥 is already on.",
			alreadyOff: "Boom mode is already off.",
		},
	});
	registerCoach(pi, isOn);
}
