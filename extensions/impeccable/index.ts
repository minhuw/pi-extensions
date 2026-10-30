import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLive } from "./src/live-registration.ts";
import { registerQuestion } from "./src/questions.ts";
import { registerDelegation } from "./src/delegation.ts";
import { registerCapabilities } from "./src/capabilities.ts";
import { registerDetector } from "./src/detector.ts";
import { registerCompatibility, runOperation, type OperationResult } from "./src/operations.ts";
import { Type } from "typebox";
import {
	DEFAULT_TIMEOUT_MS,
	ENGINE_VERSION,
	MAX_RESULT_BYTES,
	MAX_RESULT_LINES,
	truncateText,
	type EngineStatus,
} from "./src/engine.ts";

const StatusSchema = Type.Union([
	Type.Literal("success"),
	Type.Literal("findings"),
	Type.Literal("truncated"),
	Type.Literal("timeout"),
	Type.Literal("cancelled"),
	Type.Literal("unavailable"),
	Type.Literal("error"),
]);

const ResultSchema = Type.Object({
	ok: Type.Boolean(),
	status: StatusSchema,
	exitCode: Type.Union([Type.Integer(), Type.Null()]),
	findings: Type.Boolean(),
	stdout: Type.String(),
	stderr: Type.String(),
	stdoutTruncated: Type.Boolean(),
	stderrTruncated: Type.Boolean(),
	trustedOverride: Type.Boolean(),
	binary: Type.String(),
	cwd: Type.String(),
	message: Type.Optional(Type.String()),
	integration: Type.Optional(Type.Any()),
});

function structuredContent(result: OperationResult) {
	return {
		ok: result.ok,
		status: result.status,
		exitCode: result.exitCode,
		findings: result.findings,
		stdout: result.stdout,
		stderr: result.stderr,
		stdoutTruncated: result.stdoutTruncated,
		stderrTruncated: result.stderrTruncated,
		trustedOverride: result.trustedOverride,
		binary: result.binary,
		cwd: result.cwd,
		...(result.integration ? { integration: JSON.parse(JSON.stringify(result.integration)) } : {}),
		...(result.message !== undefined ? { message: result.message } : {}),
	};
}

function statusLine(status: EngineStatus, message?: string): string {
	switch (status) {
		case "success":
			return "success (exit 0)";
		case "findings":
			return "findings (detector exit 2)";
		case "truncated":
			return "output truncated (not a complete result; retry with a narrower scope)";
		case "timeout":
			return message ? `timed out: ${message}` : "timed out";
		case "cancelled":
			return "cancelled";
		case "unavailable":
			return message ? `unavailable: ${message}` : "unavailable";
		case "error":
			return message ? `error: ${message}` : "error";
	}
}

function renderResult(result: OperationResult): string {
	if (result.integration?.engineRun === false) return truncateText([
		`Pi Impeccable adapter: ${result.integration.operation}`,
		`status: ${result.ok ? "success" : "error"} (adapter operation; engine not run)`,
		`cwd: ${result.cwd}`, result.stdout, result.stderr,
	].filter(Boolean).join("\n"), MAX_RESULT_BYTES, MAX_RESULT_LINES).text;
	const lines = [
		...(result.integration ? [`Pi adapter: ${JSON.stringify(result.integration)}`] : []),
		`impeccable_run ${result.argv.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}`,
		`status: ${statusLine(result.status, result.message)}`,
		`engine: ${result.binary || "(unresolved)"}${result.trustedOverride ? " [trusted IMPECCABLE_BIN override; version not verified against engine-checksums.txt]" : ""}`,
		`cwd: ${result.cwd}`,
	];
	if (result.exitCode !== null) lines.push(`exit code: ${result.exitCode}`);
	if (result.signal) lines.push(`signal: ${result.signal}`);
	lines.push("");
	if (result.stdoutTruncated) lines.push("stdout (truncated — never a complete result):");
	else lines.push("stdout:");
	lines.push(result.stdout || "(empty)");
	lines.push("");
	if (result.stderrTruncated) lines.push("stderr (truncated):");
	else lines.push("stderr:");
	lines.push(result.stderr || "(empty)");
	return truncateText(lines.join("\n"), MAX_RESULT_BYTES, MAX_RESULT_LINES).text;
}

/**
 * Registers capabilities only. Engine resolution and dialogs are lazy.
 */
export default function impeccableExtension(pi: ExtensionAPI): void {
	registerQuestion(pi);
	registerDelegation(pi);
	registerCapabilities(pi);
	registerLive(pi);
	registerCompatibility(pi);
	const resetDetector = registerDetector(pi);
	pi.registerTool({
		name: "impeccable_run",
		label: "Impeccable Engine",
		description:
			`Run the pinned Impeccable design engine v${ENGINE_VERSION} with a direct argv array (never a shell string), with Pi adapters for hook controls, ignores, doctor metadata and native prompt pinning. ` +
			"`argv[0]` is the engine verb (`context`, `detect`, `build-phase`, `doctor`, `hooks`, `pin`, `engine-probe`, …) and the rest are that verb's arguments. " +
			"The runner resolves, verifies, and caches the engine itself (downloading and checksum-checking on first use), sets IMPECCABLE_PROVIDER_ID=pi and installed IMPECCABLE_SKILL_DIR/IMPECCABLE_SELF, and runs it in `cwd` (default: the session cwd). " +
			"Exit 0 is success; for the `detect` verb exit 2 means findings; any other nonzero exit is a real failure whose stderr diagnostics are returned. " +
			"Adapter-only operations have integration.engineRun:false and no engine exit code. Doctor and engine JSON stdout remains raw; read Pi enablement separately in integration metadata. Runtime distribution updates belong to this repository. " +
			`Output is bounded to ${MAX_RESULT_LINES} lines or ${Math.round(MAX_RESULT_BYTES / 1024)} KiB per stream, and truncated, timed-out, or cancelled runs are never presented as complete success.`,
		promptSnippet: "Run the Impeccable design engine with an argv array",
		promptGuidelines: [
			"Use impeccable_live start/generate/status/reply/resume/stop for live ownership; impeccable_run gives an explicit handoff for polling/boot/completion verbs.",
			"Use impeccable_run for other Impeccable engine verbs instead of shelling out to the skill launcher.",
			"Pass the verb as argv[0] and its arguments as the remaining entries; quote never matters because argv is not parsed by a shell.",
			"Treat status findings (detector exit 2) as design findings, status unavailable as a missing prerequisite to report, and status error/timeout/cancelled as failures to diagnose, not as success.",
			"Never parse truncated stdout as complete JSON; retry with a narrower scope instead.",
		],
		parameters: Type.Object({
			argv: Type.Array(Type.String({ description: "One engine argument per entry, starting with the verb" }), {
				minItems: 1,
				maxItems: 256,
				description: "Full engine argv, e.g. ['context'] or ['detect', 'src/app']",
			}),
			cwd: Type.Optional(Type.String({ description: "Directory to run in (default: the session working directory)" })),
			timeoutMs: Type.Optional(
				Type.Integer({ minimum: 1_000, maximum: 3_600_000, description: `Wall-clock bound in ms (default ${DEFAULT_TIMEOUT_MS})` }),
			),
		}),
		outputSchema: ResultSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runOperation({
				argv: params.argv,
				cwd: params.cwd ?? ctx.cwd,
				timeoutMs: params.timeoutMs,
				signal,
			}, pi, ctx.cwd);
			if (result.ok && ["hooks", "hook-admin"].includes(params.argv[0] ?? "") && params.argv[1]?.toLowerCase() === "reset") await resetDetector();
			return {
				content: [{ type: "text", text: renderResult(result) }],
				details: result,
				structuredContent: structuredContent(result),
				isError: !result.ok,
			};
		},
	});
}
