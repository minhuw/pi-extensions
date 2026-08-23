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
