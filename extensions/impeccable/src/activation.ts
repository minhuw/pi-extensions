import path from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { LIVE_MESSAGE, LIVE_SNAPSHOT } from "./live.ts";
import { getSkillDir } from "./resources.ts";

export const IMPECCABLE_TOOL_NAMES = [
	"impeccable_question",
	"impeccable_delegate",
	"impeccable_capabilities",
	"impeccable_live",
	"impeccable_run",
] as const;

export const SKILL_LOCATION_MESSAGE = "impeccable:skill-location";

export const IMPECCABLE_MENTION_RE =
	/\bimpeccable(?:_[a-z]+|-live)?\b|(?:^|\s)\/design(?:-[a-z-]+)?(?=\s|$)|<!--\s*pi-impeccable-owned-prompt:v1\s*-->/i;

const ACTIVE_BRANCH_TYPES = new Set<string>([
	"impeccable-live",
	LIVE_SNAPSHOT,
	LIVE_MESSAGE,
	SKILL_LOCATION_MESSAGE,
]);

export function activateImpeccableTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): void {
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
	const active = pi.getActiveTools();
	if (IMPECCABLE_TOOL_NAMES.every((name) => active.includes(name))) return;
	pi.setActiveTools([...new Set([...active, ...IMPECCABLE_TOOL_NAMES])]);
}

function hasImpeccableBranchState(branch: readonly SessionEntry[] | undefined): boolean {
	if (!branch) return false;
	return branch.some(
		(entry) =>
			(entry.type === "custom" || entry.type === "custom_message") &&
			ACTIVE_BRANCH_TYPES.has(entry.customType),
	);
}

function hasSkillLocationSinceCompaction(branch: readonly SessionEntry[] | undefined): boolean {
	if (!branch) return false;
	const lastCompaction = branch.findLastIndex((entry) => entry.type === "compaction");
	const activeEntries = lastCompaction >= 0 ? branch.slice(lastCompaction + 1) : branch;
	return activeEntries.some(
		(entry) => entry.type === "custom_message" && entry.customType === SKILL_LOCATION_MESSAGE,
	);
}

export function registerActivation(pi: ExtensionAPI): void {
	if (typeof pi.on !== "function") return;

	const restoreFromBranch = (_event: unknown, ctx: { sessionManager?: { getBranch?: () => SessionEntry[] } }) => {
		if (hasImpeccableBranchState(ctx.sessionManager?.getBranch?.())) {
			activateImpeccableTools(pi);
		}
	};

	pi.on("session_start", restoreFromBranch);
	pi.on("session_tree", restoreFromBranch);

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "custom" && event.message.customType === LIVE_MESSAGE) {
			activateImpeccableTools(pi);
			return;
		}
		if (event.messageType !== "user" || typeof event.prompt !== "string" || !IMPECCABLE_MENTION_RE.test(event.prompt)) {
			return;
		}
		activateImpeccableTools(pi);
		const skillDir = getSkillDir();
		if (event.prompt.includes(skillDir)) return;
		if (hasSkillLocationSinceCompaction(ctx.sessionManager?.getBranch?.())) return;
		return {
			message: {
				customType: SKILL_LOCATION_MESSAGE,
				content: `Impeccable skill directory (<skill-base-dir>): ${skillDir} (SKILL.md: ${path.join(skillDir, "SKILL.md")}). Read SKILL.md only when using the Impeccable design skill.`,
				display: false,
			},
		};
	});
}
