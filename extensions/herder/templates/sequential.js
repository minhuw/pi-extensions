// Herder template: one task, implemented → gated → optionally probed with tests → fixed → integrated.
// Copy it into your launch and adapt it. The script body runs as an async function.
//
// args: {
//   task: "T1",                    // plan task id; used in step ids and integration
//   prompt: "…",                   // self-contained task contract for the worker (goal, criteria, paths, constraints)
//   gate?: "unit-tests" | [ … ],   // check ids from goal.md run after every writing step
//   probe?: true,                  // once the gates pass, a tester adds tests from the contract; needs gate, which runs them
//   maxAttempts?: 3,               // fix steps after the first implementation
//   message: "feat(x): …",         // integration commit message
//   checks?: [ … ]                 // integration checks (default: goal.md checks marked integrate)
// }
//
// Returns { task, status, attempts, probe?, head?, failures?, error?, note? }.
// `probe` is the probe step's status. The probe's tests are integrated with the change; when they fail, the fix loop
// gets their output. status "probe_failed" means the probe step itself did not finish.

const task = args?.task ?? "T1";
if (!args?.prompt) throw new Error("args.prompt is required");
if (args.review !== undefined) throw new Error("args.review was removed: use args.probe, which tests the change against its contract");
if (args.probe && !args.gate) throw new Error("args.probe needs args.gate: the probe's tests count only when a gate runs them");
const message = args.message ?? `${task}: ${args.prompt.split("\n")[0].slice(0, 60)}`;
const maxAttempts = args.maxAttempts ?? 3;
if (!Number.isInteger(maxAttempts) || maxAttempts < 0) throw new Error("args.maxAttempts must be a non-negative integer");
const gateOpts = args.gate ? { gate: args.gate } : {};

// Durations, clock times, and hashes change between runs; strip them so a repeated failure is recognized.
// file:line:col locations are kept so different failures stay distinct.
const normalize = (tail) => (tail ?? "")
	.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "#")
	.replace(/(?<![:\d(])\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, "#")
	.replace(/\b[0-9a-f]{7,}\b/gi, "#")
	.replace(/\d+(\.\d+)?\s*(ns|µs|us|ms|s|m|h)\b/g, "#");
const failedChecks = (step) => (step.checks ?? []).filter((c) => !c.passed);
const describeChecks = (checks) => checks.map((c) => `### ${c.id} (exit ${c.timedOut ? "timeout" : c.exitCode})\n${c.tail}`).join("\n\n");
let attempts = 0;
let probed = !args.probe;
let probeStatus;
let testsNote = "";
let lastFailure = null;
const done = (status, extra) => ({ task, status, attempts, ...(probeStatus ? { probe: probeStatus } : {}), ...extra });

phase(`${task}: implement`);
const impl = await agent(args.prompt, { id: `impl-${task}`, task, ...gateOpts });
let step = impl;

for (;;) {
	if (step.status === "failed" || step.status === "stopped") return done(step.status, { error: step.error });
	if (step.status === "no_changes") return done("no_changes", { note: step === impl ? "the worker changed nothing" : "the fix changed nothing" });
	if (step.status === "ok") {
		if (probed) break;
		probed = true;
		phase(`${task}: probe`);
		const probe = await agent(
			`Test the change for task ${task} against its contract. It is the diff \`git diff ${impl.commit}^ HEAD\` in your worktree. The checks ${[].concat(args.gate).join(", ")} run your tests afterwards.\n\nContract:\n${args.prompt}`,
			{ id: `probe-${task}`, role: "tester", base: step.commit, task, ...gateOpts },
		);
		probeStatus = probe.status;
		// A probe that did not finish is not a pass; let the main model decide.
		if (probe.status === "failed" || probe.status === "stopped") return done(probe.status === "stopped" ? "stopped" : "probe_failed", { error: probe.error, note: "the probe step did not finish; the change was not integrated" });
		// No new tests leaves the gated change as it was.
		if (probe.status === "no_changes") break;
		testsNote = `\n\nA tester wrote tests for this task from its contract: \`git diff ${step.commit} ${probe.commit}\`. Fix the implementation; change one of those tests only where it asserts something the contract does not require, and say which and why.`;
		step = probe;
		if (step.status === "ok") break;
	}

	const failed = failedChecks(step);
	const signature = JSON.stringify(failed.map((c) => [c.id, c.exitCode, c.timedOut, normalize(c.tail)]));
	if (signature === lastFailure) return done("gate_failed", { failures: failed.map((c) => c.id), note: "same gate failed with the same output twice" });
	lastFailure = signature;
	if (attempts >= maxAttempts) return done("gate_failed", { failures: failed.map((c) => c.id) });
	attempts++;
	phase(`${task}: fix ${attempts}`);
	step = await agent(
		`${args.prompt}\n\nYour worktree already contains an attempt at this task.\n\nThese checks fail on your change:\n\n${describeChecks(failed)}\n\nFix the cause.${testsNote}`,
		{ id: `fix-${task}-${attempts}`, task, base: step.commit, ...gateOpts },
	);
}

phase(`${task}: integrate`);
const result = await integrate(step, { message, task, ...(args.checks ? { checks: args.checks } : {}) });
if (result.status === "conflict") return done("conflict", { conflicts: result.conflicts });
if (result.status === "checks_failed") return done("checks_failed", { failures: (result.checks ?? []).filter((c) => !c.passed).map((c) => c.id) });
return done("integrated", { head: result.head });
