// Herder template: several independent attempts at one task, filtered by gates, judged, and exactly one integrated.
// Copy it into your launch and adapt it. The script body runs as an async function.
//
// args: {
//   task: "T1",                    // plan task id; used in step ids and integration
//   prompt: "…",                   // self-contained task contract given to every variant
//   variants?: 3,                  // number of attempts
//   approaches?: ["…", "…"],       // optional per-variant direction, appended to the prompt
//   gate?: "unit-tests" | [ … ],   // check ids from goal.md; only variants that pass are candidates
//   criteria?: "…",                // what the judge should prefer (default: correctness, then simplicity)
//   judge?: "reviewer",            // read-only role that picks the winner ("reviewer" or "explorer")
//   message: "feat(x): …",         // integration commit message
//   checks?: [ … ]                 // integration checks (default: goal.md checks marked integrate)
// }
//
// Returns { task, status, winner?, head?, candidates, rationale? }.

const task = args?.task ?? "T1";
if (!args?.prompt) throw new Error("args.prompt is required");
const count = args.variants ?? 3;
const approaches = args.approaches ?? [];
const gateOpts = args.gate ? { gate: args.gate } : {};

phase(`${task}: explore ${count} variants`);
const variants = await parallel(
	Array.from({ length: count }, (_, i) => () => {
		const direction = approaches[i] ? `\n\nApproach for this attempt: ${approaches[i]}` : "";
		return agent(`${args.prompt}${direction}`, { id: `variant-${task}-${i + 1}`, label: `${task} variant ${i + 1}`, task, ...gateOpts });
	}),
);

const summary = variants.map((v, i) => ({ variant: i + 1, status: v ? v.status : "failed" }));
const candidates = variants.map((v, i) => ({ variant: i + 1, step: v })).filter((c) => c.step?.status === "ok");
if (candidates.length === 0) return { task, status: "no_candidate", candidates: summary };

let winner = candidates[0];
let rationale;
if (candidates.length > 1) {
	phase(`${task}: judge`);
	const listing = candidates.map((c) => `- variant ${c.variant}: commit ${c.step.commit} (read it with \`git diff ${c.step.commit}^ ${c.step.commit}\`)`).join("\n");
	const verdict = await agent(
		`Several independent attempts implement the same task. Every one passed its gates. Pick the single best one to keep.\n\nCriteria: ${args.criteria ?? "correct and complete against the contract first, then smallest and simplest, then best tested"}.\n\nCandidates:\n${listing}\n\nTask contract:\n${args.prompt}`,
		{
			id: `judge-${task}`,
			role: args.judge ?? "reviewer",
			task,
			schema: {
				type: "object",
				required: ["winner", "rationale"],
				properties: {
					winner: { type: "integer", enum: candidates.map((c) => c.variant) },
					rationale: { type: "string" },
				},
			},
		},
	);
	if (verdict.status === "ok") {
		winner = candidates.find((c) => c.variant === verdict.data.winner) ?? winner;
		rationale = verdict.data.rationale;
	} else log(`${task}: judge ${verdict.status}; keeping variant ${winner.variant}`);
}

phase(`${task}: integrate variant ${winner.variant}`);
const result = await integrate(winner.step, {
	message: args.message ?? `${task}: ${args.prompt.split("\n")[0].slice(0, 60)}`,
	task,
	...(args.checks ? { checks: args.checks } : {}),
});
return {
	task,
	status: result.status,
	winner: winner.variant,
	head: result.head,
	conflicts: result.conflicts,
	failures: result.status === "checks_failed" ? (result.checks ?? []).filter((c) => !c.passed).map((c) => c.id) : undefined,
	candidates: summary,
	rationale,
};
