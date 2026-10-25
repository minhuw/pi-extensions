import { existsSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { goalDraft } from "../artifacts/goal.ts";
import { readLock } from "../run/lock.ts";
import { isRunId, refPrefix } from "../run/paths.ts";
import { activeRun, createRun, listRuns, openRun } from "../run/store.ts";
import type { DeliveryMode } from "../types.ts";
import { describeDelivery } from "./format.ts";
import { resumePrompt, skillText, startPrompt } from "./prompts.ts";
import { busy, message, type Herder, type Held, type Session } from "./session.ts";
import { describeRun, isFinished, planTasks } from "./status.ts";

export const PROMPT_TYPE = "herder:prompt";
export const DELIVERY_MODES: readonly DeliveryMode[] = ["series", "branch", "squash", "uncommitted"];
const SUBCOMMANDS = ["status", "resume", "deliver", "abort", "clean", "help"] as const;

export const USAGE = [
	"Usage:",
	"/herder <goal>                     start a run for a goal",
	"/herder status [runId]             show the run",
	"/herder resume [runId]             continue a run in this session",
	"/herder deliver [series|branch|squash|uncommitted] [--curate]",
	"/herder abort [runId]              stop and abandon the run",
	"/herder clean [runId|--finished]   delete finished run directories (default: --finished)",
	"A first word that names a subcommand is always that subcommand; start with -- to use it as goal text (/herder -- status page …).",
].join("\n");

export type HerderCommand =
	| { action: "help" }
	| { action: "start"; goal: string }
	| { action: "status" | "resume" | "abort"; runId?: string }
	| { action: "deliver"; mode: DeliveryMode; curate: boolean }
	| { action: "clean"; runId?: string };

export class UsageError extends Error {}

const usage = (problem: string) => new UsageError(`${problem}\n\n${USAGE}`);

function runIdArg(words: string[], name: string): string | undefined {
	if (words.length > 1) throw usage(`/herder ${name} takes at most one run id.`);
	if (words[0] !== undefined && !isRunId(words[0])) throw usage(`Not a run id: ${words[0]} (expected YYYYMMDD-HHMMSS-xxxx).`);
	return words[0];
}

/** `/herder` arguments. Subcommand words are reserved; goal text starting with one needs a leading `--`. */
export function parseCommand(args: string): HerderCommand {
	const text = args.trim();
	if (!text) return { action: "help" };
	if (text === "--" || text.startsWith("-- ")) {
		const goal = text.slice(2).trim();
		if (!goal) throw usage("Missing goal text after --.");
		return { action: "start", goal };
	}
	const [first, ...rest] = text.split(/\s+/);
	if (!(SUBCOMMANDS as readonly string[]).includes(first!)) {
		if (first!.startsWith("-")) throw usage(`Unknown option ${first}.`);
		return { action: "start", goal: text };
	}
	switch (first as typeof SUBCOMMANDS[number]) {
		case "help":
			if (rest.length) throw usage("/herder help takes no arguments.");
			return { action: "help" };
		case "status": case "resume": case "abort":
			return { action: first as "status" | "resume" | "abort", runId: runIdArg(rest, first!) };
		case "deliver": {
			let mode: DeliveryMode | undefined;
			let curate = false;
			for (const word of rest) {
				if (word === "--curate" && !curate) curate = true;
				else if ((DELIVERY_MODES as readonly string[]).includes(word) && !mode) mode = word as DeliveryMode;
				else throw usage(`Unexpected deliver argument ${word}.`);
			}
			return { action: "deliver", mode: mode ?? "series", curate };
		}
		case "clean":
			if (rest.length === 1 && rest[0] === "--finished") return { action: "clean" };
			return { action: "clean", runId: runIdArg(rest, "clean") };
	}
}

/** A one-line run title from the goal text. */
export function titleOf(goal: string): string {
	const line = goal.split(/\r?\n/).find((part) => part.trim())?.replace(/\s+/g, " ").trim() ?? "";
	return line.length <= 100 ? line : `${line.slice(0, 99)}…`;
}

function start(herder: Herder, s: Session, goal: string): string {
	const vcs = herder.vcs(s);
	let head: string;
	try {
		head = vcs.head();
	} catch {
		throw new Error("Herder needs a repository with at least one commit.");
	}
	const commonDir = vcs.commonDir();
	const unfinished = activeRun(commonDir);
	if (unfinished) throw new Error(`Herder run ${unfinished} is unfinished. Continue it with /herder resume ${unfinished}, or abandon it with /herder abort ${unfinished}.`);
	if (s.held && busy(s.held)) throw new Error(`Run ${s.held.runId} still has a launch or tool call running in this session.`);
	const skill = skillText();
	const title = titleOf(goal);
	const run = createRun(commonDir, { title, base: head, repo: vcs.topLevel(), goal: goalDraft(title) });
	let held: Held | undefined;
	try {
		held = herder.hold(s, run.runId, run);
		herder.runtime(s, held).start();
	} catch (error) {
		// A run that never got its refs must not block the next /herder.
		run.journal.append({ t: "run.finished", status: "failed", reason: `could not start: ${message(error)}` });
		if (held) herder.release(s);
		throw error;
	}
	herder.pi.sendMessage({ customType: PROMPT_TYPE, display: true, content: startPrompt(run, goal, skill), details: { runId: run.runId, action: "start" } }, { triggerTurn: true, deliverAs: "followUp" });
	return `Started Herder run ${run.runId}.`;
}

function resume(herder: Herder, s: Session, runId: string | undefined): string {
	const commonDir = herder.vcs(s).commonDir();
	const id = runId ?? activeRun(commonDir);
	if (!id) throw new Error("nothing to resume: no unfinished Herder run in this repository");
	const run = s.held?.runId === id ? s.held.run : openRun(commonDir, id);
	const state = run.state();
	if (isFinished(state)) throw new Error(`nothing to resume: Herder run ${id} is ${state.status}`);
	if (s.held?.runId === id && s.held.launch) throw new Error(`Launch ${s.held.launch.launch} of run ${id} is still running in this session; its follow-up message will report the result.`);
	const skill = skillText();
	const held = herder.hold(s, id, run);
	const tasks = planTasks(held.run);
	held.run.renderProgress(tasks);
	herder.pi.sendMessage({ customType: PROMPT_TYPE, display: true, content: resumePrompt(held.run, held.run.state(), tasks, skill), details: { runId: id, action: "resume" } }, { triggerTurn: true, deliverAs: "followUp" });
	return `Resumed Herder run ${id}.`;
}

function clean(herder: Herder, s: Session, runId: string | undefined): string {
	const vcs = herder.vcs(s);
	const commonDir = vcs.commonDir();
	const deleted: string[] = [];
	for (const id of runId ? [runId] : listRuns(commonDir)) {
		let finished: boolean;
		try {
			const state = openRun(commonDir, id).state();
			finished = isFinished(state);
			if (!finished && runId) throw new Error(`Herder run ${id} is unfinished (${state.status}); abort it first with /herder abort ${id}.`);
		} catch (error) {
			if (runId) throw error;
			continue;
		}
		if (!finished) continue;
		if (s.held?.runId === id) {
			if (busy(s.held)) throw new Error(`Run ${id} still has a Herder tool call running; clean it once that finishes.`);
			herder.release(s);
		}
		const paths = openRun(commonDir, id).paths;
		vcs.deleteRefs(refPrefix(id));
		if (existsSync(paths.worktrees)) vcs.removeWorktree(paths.worktrees);
		rmSync(paths.dir, { recursive: true, force: true });
		deleted.push(id);
	}
	return deleted.length ? `Deleted ${deleted.length} Herder run(s): ${deleted.join(", ")}.` : "No finished Herder runs to delete.";
}

function status(herder: Herder, s: Session, runId: string | undefined): string {
	const run = herder.peek(s, runId);
	if (!run) return "No Herder runs in this repository.";
	return describeRun(run, run.state(), planTasks(run), { lock: readLock(run.paths.lock), sessionId: herder.lockId(s), launch: s.held?.runId === run.runId ? s.held.launch?.launch : undefined, now: herder.now() });
}

export function registerCommands(pi: ExtensionAPI, herder: Herder): void {
	pi.registerCommand("herder", {
		description: "Durable, verified coding runs: /herder <goal> | status | resume | deliver [mode] [--curate] | abort | clean",
		getArgumentCompletions: (prefix) => {
			const words = prefix.trimStart().split(/\s+/);
			if (words.length > 1) return words[0] === "deliver" ? [...DELIVERY_MODES, "--curate"].filter((item) => item.startsWith(words.at(-1)!)).map((value) => ({ value: `deliver ${value}`, label: value })) : null;
			const items = SUBCOMMANDS.filter((name) => name.startsWith(words[0] ?? ""));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const command = parseCommand(args);
				if (command.action === "help") { ctx.ui.notify(USAGE, "info"); return; }
				const s = herder.session(ctx);
				switch (command.action) {
					case "start": ctx.ui.notify(start(herder, s, command.goal), "info"); break;
					case "status": ctx.ui.notify(status(herder, s, command.runId), "info"); break;
					case "resume": ctx.ui.notify(resume(herder, s, command.runId), "info"); break;
					case "abort": {
						const { runId, warning } = await herder.abort(s, command.runId);
						ctx.ui.notify(`Abandoned Herder run ${runId}.${warning ? ` Warning: ${warning}` : ""}`, warning ? "warning" : "info");
						break;
					}
					case "clean": ctx.ui.notify(clean(herder, s, command.runId), "info"); break;
					case "deliver": {
						const outcome = await herder.deliver(s, herder.current(s), { mode: command.mode, curate: command.curate });
						ctx.ui.notify(describeDelivery(outcome), outcome.status === "delivered" ? "info" : "warning");
						break;
					}
				}
			} catch (error) {
				ctx.ui.notify(message(error), "error");
			}
		},
	});
}
