// Herder template: independent tasks with disjoint file ownership, implemented in parallel and integrated serially.
// Copy it into your launch and adapt it. The script body runs as an async function.
// Use it only when the tasks' owned paths do not overlap; parallel writers on shared files conflict.
//
// args: {
//   tasks: [{
//     id: "T1",                      // plan task id; used in step ids and integration
//     prompt: "…",                   // self-contained task contract for the worker
//     owns: ["src/a/**", "tests/a/**"], // the only paths this task may edit
//     gate?: "unit-tests" | [ … ],   // check ids from goal.md run after the task's writing steps
//     message: "feat(a): …",         // integration commit message
//     checks?: [ … ]                 // integration checks (default: goal.md checks marked integrate)
//   }],
//   maxAttempts?: 3                  // fix steps per task after a failed gate
// }
//
// Returns { head?, integrated: [ids], failed: [{ task, status, … }] }.

if (!Array.isArray(args?.tasks) || args.tasks.length === 0) throw new Error("args.tasks must be a non-empty array");
const maxAttempts = args.maxAttempts ?? 3;

// Durations, clock times, and hashes change between runs; strip them so a repeated failure is recognized.
// file:line:col locations are kept so different failures stay distinct.
const normalize = (tail) => (tail ?? "")
	.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "#")
	.replace(/(?<![:\d(])\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, "#")
	.replace(/\b[0-9a-f]{7,}\b/gi, "#")
	.replace(/\d+(\.\d+)?\s*(ns|µs|us|ms|s|m|h)\b/g, "#");
const failedChecks = (checks) => (checks ?? []).filter((c) => !c.passed);
const describeChecks = (checks) => checks.map((c) => `### ${c.id} (exit ${c.timedOut ? "timeout" : c.exitCode})\n${c.tail}`).join("\n\n");
const contract = (t) => `${t.prompt}\n\nFile ownership: edit only these paths: ${t.owns.join(", ")}. Other workers are changing other paths in parallel; do not touch anything else, even to fix something you notice.`;
const gateOpts = (t) => (t.gate ? { gate: t.gate } : {});

// Implements one task and fixes failed gates; resolves to the last step result.
async function build(t) {
	phase(`${t.id}: implement`);
	let step = await agent(contract(t), { id: `impl-${t.id}`, task: t.id, ...gateOpts(t) });
	let lastFailure = null;
	for (let attempt = 1; step.status === "gate_failed" && attempt <= maxAttempts; attempt++) {
		const failed = failedChecks(step.checks);
		const signature = JSON.stringify(failed.map((c) => [c.id, c.exitCode, c.timedOut, normalize(c.tail)]));
		if (signature === lastFailure) break;
		lastFailure = signature;
		phase(`${t.id}: fix ${attempt}`);
		const fix = await agent(
			`${contract(t)}\n\nYour worktree already contains an attempt at this task. These checks fail on it:\n\n${describeChecks(failed)}\n\nFix the cause.`,
			{ id: `fix-${t.id}-${attempt}`, task: t.id, base: step.commit, ...gateOpts(t) },
		);
		if (fix.status === "no_changes") break;
		step = fix;
	}
	return step;
}

const steps = await pipeline(args.tasks, (t) => build(t));

const integrated = [];
const failed = [];
let head;
for (const [i, t] of args.tasks.entries()) {
	const step = steps[i];
	if (!step) { failed.push({ task: t.id, status: "failed", note: "the task's script code threw" }); continue; }
	if (step.status !== "ok") {
		failed.push({ task: t.id, status: step.status, error: step.error, failures: failedChecks(step.checks).map((c) => c.id) });
		continue;
	}
	phase(`${t.id}: integrate`);
	const opts = { message: t.message ?? `${t.id}: ${t.prompt.split("\n")[0].slice(0, 60)}`, task: t.id, ...(t.checks ? { checks: t.checks } : {}) };
	let result = await integrate(step, opts);
	if (result.status === "conflict") {
		log(`${t.id}: conflict in ${(result.conflicts ?? []).join(", ")}; running the resolver`);
		phase(`${t.id}: resolve`);
		const resolved = await agent(
			`Integrate task ${t.id} onto the current integration head (your worktree). Its change is commit ${step.commit}; read it with \`git show ${step.commit}\`.\n\nConflicting paths:\n${(result.conflicts ?? []).map((p) => `- ${p}`).join("\n")}\n\nKeep both sides completely. If you cannot, change nothing and explain why; the task is then reported as failed.\n\nTask contract:\n${contract(t)}`,
			{ id: `resolve-${t.id}`, role: "resolver", task: t.id, ...(head ? { base: head } : {}), ...gateOpts(t) },
		);
		// no_changes means the resolver could not keep both sides; its text says why.
		// The resolver step runs the task's gate; a report that admits dropping a side is refused as well.
		const gaveUp = /\b(could not|cannot|can't|unable to) (keep|preserve)\b/i.test(resolved.text ?? "");
		if (resolved.status !== "ok" || gaveUp) {
			failed.push({ task: t.id, status: "conflict", conflicts: result.conflicts, resolver: resolved.status, error: resolved.error, note: resolved.status === "no_changes" || gaveUp ? resolved.text?.slice(0, 500) : undefined });
			continue;
		}
		result = await integrate(resolved, opts);
	}
	if (result.status === "integrated") {
		head = result.head;
		integrated.push(t.id);
	} else {
		failed.push({ task: t.id, status: result.status, conflicts: result.conflicts, failures: failedChecks(result.checks).map((c) => c.id) });
	}
}

return { head, integrated, failed };
