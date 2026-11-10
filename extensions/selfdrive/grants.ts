// selfdrive's side of the standing-approval contract: it publishes a grant while self-driving mode is on, and Herder
// reads it to approve goals and take recommended findings without a dialog. Extensions do not import each other; Herder
// declares the same types in extensions/herder/src/adapter/standing.ts.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

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
	if (existing?.grants instanceof Map) return existing;
	const registry: StandingApprovalRegistry = { grants: new Map() };
	global[STANDING_APPROVAL_KEY] = registry;
	return registry;
}

/** Every grant in this process. */
export const grants = (): StandingApproval[] => [...standingRegistry().grants.values()];

export const real = (path: string): string => {
	try { return realpathSync(path); } catch { return resolve(path); }
};

/** The repository of `cwd`: its git common dir and the main worktree's top level, realpath'd; undefined outside git. */
export function repositoryOf(cwd: string): { commonDir: string; toplevel: string } | undefined {
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
	try {
		const [gitDir, common, top] = git("rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-toplevel").split("\n");
		if (!gitDir || !common || !top) return undefined;
		const commonDir = real(isAbsolute(common) ? common : resolve(cwd, common));
		// In the main worktree (also a submodule's or a --separate-git-dir checkout, whose common dir is not
		// `<toplevel>/.git`) its own top level; in a linked worktree the main one, listed first.
		if (real(gitDir) === commonDir) return { commonDir, toplevel: real(top) };
		const main = /^worktree (.+)$/m.exec(git("worktree", "list", "--porcelain"))?.[1];
		return { commonDir, toplevel: real(main ?? dirname(commonDir)) };
	} catch {
		return undefined;
	}
}

export function publishGrant(grant: StandingApproval): void {
	standingRegistry().grants.set(grant.id, grant);
}

export function withdrawGrant(id: string): void {
	standingRegistry().grants.delete(id);
}
