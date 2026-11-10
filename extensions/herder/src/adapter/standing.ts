// Herder's copy of the standing-approval contract: selfdrive publishes grants while self-driving mode is on, Herder
// reads them. Extensions do not import each other; the other side declares the same types.
import { realpathSync } from "node:fs";

export const STANDING_APPROVAL_KEY = Symbol.for("pi-extensions.standing-approval");

export interface StandingApproval {
	/** The granting session's id; also the map key. */
	id: string;
	/** realpath of the repository's git common dir the grant covers. */
	commonDir: string;
	/** realpath of the main worktree's top level (the user's checkout). */
	toplevel: string;
	/** One paragraph: what the user confirmed. Journaled with each approval it gives. */
	text: string;
	/** ISO time the user granted it. */
	since: string;
}
export interface StandingApprovalRegistry { grants: Map<string, StandingApproval> }

/** The process-global registry; whoever reads it first creates it. */
export function standingRegistry(): StandingApprovalRegistry {
	const global = globalThis as Record<symbol, unknown>;
	const existing = global[STANDING_APPROVAL_KEY] as StandingApprovalRegistry | undefined;
	if (existing) return existing;
	const registry: StandingApprovalRegistry = { grants: new Map() };
	global[STANDING_APPROVAL_KEY] = registry;
	return registry;
}

/** Whether any grant exists, so callers can skip git when none does. */
export function hasStandingGrants(): boolean {
	const { grants } = standingRegistry();
	return grants instanceof Map && grants.size > 0;
}

const real = (path: string) => {
	try { return realpathSync(path); } catch { return path; }
};

const wellFormed = (grant: unknown): grant is StandingApproval => {
	const value = grant as Partial<StandingApproval> | null;
	return typeof value === "object" && value !== null && [value.id, value.commonDir, value.text, value.since].every((field) => typeof field === "string" && field.length > 0);
};

/** The grant covering the repository whose git common dir is `commonDir` (compared by realpath), or undefined. */
export function standingGrant(commonDir: string): StandingApproval | undefined {
	if (!hasStandingGrants()) return undefined;
	const target = real(commonDir);
	for (const grant of standingRegistry().grants.values()) {
		if (wellFormed(grant) && real(grant.commonDir) === target) return grant;
	}
	return undefined;
}

/** Whether `iso` (a run's creation time) is at or after the grant's `since`; unparsable times are not. */
export function sinceGrant(grant: StandingApproval, iso: string | undefined): boolean {
	const at = iso === undefined ? Number.NaN : Date.parse(iso);
	const since = Date.parse(grant.since);
	return Number.isFinite(at) && Number.isFinite(since) && at >= since;
}

/** One line for prompts that prime the model while a grant covers the repository. */
export const STANDING_NOTE = "A standing authorization from the user is in effect for this repository (self-driving mode): follow the skill's Standing approval rules. Ask the user nothing (write your assumptions into goal.md or record them with record_decision), and never call herder_deliver: leave verified runs parked for the user.";
