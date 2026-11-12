import { join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { auditSkillDir, PROMPT_TYPE, SKILL_PATH, SKILLS_DIR } from "./prompts.ts";
import { FOLLOW_UP_TYPE } from "./session.ts";
import { hasStandingGrants } from "./standing.ts";

export const HERDER_TOOL_NAMES = [
	"herder_run",
	"herder_workflow",
	"herder_step",
	"herder_integrate",
	"herder_check",
	"herder_verify",
	"herder_deliver",
	"herder_pick_findings",
] as const;

export const SKILL_LOCATIONS_MESSAGE = "herder:skill-locations";
export const HERDER_MENTION_RE = /\bherder(?:[-_][a-z_]+)?\b/i;

const ACTIVE_BRANCH_TYPES = new Set<string>([
	PROMPT_TYPE,
	FOLLOW_UP_TYPE,
	SKILL_LOCATIONS_MESSAGE,
]);

export function skillLocationsContent(): string {
	return [
		"Herder skills (read SKILL.md only when running that workflow):",
		`- herder: ${SKILL_PATH}`,
		`- herder-improve: ${join(auditSkillDir("improve"), "SKILL.md")}`,
		`- herder-simplify: ${join(auditSkillDir("simplify"), "SKILL.md")}`,
	].join("\n");
}

export function activateHerderTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): void {
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
	const active = pi.getActiveTools();
	if (HERDER_TOOL_NAMES.every((name) => active.includes(name))) return;
	pi.setActiveTools([...new Set([...active, ...HERDER_TOOL_NAMES])]);
}

function isHerderCommandEntry(entry: SessionEntry): boolean {
	if (entry.type !== "custom" || entry.customType !== "pi-extensions.command") return false;
	const data = entry.data as { extension?: unknown } | undefined;
	return data?.extension === "herder";
}

function isHerderToolResultEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		typeof entry.message.toolName === "string" &&
		entry.message.toolName.startsWith("herder_")
	);
}

export function hasHerderBranchState(branch: readonly SessionEntry[] | undefined): boolean {
	if (!branch) return false;
	return branch.some(
		(entry) =>
			((entry.type === "custom" || entry.type === "custom_message") && ACTIVE_BRANCH_TYPES.has(entry.customType)) ||
			isHerderCommandEntry(entry) ||
			isHerderToolResultEntry(entry),
	);
}

function hasSkillLocationsSinceCompaction(branch: readonly SessionEntry[] | undefined): boolean {
	if (!branch) return false;
	const lastCompaction = branch.findLastIndex((entry) => entry.type === "compaction");
	const activeEntries = lastCompaction >= 0 ? branch.slice(lastCompaction + 1) : branch;
	return activeEntries.some(
		(entry) => entry.type === "custom_message" && entry.customType === SKILL_LOCATIONS_MESSAGE,
	);
}

/** Activates `herder_*` tools on Herder branches, standing grants, or explicit `herder` mentions. Zero git or FS calls. */
export function registerActivation(pi: ExtensionAPI): void {
	if (typeof pi.on !== "function") return;

	const restoreFromBranch = (_event: unknown, ctx: { sessionManager?: { getBranch?: () => SessionEntry[] } }) => {
		if (hasStandingGrants() || hasHerderBranchState(ctx.sessionManager?.getBranch?.())) {
			activateHerderTools(pi);
		}
	};

	pi.on("session_start", restoreFromBranch);
	pi.on("session_tree", restoreFromBranch);

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "custom") {
			if (event.message.customType === PROMPT_TYPE || event.message.customType === FOLLOW_UP_TYPE) {
				activateHerderTools(pi);
				return undefined;
			}
			if (hasStandingGrants() || (typeof event.message.content === "string" && HERDER_MENTION_RE.test(event.message.content))) {
				activateHerderTools(pi);
				if (hasSkillLocationsSinceCompaction(ctx.sessionManager?.getBranch?.())) return undefined;
				return {
					message: {
						customType: SKILL_LOCATIONS_MESSAGE,
						content: skillLocationsContent(),
						display: false,
					},
				};
			}
			return undefined;
		}
		if (event.messageType === "user" && typeof event.prompt === "string" && HERDER_MENTION_RE.test(event.prompt)) {
			activateHerderTools(pi);
			if (event.prompt.includes(SKILLS_DIR)) return undefined;
			if (hasSkillLocationsSinceCompaction(ctx.sessionManager?.getBranch?.())) return undefined;
			return {
				message: {
					customType: SKILL_LOCATIONS_MESSAGE,
					content: skillLocationsContent(),
					display: false,
				},
			};
		}
		return undefined;
	});
}
