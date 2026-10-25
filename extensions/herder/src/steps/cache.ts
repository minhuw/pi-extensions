// Step identity and cache decisions (§6, §8.3).
import { DEFAULT_ROLE, TRAILER_FINGERPRINT, TRAILER_STEP } from "../config.ts";
import { findCompletion, type RunState } from "../journal/fold.ts";
import { stepFingerprint, stepId } from "../journal/keys.ts";
import type { AgentOptions, CheckSpec, RoleDefinition, StepCompletedEvent, Vcs } from "../types.ts";

/** A call's identity minus its occurrence (which depends on the launch). */
export interface StepIdentity { id: string; explicitId: boolean; fingerprint: string; role: RoleDefinition; write: boolean; base: string; gates: CheckSpec[] }

/** Throws (a fatal error at the call site) for unknown roles or gates and for `write: true` on a read-only role. */
export function resolveIdentity(prompt: string, opts: AgentOptions, roles: ReadonlyMap<string, RoleDefinition>, checks: readonly CheckSpec[], base: string): StepIdentity {
	if (typeof prompt !== "string" || !prompt) throw new Error("agent() needs a non-empty prompt");
	const name = opts.role ?? DEFAULT_ROLE;
	const defined = roles.get(name);
	if (!defined) throw new Error(`unknown role ${JSON.stringify(name)}; known roles: ${[...roles.keys()].join(", ")}`);
	if (opts.write === true && !defined.write) throw new Error(`role ${JSON.stringify(name)} is read-only; it cannot run with write: true`);
	const write = opts.write ?? defined.write;
	const gates = (opts.gate === undefined ? [] : typeof opts.gate === "string" ? [opts.gate] : opts.gate).map((id) => {
		const check = checks.find((spec) => spec.id === id);
		if (!check) throw new Error(`unknown gate ${JSON.stringify(id)}; the goal's checks are: ${checks.map((spec) => spec.id).join(", ") || "(none)"}`);
		return check;
	});
	if (opts.id !== undefined && (typeof opts.id !== "string" || !opts.id)) throw new Error("agent() id must be a non-empty string");
	// The role keeps its own sha: restricting a writer to read-only is captured by `write` in the fingerprint.
	const role = write === defined.write ? defined : { ...defined, write };
	const fingerprint = stepFingerprint({ kind: "agent", role: name, roleSha: defined.sha256, prompt, schema: opts.schema, write, base, gates });
	return { id: opts.id ?? stepId("agent", name, prompt), explicitId: opts.id !== undefined, fingerprint, role, write, base, gates };
}

export type Lookup =
	| { kind: "hit"; completion: StepCompletedEvent }
	| { kind: "adopt"; commit: string; changed: boolean }
	/** `staleRef`: a step ref that is neither the recorded result nor adoptable; discard it before running. */
	| { kind: "miss"; changed: boolean; staleRef: boolean };

/** §6 rules 1–4 and adoption (§8.3). `ref` is the step's ref name. */
export function lookupStep(state: RunState, vcs: Vcs, ref: string, key: string, identity: StepIdentity, fresh: boolean): Lookup {
	const { fingerprint, base } = identity;
	const current = vcs.readRef(ref);
	const record = state.steps.get(key);
	const latest = record?.completed ?? record?.started ?? record?.failed;
	const changed = latest !== undefined && latest.fingerprint !== fingerprint;
	if (fresh) return { kind: "miss", changed, staleRef: current !== null };
	const completion = findCompletion(state, key, fingerprint);
	if (completion && (completion.commit === undefined || current === completion.commit)) return { kind: "hit", completion };
	if (current !== null && !completion && adoptable(vcs, current, key, fingerprint, base)) return { kind: "adopt", commit: current, changed };
	return { kind: "miss", changed, staleRef: current !== null };
}

function adoptable(vcs: Vcs, commit: string, key: string, fingerprint: string, base: string): boolean {
	const parents = vcs.parentsOf(commit);
	const trailers = vcs.trailers(commit); // keys are lowercased
	return parents.length === 1 && parents[0] === base && trailers[TRAILER_FINGERPRINT.toLowerCase()] === fingerprint && trailers[TRAILER_STEP.toLowerCase()] === key;
}

/** Names the agent's stored reply on a step commit so adoption can restore it; not part of the fingerprint. */
export const TRAILER_REPLY = "Herder-Reply";

export function stepMessage(key: string, fingerprint: string, replyRef?: string): string {
	const reply = replyRef === undefined ? "" : `${TRAILER_REPLY}: ${replyRef}\n`;
	return `herder step ${key}\n\n${TRAILER_STEP}: ${key}\n${TRAILER_FINGERPRINT}: ${fingerprint}\n${reply}`;
}
