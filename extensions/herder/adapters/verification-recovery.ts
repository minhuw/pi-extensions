import type {
	IntegrationRepairClassification,
	IntegrationRepairRequest,
	IntegrationRepairState,
} from "../src/shared/protocol.ts";

const ACTIONABLE_STATES: ReadonlySet<IntegrationRepairState> = new Set([
	"available",
	"failed",
	"paused",
]);
const STRANDED_STATES: ReadonlySet<IntegrationRepairState> = new Set([
	"active",
	"committing",
	"committed",
	"interrupted",
]);
const TRANSIENT_RETRY_STATES: ReadonlySet<IntegrationRepairState> = new Set(["available", "failed"]);
const AMBIGUITY_CLASSIFICATIONS: ReadonlySet<IntegrationRepairClassification> = new Set([
	"design_ambiguity",
	"scope_ambiguity",
	"credential",
	"environment",
	"product_ambiguity",
]);

export type VerificationRecoveryKind = "none" | "owner_mismatch" | "decision_required" | "recoverable";

export interface VerificationRecoveryClassification {
	actionable: boolean;
	stranded: boolean;
	ownerMismatch: boolean;
	ambiguity: boolean;
	atLimit: boolean;
	kind: VerificationRecoveryKind;
}

/**
 * Classify the adapter-visible recovery state without deciding how to present it.
 * The session id is supplied by each caller so its existing evaluation timing is
 * preserved at both the detection and delivery sites.
 */
export function classifyVerificationRecovery(
	repair: IntegrationRepairRequest | undefined,
	currentMainSessionId = "",
): VerificationRecoveryClassification {
	const actionable = Boolean(repair && ACTIONABLE_STATES.has(repair.state));
	const stranded = Boolean(repair && STRANDED_STATES.has(repair.state));
	const ownerMismatch = Boolean(repair && (
		(repair.ownerSessionId && repair.ownerSessionId !== currentMainSessionId)
		|| (stranded && !repair.ownerSessionId)
	));
	const ambiguity = Boolean(repair && AMBIGUITY_CLASSIFICATIONS.has(repair.classification as IntegrationRepairClassification));
	const atLimit = Boolean(repair && (
		(repair.classification === "code_defect" && (repair.acceptedCodeRounds ?? repair.round) >= repair.maxRounds)
		|| (repair.classification === "transient" && repair.transientRetryUsed && TRANSIENT_RETRY_STATES.has(repair.state))
	));
	const kind: VerificationRecoveryKind = ownerMismatch
		? "owner_mismatch"
		: ambiguity || atLimit
			? "decision_required"
			: repair
				? "recoverable"
				: "none";
	return { actionable, stranded, ownerMismatch, ambiguity, atLimit, kind };
}

/** Bounded runner observations for the recovery prompt, never inferred classifications. */
export function verificationRunnerEvidence(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "unavailable";
	const result = value as Record<string, unknown>;
	const gates = Array.isArray(result.gates) ? result.gates.slice(0, 32) : [];
	const observations = gates.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const gate = value as Record<string, unknown>;
		return Object.fromEntries(["gateId", "label", "command", "cwd", "argv", "outcome", "exitCode", "error", "signal", "timedOut", "logPath"]
			.filter((key) => gate[key] !== undefined).map((key) => [key, gate[key]]));
	});
	return JSON.stringify({ ...(result.error !== undefined ? { error: result.error } : {}), gates: observations }).slice(0, 16_384);
}


export const FINAL_VERIFICATION_SELECTION_GUIDANCE = [
	"PLAN_V2_SELECTION: Read the complete compiled assignment, its V verification rows (Phase/Criteria/Toolchain/Command/Expected), and every referenced T toolchain (Owner/Cwd/Prerequisites/Probe/Evidence), including shared definitions. Select final-phase coverage plus required integration-risk checks for this exact tree; do not reinterpret development diagnostics or examples as final gates. Acceptance evidence remains per-plan evidence, not a substitute for final integration checks.",
	"CANONICAL_INVOCATION: Verify repository scripts, pyproject/uv, Nix definitions, lockfiles, CI, and instructions. Use the declared manager environment, not bare-binary discovery: for example uv run --no-sync only after verifying the prepared locked environment, nix develop --command for a declared prepared shell, or the canonical package script. Do not guess manager flags or assume a globally found binary is the project toolchain.",
	"ENVIRONMENT_BOUNDARY: Final gates run with a minimal environment; interactive HOME configuration and ambient credentials are not inherited. Separate prerequisite preparation from checks. Do not install, sync, download unpinned tools, inject credentials, or add setup commands disguised as checks. Herder's existing npm-only locked auto-preparation is the narrow exception, not a general setup service.",
	"PROBE_BOUNDARY: Safe non-mutating availability/version probes through the declared environment may be used only as selection diagnostics, never as acceptance evidence or substitutes for actual checks. Only the manager executes the selected authoritative verification gates. If prerequisites or invocation cannot be established, report concrete manager/argv/cwd/error evidence and ask for the prerequisite/decision; do not fabricate passed checks or submit a known-invalid tool choice.",
] as const;


export const ENVIRONMENT_VERIFICATION_RESUME_GUIDANCE = "Read the recorded prerequisite evidence and ask the operator to prepare the verified declared environment externally, without source edits, credentials injection, or ambient HOME inheritance. Then the user may explicitly invoke /herder-resume: Herder validates the frozen request/head/tree/namespace and replays the SAME ordered canonical gates, without a code-round or transient-budget charge. Do not call begin/finish again, edit the manifest, run the authoritative checks yourself, or redirect this environment-only wait into a corrective plan/revise. Stop or defer if preparation is not authorized. A failed successor opens a fresh unclassified episode; it never automatically retries.";
