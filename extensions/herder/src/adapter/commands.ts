import { existsSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { goalDraft } from "../artifacts/goal.ts";
import { LOCK_STALE_MS } from "../config.ts";
import type { RunState } from "../journal/fold.ts";
import { isStale, readLock } from "../run/lock.ts";
import { isRunId, refPrefix, runPaths } from "../run/paths.ts";
import { createRun, listRuns, openRun, type RunStore } from "../run/store.ts";
import type { DeliveryMode } from "../types.ts";
import { activateHerderTools } from "./activation.ts";
import { describeDelivery } from "./format.ts";
import { auditPrompt, auditSkillDir, PROMPT_TYPE, resumePrompt, skillText, startPrompt, type AuditInvocation, type AuditKind } from "./prompts.ts";
import { busy, message, unreadableRunError, type Herder, type Held, type Session } from "./session.ts";
import { describeRun, isBlocked, isFinished, isParked, otherUnfinishedLines, parkedLines, planTasks, type RunEntry } from "./status.ts";

export { PROMPT_TYPE } from "./prompts.ts";
export const DELIVERY_MODES: readonly DeliveryMode[] = ["series", "branch", "squash", "uncommitted"];
const SUBCOMMANDS = ["status", "resume", "deliver", "abort", "clean", "help"] as const;

export const USAGE = [
	"Usage:",
	"/herder <goal>                     start a run for a goal",
	"/herder status [runId]             show the run",
	"/herder resume [runId]             continue a run in this session",
	"/herder deliver [runId] [series|branch|squash|uncommitted] [--curate]",
	"/herder abort [runId]              stop and abandon the run",
	"/herder clean [runId|--finished]   delete finished run directories (default: --finished), or a named run whose journal cannot be read",
	"A first word that names a subcommand is always that subcommand; start with -- to use it as goal text (/herder -- status page …).",
].join("\n");

export type HerderCommand =
	| { action: "help" }
	| { action: "start"; goal: string }
	| { action: "status" | "resume" | "abort"; runId?: string }
	| { action: "deliver"; runId?: string; mode: DeliveryMode; curate: boolean }
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
			let runId: string | undefined;
			for (const word of rest) {
				if (word === "--curate" && !curate) curate = true;
				else if ((DELIVERY_MODES as readonly string[]).includes(word) && !mode) mode = word as DeliveryMode;
				else if (isRunId(word) && !runId) runId = word;
				else throw usage(`Unexpected deliver argument ${word}.`);
			}
			return { action: "deliver", ...(runId ? { runId } : {}), mode: mode ?? "series", curate };
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

/**
 * The repository's head and common directory, refusing without a commit, while this session holds an unparked
 * unfinished run (unless it is blocked under a standing authorization), or while a run's journal cannot be read.
 */
function startable(herder: Herder, s: Session): { head: string; commonDir: string } {
	const vcs = herder.vcs(s);
	let head: string;
	try {
		head = vcs.head();
	} catch {
		throw new Error("Herder needs a repository with at least one commit.");
	}
	const commonDir = vcs.commonDir();
	if (s.held && busy(s.held)) throw new Error(`Run ${s.held.runId} still has a launch or tool call running in this session.`);
	if (s.held) {
		let state: RunState;
		try { state = s.held.run.state(); } catch (error) { throw unreadableRunError(s.held.runId, error); }
		if (!isFinished(state) && !isParked(state) && !(herder.standing(s) !== undefined && isBlocked(state))) {
			throw new Error(`Herder run ${s.held.runId} is unfinished in this session. Continue it with /herder resume ${s.held.runId}, abandon it with /herder abort ${s.held.runId}, or start another run in a separate session.`);
		}
	}
	const unreadable: Error[] = [];
	herder.unfinished(s, (id, error) => unreadable.push(unreadableRunError(id, error)));
	if (unreadable.length) throw unreadable.at(-1)!;
	return { head, commonDir };
}

/** Creates a run at HEAD for `goal`, as `/herder <goal>` and `herder_run { action: "start" }` (`fromTool`) do; returns the start prompt. */
export function startRun(herder: Herder, s: Session, goal: string, fromTool = false): { runId: string; prompt: string } {
	const { head, commonDir } = startable(herder, s);
	const skill = skillText();
	const title = titleOf(goal);
	const run = createRun(commonDir, { title, base: head, repo: herder.vcs(s).topLevel(), goal: goalDraft(title), sessionId: s.id });
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
	return { runId: run.runId, prompt: startPrompt(run, goal, skill, fromTool, herder.standing(s) !== undefined) };
}

function start(herder: Herder, s: Session, goal: string): string {
	const { runId, prompt } = startRun(herder, s, goal);
	activateHerderTools(herder.pi);
	herder.pi.sendMessage({ customType: PROMPT_TYPE, display: true, content: prompt, details: { runId, action: "start" } }, { triggerTurn: true, deliverAs: "followUp" });
	return `Started Herder run ${runId}.`;
}

const AUDIT_EFFORTS = ["quick", "standard", "deep"] as const;
const AUDIT_WORDS: Record<AuditKind, readonly string[]> = {
	improve: [...AUDIT_EFFORTS, "branch", "next", "features", "roadmap", "correctness", "security", "perf", "tests", "docs", "--lang", "--auto"],
	simplify: [...AUDIT_EFFORTS, "branch", "deletion", "duplication", "abstractions", "flow", "state", "dependencies", "compat", "tooling", "--lang", "--auto"],
};

/** Words of `args`, keeping quoted phrases (`--lang "Traditional Chinese"`) together. */
const words = (args: string) => [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);

/** Lenient `/herder-improve` and `/herder-simplify` arguments: nothing is rejected; the skill asks about what is unclear. */
export function parseAudit(args: string): AuditInvocation {
	const invocation: AuditInvocation = { args: args.trim(), auto: false };
	const focus: string[] = [];
	const list = words(args);
	for (let i = 0; i < list.length; i++) {
		const word = list[i]!;
		if ((AUDIT_EFFORTS as readonly string[]).includes(word) && !invocation.effort) invocation.effort = word as AuditInvocation["effort"];
		else if (word === "--auto") invocation.auto = true;
		else if (word === "--lang") invocation.lang = list[i + 1]?.startsWith("--") ? "" : (list[++i] ?? "");
		else if (word.startsWith("--lang=")) invocation.lang = word.slice(7);
		else focus.push(word);
	}
	if (focus.length) invocation.focus = focus.join(" ");
	return invocation;
}

function audit(herder: Herder, s: Session, kind: AuditKind, args: string): string {
	startable(herder, s);
	const invocation = parseAudit(args);
	const repo = herder.vcs(s).topLevel();
	activateHerderTools(herder.pi);
	herder.pi.sendMessage({ customType: PROMPT_TYPE, display: true, content: auditPrompt(kind, invocation, repo, herder.standing(s) !== undefined), details: { action: kind, invocation, skillDir: auditSkillDir(kind) } }, { triggerTurn: true, deliverAs: "followUp" });
	return `Started the read-only /herder-${kind} audit.`;
}

function resume(herder: Herder, s: Session, runId: string | undefined): string {
	const commonDir = herder.vcs(s).commonDir();
	const id = runId ?? herder.implied(s);
	if (!id) throw new Error("nothing to resume: no unfinished Herder run in this repository");
	const run = s.held?.runId === id ? s.held.run : openRun(commonDir, id);
	const state = run.state();
	if (isFinished(state)) throw new Error(`nothing to resume: Herder run ${id} is ${state.status}`);
	if (s.held?.runId === id && s.held.launch) throw new Error(`Launch ${s.held.launch.launch} of run ${id} is still running in this session; its follow-up message will report the result.`);
	const skill = skillText();
	const held = herder.hold(s, id, run);
	const tasks = planTasks(held.run);
	held.run.renderProgress(tasks);
	activateHerderTools(herder.pi);
	herder.pi.sendMessage({ customType: PROMPT_TYPE, display: true, content: resumePrompt(held.run, held.run.state(), tasks, skill, herder.standing(s) !== undefined), details: { runId: id, action: "resume" } }, { triggerTurn: true, deliverAs: "followUp" });
	return `Resumed Herder run ${id}.`;
}

function clean(herder: Herder, s: Session, runId: string | undefined): string {
	const vcs = herder.vcs(s);
	const commonDir = vcs.commonDir();
	const deleted: string[] = [];
	for (const id of runId ? [runId] : listRuns(commonDir)) {
		let run: RunStore;
		try {
			run = openRun(commonDir, id);
		} catch (error) {
			if (runId) throw error;
			continue;
		}
		// A run whose journal cannot be read goes only when named: nothing can resume or abort it.
		let state: RunState | undefined;
		try { state = run.state(); } catch { if (!runId) continue; }
		if (!state) {
			// Its lock is all that says another session still works in it.
			const lock = readLock(run.paths.lock);
			if (lock && lock.sessionId !== herder.lockId(s) && !isStale(lock, herder.now())) {
				const age = Math.round((herder.now().getTime() - Date.parse(lock.heartbeatAt)) / 1000);
				throw new Error(`Herder run ${id} is in use: run is locked by session ${lock.sessionId} (pid ${lock.pid} on ${lock.host}, heartbeat ${age}s ago). It can be deleted once that heartbeat is older than ${LOCK_STALE_MS / 60_000} minutes.`);
			}
		}
		if (state && !isFinished(state)) {
			if (runId) throw new Error(`Herder run ${id} is unfinished (${state.status}); abort it first with /herder abort ${id}.`);
			continue;
		}
		if (s.held?.runId === id) {
			if (busy(s.held)) throw new Error(`Run ${id} still has a Herder tool call running; clean it once that finishes.`);
			herder.release(s);
		}
		const { paths } = run;
		vcs.deleteRefs(refPrefix(id));
		if (existsSync(paths.worktrees)) vcs.removeWorktree(paths.worktrees);
		rmSync(paths.dir, { recursive: true, force: true });
		deleted.push(id);
	}
	return deleted.length ? `Deleted ${deleted.length} Herder run(s): ${deleted.join(", ")}.` : "No finished Herder runs to delete.";
}

/** `/herder status` and `herder_run { action: "status" }`: the run, then parked runs and any other unfinished runs. */
export function statusReport(herder: Herder, s: Session, runId: string | undefined, unfinished: readonly RunEntry[] = herder.unfinished(s)): string {
	const run = herder.peek(s, runId);
	if (!run) return "No Herder runs in this repository.";
	const commonDir = herder.vcs(s).commonDir();
	const sessionId = herder.lockId(s);
	const text = describeRun(run, run.state(), planTasks(run), { lock: readLock(run.paths.lock), sessionId, launch: s.held?.runId === run.runId ? s.held.launch?.launch : undefined, now: herder.now() });
	return [text, ...parkedLines(unfinished), ...otherUnfinishedLines(unfinished, run.runId, (id) => readLock(runPaths(commonDir, id).lock), sessionId)].join("\n");
}

export function registerCommands(pi: ExtensionAPI, herder: Herder): void {
	pi.registerCommand("herder", {
		description: "Durable, verified coding runs: /herder <goal> | status | resume | deliver [runId] [mode] [--curate] | abort | clean",
		getArgumentCompletions: (prefix) => {
			const words = prefix.trimStart().split(/\s+/);
			const last = words.pop() ?? "";
			const options: readonly string[] = !words.length ? SUBCOMMANDS : words[0] === "deliver" ? [...DELIVERY_MODES, "--curate"] : [];
			// A word typed in full gets no menu: an open menu takes the Enter that should run the command.
			if (options.includes(last)) return null;
			const items = options.filter((item) => item.startsWith(last) && !words.includes(item));
			// A completion replaces every argument, so it keeps the words before the last.
			return items.length ? items.map((item) => ({ value: [...words, item].join(" "), label: item })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			pi.appendEntry("pi-extensions.command", { command: "herder", kind: "extension", extension: "herder" });
			try {
				const command = parseCommand(args);
				if (command.action === "help") { ctx.ui.notify(USAGE, "info"); return; }
				const s = herder.session(ctx);
				switch (command.action) {
					case "start": ctx.ui.notify(start(herder, s, command.goal), "info"); break;
					case "status": ctx.ui.notify(statusReport(herder, s, command.runId), "info"); break;
					case "resume": ctx.ui.notify(resume(herder, s, command.runId), "info"); break;
					case "abort": {
						const { runId, warning } = await herder.abort(s, command.runId);
						ctx.ui.notify(`Abandoned Herder run ${runId}.${warning ? ` Warning: ${warning}` : ""}`, warning ? "warning" : "info");
						break;
					}
					case "clean": ctx.ui.notify(clean(herder, s, command.runId), "info"); break;
					case "deliver": {
						const held = command.runId ? herder.hold(s, command.runId) : herder.current(s);
						const outcome = await herder.deliver(s, held, { mode: command.mode, curate: command.curate });
						ctx.ui.notify(describeDelivery(outcome), outcome.status === "delivered" ? "info" : "warning");
						break;
					}
				}
			} catch (error) {
				ctx.ui.notify(message(error), "error");
			}
		},
	});
	const audits: Record<AuditKind, string> = {
		improve: "Read-only audit for vetted improvements; pick findings to run with Herder: /herder-improve [quick|standard|deep] [focus|path|branch|next] [--lang <language>] [--auto]",
		simplify: "Read-only audit for vetted simplifications; pick findings to run with Herder: /herder-simplify [quick|standard|deep] [focus|path|branch] [--lang <language>] [--auto]",
	};
	for (const kind of ["improve", "simplify"] as const) {
		pi.registerCommand(`herder-${kind}`, {
			description: audits[kind],
			getArgumentCompletions: (prefix) => {
				const typed = prefix.trimStart().split(/\s+/);
				const last = typed.pop() ?? "";
				// A word typed in full gets no menu: an open menu takes the Enter that should run the command.
				if (AUDIT_WORDS[kind].includes(last)) return null;
				const items = AUDIT_WORDS[kind].filter((word) => word.startsWith(last) && !typed.includes(word));
				return items.length ? items.map((word) => ({ value: [...typed, word].join(" "), label: word })) : null;
			},
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				pi.appendEntry("pi-extensions.command", { command: `herder-${kind}`, kind: "extension", extension: "herder" });
				try {
					if (!ctx.hasUI) throw new Error(`/herder-${kind} needs an interactive session (TUI or RPC): the audit ends in a run you approve.`);
					ctx.ui.notify(audit(herder, herder.session(ctx), kind, args), "info");
				} catch (error) {
					ctx.ui.notify(message(error), "error");
				}
			},
		});
	}
}
