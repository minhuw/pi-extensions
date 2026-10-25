// Herder template: one task, implemented → gated → optionally reviewed → fixed → integrated.
// Copy it into your launch and adapt it. The script body runs as an async function.
//
// args: {
//   task: "T1",                    // plan task id; used in step ids and integration
//   prompt: "…",                   // self-contained task contract for the worker (goal, criteria, paths, constraints)
//   gate?: "unit-tests" | [ … ],   // check ids from goal.md run after every writing step
//   review?: true,                 // run one clean read-only reviewer pass on the gated change
//   maxAttempts?: 3,               // fix steps after the first implementation
//   message: "feat(x): …",         // integration commit message
//   checks?: [ … ]                 // integration checks (default: goal.md checks marked integrate)
// }
//
// Returns { task, status, attempts, head?, failures?, findings?, error?, note? }.
// status "review_failed" with `error` means the review step itself failed; with `findings`, blocking findings survived the fix cap.

const task = args?.task ?? "T1";
if (!args?.prompt) throw new Error("args.prompt is required");
const message = args.message ?? `${task}: ${args.prompt.split("\n")[0].slice(0, 60)}`;
const maxAttempts = args.maxAttempts ?? 3;
const gateOpts = args.gate ? { gate: args.gate } : {};
const findingsSchema = {
	type: "object",
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				required: ["severity", "file", "issue", "evidence"],
				properties: {
					severity: { enum: ["critical", "high", "medium", "low"] },
					file: { type: "string" },
					line: { type: "integer" },
					issue: { type: "string" },
					evidence: { type: "string" },
					fix: { type: "string" },
				},
			},
		},
	},
};

// Durations, clock times, and hashes change between runs; strip them so a repeated failure is recognized.
// file:line:col locations are kept so different failures stay distinct.
const normalize = (tail) => (tail ?? "")
	.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "#")
	.replace(/(?<![:\d(])\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, "#")
	.replace(/\b[0-9a-f]{7,}\b/gi, "#")
	.replace(/\d+(\.\d+)?\s*(ns|µs|us|ms|s|m|h)\b/g, "#");
const failedChecks = (step) => (step.checks ?? []).filter((c) => !c.passed);
const describeChecks = (checks) => checks.map((c) => `### ${c.id} (exit ${c.timedOut ? "timeout" : c.exitCode})\n${c.tail}`).join("\n\n");
const describeFindings = (items) => items.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.issue}\n  evidence: ${f.evidence}${f.fix ? `\n  suggested fix: ${f.fix}` : ""}`).join("\n");
let attempts = 0;
let reviewed = !args.review;
let lastFailure = null;
let findings = [];
const done = (status, extra) => ({ task, status, attempts, ...extra });

phase(`${task}: implement`);
const impl = await agent(args.prompt, { id: `impl-${task}`, task, ...gateOpts });
let step = impl;
let previous = null;

for (;;) {
	if (step.status === "failed" || step.status === "stopped") return done(step.status, { error: step.error });
	if (step.status === "no_changes") {
		// A review-driven fix that changes nothing leaves the gated change as it was.
		if (previous?.status === "ok") { step = previous; break; }
		return done("no_changes", { note: step === impl ? "the worker changed nothing" : "the fix changed nothing" });
	}

	let feedback;
	if (step.status === "gate_failed") {
		const failed = failedChecks(step);
		const signature = JSON.stringify(failed.map((c) => [c.id, c.exitCode, c.timedOut, normalize(c.tail)]));
		if (signature === lastFailure) return done("gate_failed", { failures: failed.map((c) => c.id), note: "same gate failed with the same output twice" });
		lastFailure = signature;
		feedback = `These checks fail on your change:\n\n${describeChecks(failed)}\n\nFix the cause.`;
	} else if (!reviewed) {
		reviewed = true;
		phase(`${task}: review`);
		const review = await agent(
			`Review the change for task ${task}. It is the diff \`git diff ${impl.commit}^ HEAD\` in your worktree.\n\nContract:\n${args.prompt}`,
			{ id: `review-${task}`, role: "reviewer", base: step.commit, task, schema: findingsSchema },
		);
		// A review that did not finish is not a pass; let the main model decide.
		if (review.status !== "ok") return done(review.status === "stopped" ? "stopped" : "review_failed", { error: review.error, note: "the review step did not finish; the change was not integrated" });
		findings = review.data.findings;
		const blocking = findings.filter((f) => f.severity === "critical" || f.severity === "high");
		if (blocking.length === 0) break;
		feedback = `A reviewer found these problems in your change:\n\n${describeFindings(blocking)}\n\nFix them; ignore any you can show are wrong and say why.`;
	} else break;

	if (attempts >= maxAttempts) return done(step.status === "gate_failed" ? "gate_failed" : "review_failed", { failures: failedChecks(step).map((c) => c.id), findings: findings.length ? findings : undefined });
	attempts++;
	previous = step;
	phase(`${task}: fix ${attempts}`);
	step = await agent(`${args.prompt}\n\nYour worktree already contains an attempt at this task.\n\n${feedback}`, { id: `fix-${task}-${attempts}`, task, base: step.commit, ...gateOpts });
}

phase(`${task}: integrate`);
const result = await integrate(step, { message, task, ...(args.checks ? { checks: args.checks } : {}) });
if (result.status === "conflict") return done("conflict", { conflicts: result.conflicts });
if (result.status === "checks_failed") return done("checks_failed", { failures: (result.checks ?? []).filter((c) => !c.passed).map((c) => c.id) });
return done("integrated", { head: result.head, findings: findings.length ? findings : undefined });
