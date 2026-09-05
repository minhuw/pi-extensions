/** Process evidence, not an automatic diagnosis of a source-code defect. */
export const GATE_OUTCOMES = ["passed", "command_failed", "unavailable", "timed_out", "runner_error"] as const;
export type GateOutcome = typeof GATE_OUTCOMES[number];

export function gateOutcome(input: {
	ok: boolean;
	timedOut: boolean;
	launchFailed: boolean;
	runnerFailed: boolean;
}): GateOutcome {
	if (input.runnerFailed) return "runner_error";
	if (input.timedOut) return "timed_out";
	if (input.launchFailed) return "unavailable";
	return input.ok ? "passed" : "command_failed";
}
