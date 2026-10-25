import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanTask } from "../artifacts/plan.ts";
import { MAX_CLARIFYING_QUESTIONS } from "../config.ts";
import type { RunState } from "../journal/fold.ts";
import type { RunStore } from "../run/store.ts";

export const SKILL_PATH = fileURLToPath(new URL("../../skills/herder/SKILL.md", import.meta.url));

/** SKILL.md without its frontmatter; read at use so edits apply without a reload. */
export function skillText(path = SKILL_PATH): string {
	return readFileSync(path, "utf8").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

const read = (path: string) => {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
};
const block = (title: string, path: string, text: string) => `## ${title} (${path})\n\n${text || "(empty)"}`;

function files(run: RunStore): string {
	return [
		"Run files (under the repository's git directory, never in the working tree):",
		`- goal.md: ${run.paths.goal}`,
		`- plan.md: ${run.paths.plan}`,
		`- notes.md: ${run.paths.notes}`,
		`- progress.md: ${run.paths.progress} (rendered by Herder; do not edit)`,
	].join("\n");
}

export function startPrompt(run: RunStore, goal: string, skill: string): string {
	return [
		`/herder: run ${run.runId} started for this goal:`,
		goal,
		files(run),
		[
			"Next:",
			`1. Read the relevant code. Then ask the user at most ${MAX_CLARIFYING_QUESTIONS} clarifying questions, only ones whose answers change the work, each with a recommended answer. Skip questions the code answers.`,
			"2. Complete goal.md (a draft skeleton is there): acceptance criteria mapped to checks, constraints, out of scope.",
			'3. Call herder_run { action: "approve_goal" }. The user confirms the goal; if validation fails, fix goal.md and call it again.',
		].join("\n"),
		`Herder instructions:\n\n${skill}`,
	].join("\n\n");
}

export function resumePrompt(run: RunStore, state: RunState, tasks: readonly PlanTask[], skill: string): string {
	const latest = [...state.launches.values()].at(-1);
	const next: string[] = [];
	if (!state.goal) next.push('The goal is not approved yet: finish clarifying, complete goal.md, and call herder_run { action: "approve_goal" }.');
	else if (latest && latest.settled?.status !== "completed") {
		next.push(`Launch ${latest.launch} ${latest.settled ? latest.settled.status : "did not complete"}. To continue it, relaunch with herder_workflow { mode: "run", scriptPath: "${join(run.paths.scripts, `${latest.launch}.js`)}", args: ${JSON.stringify(latest.launched.args ?? null)}, resume: ${latest.launch} }; finished steps and integrations are reused.`);
	} else next.push("Continue from the progress below: plan the remaining tasks, run steps or a launch, then herder_verify and herder_deliver.");
	if (tasks.length === 0 && state.goal) next.push("plan.md has no task lines yet.");
	const decisions = state.decisions.map((event) => `- ${event.question} → ${event.answer}`).join("\n");
	return [
		`/herder resume: continue Herder run ${run.runId}${state.title ? `: ${state.title}` : ""}.`,
		files(run),
		next.join("\n"),
		block("goal.md", run.paths.goal, read(run.paths.goal)),
		block("plan.md", run.paths.plan, read(run.paths.plan)),
		block("progress.md", run.paths.progress, read(run.paths.progress)),
		...(decisions ? [`## Recorded decisions\n\n${decisions}`] : []),
		`Herder instructions:\n\n${skill}`,
	].join("\n\n");
}
