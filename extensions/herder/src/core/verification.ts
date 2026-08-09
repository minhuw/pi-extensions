import fs from "node:fs";
import path from "node:path";
import {
	sha256,
	stableJson,
	type VerificationGate,
	type VerificationManifest,
	type VerificationRequest,
} from "../shared/protocol.ts";

/**
 * Path kinds in Herder verification:
 * - LocationRoot: absolute realpath host locations (integrationWorktree, runAssignmentPath).
 * - TreeRelative: positions inside a known LocationRoot (gate.cwd).
 *
 * Gate cwd is TreeRelative only. Absolute input is rejected with no compatibility rewrite.
 * Runtime execution resolves: path.resolve(integrationWorktree, gate.cwd).
 */
const MAX_GATES = 32;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 8_192;
const MAX_RATIONALE_LENGTH = 16_384;
const DEFAULT_GATE_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_GATE_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

export interface VerificationRequestInput {
	requestId: string;
	runId: string;
	generation: number;
	graphSha256: string;
	runAssignmentPath: string;
	runAssignmentSha256: string;
	integrationBranch: string;
	integrationWorktree: string;
	integrationHead: string;
	integrationTree: string;
	requestedAt: string;
}

function oneLine(value: unknown, label: string, maximum = 512): string {
	const text = String(value ?? "").trim();
	if (!text) throw new Error(`${label} is required`);
	if (text.length > maximum || /[\0\r\n]/.test(text)) throw new Error(`${label} must be one line of at most ${maximum} characters`);
	return text;
}

function sha(value: unknown, label: string): string {
	const text = oneLine(value, label, 64).toLowerCase();
	if (!/^[0-9a-f]{40,64}$/.test(text)) throw new Error(`${label} must be a hexadecimal Git or SHA-256 identity`);
	return text;
}

function inside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function createVerificationRequest(input: VerificationRequestInput): VerificationRequest {
	const core = {
		schemaVersion: 1 as const,
		requestId: oneLine(input.requestId, "Verification request ID", 200),
		runId: oneLine(input.runId, "Verification run ID", 200),
		generation: input.generation,
		graphSha256: sha(input.graphSha256, "Verification graph SHA-256"),
		runAssignmentPath: path.resolve(input.runAssignmentPath),
		runAssignmentSha256: sha(input.runAssignmentSha256, "Verification run-assignment SHA-256"),
		integrationBranch: oneLine(input.integrationBranch, "Verification integration branch"),
		integrationWorktree: path.resolve(input.integrationWorktree),
		integrationHead: sha(input.integrationHead, "Verification integration head"),
		integrationTree: sha(input.integrationTree, "Verification integration tree"),
		requestedAt: new Date(input.requestedAt).toISOString(),
	};
	if (!Number.isSafeInteger(core.generation) || core.generation < 1) throw new Error("Verification generation must be a positive integer");
	return { ...core, requestSha256: sha256(stableJson(core)) };
}

export function normalizeVerificationManifest(
	request: VerificationRequest,
	input: VerificationManifest,
): { manifest: VerificationManifest; manifestSha256: string } {
	if (!input || input.schemaVersion !== 1) throw new Error("Verification manifest schemaVersion must be 1");
	for (const field of ["requestId", "requestSha256", "runId", "graphSha256", "runAssignmentSha256", "integrationHead", "integrationTree"] as const) {
		if (String(input[field]) !== String(request[field])) throw new Error(`Verification manifest ${field} does not match the active request`);
	}
	if (input.generation !== request.generation) throw new Error("Verification manifest generation does not match the active request");
	const rationale = String(input.rationale ?? "").trim();
	if (!rationale || rationale.length > MAX_RATIONALE_LENGTH || /\0/.test(rationale)) {
		throw new Error(`Verification rationale must contain 1 through ${MAX_RATIONALE_LENGTH} characters`);
	}
	if (!Array.isArray(input.gates) || input.gates.length > MAX_GATES) throw new Error(`Verification manifest may contain at most ${MAX_GATES} gates`);

	const worktree = fs.realpathSync(request.integrationWorktree);
	const ids = new Set<string>();
	const gates: VerificationGate[] = input.gates.map((gate, index) => {
		if (!gate || typeof gate !== "object" || Array.isArray(gate)) throw new Error(`Verification gate ${index + 1} is invalid`);
		const gateId = oneLine(gate.gateId, `Verification gate ${index + 1} ID`, 80);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(gateId)) throw new Error(`Verification gate ${gateId} has an invalid ID`);
		if (ids.has(gateId)) throw new Error(`Verification gate ID ${gateId} is duplicated`);
		ids.add(gateId);
		const label = oneLine(gate.label, `Verification gate ${gateId} label`, 160);
		const cwd = oneLine(gate.cwd || ".", `Verification gate ${gateId} cwd`, 1_024);
		if (path.isAbsolute(cwd)) {
			throw new Error(`Verification gate ${gateId} cwd must be relative to the integration worktree`);
		}
		// TreeRelative only: resolve against the frozen LocationRoot, never accept a host path.
		const resolvedCwd = fs.realpathSync(path.resolve(worktree, cwd));
		if (!inside(worktree, resolvedCwd)) throw new Error(`Verification gate ${gateId} cwd escapes the integration worktree`);
		if (!Array.isArray(gate.argv) || gate.argv.length < 1 || gate.argv.length > MAX_ARGUMENTS) {
			throw new Error(`Verification gate ${gateId} argv must contain 1 through ${MAX_ARGUMENTS} arguments`);
		}
		const argv = gate.argv.map((argument, argumentIndex) => {
			if (typeof argument !== "string" || !argument || argument.length > MAX_ARGUMENT_LENGTH || /[\0\r\n]/.test(argument)) {
				throw new Error(`Verification gate ${gateId} argument ${argumentIndex + 1} is invalid`);
			}
			return argument;
		});
		const timeoutMs = gate.timeoutMs === undefined ? DEFAULT_GATE_TIMEOUT_MS : Number(gate.timeoutMs);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_GATE_TIMEOUT_MS) {
			throw new Error(`Verification gate ${gateId} timeoutMs must be between 1000 and ${MAX_GATE_TIMEOUT_MS}`);
		}
		const gateRationale = String(gate.rationale ?? "").trim();
		if (!gateRationale || gateRationale.length > 4_096 || /\0/.test(gateRationale)) {
			throw new Error(`Verification gate ${gateId} rationale is required and must be at most 4096 characters`);
		}
		return { gateId, label, cwd: path.relative(worktree, resolvedCwd) || ".", argv, timeoutMs, rationale: gateRationale };
	});
	const selector = input.selector && typeof input.selector === "object" && !Array.isArray(input.selector)
		? {
			...(input.selector.model ? { model: oneLine(input.selector.model, "Verification selector model", 256) } : {}),
			...(input.selector.thinkingLevel ? { thinkingLevel: oneLine(input.selector.thinkingLevel, "Verification selector thinking level", 32) } : {}),
			...(input.selector.sessionId ? { sessionId: oneLine(input.selector.sessionId, "Verification selector session ID", 200) } : {}),
		}
		: undefined;
	const manifest: VerificationManifest = {
		schemaVersion: 1,
		requestId: request.requestId,
		requestSha256: request.requestSha256,
		runId: request.runId,
		generation: request.generation,
		graphSha256: request.graphSha256,
		runAssignmentSha256: request.runAssignmentSha256,
		integrationHead: request.integrationHead,
		integrationTree: request.integrationTree,
		rationale,
		gates,
		...(selector && Object.keys(selector).length > 0 ? { selector } : {}),
	};
	return { manifest, manifestSha256: sha256(stableJson(manifest)) };
}
