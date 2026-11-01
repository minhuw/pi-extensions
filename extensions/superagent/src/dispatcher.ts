// The ticket state machine of DESIGN.md: creation, follow-ups, run outcomes, queueing, merge, close, locks, restarts.
import {
	ATTENTION_STATES, FINAL_STATES, LAST_TEXT_CHARS, LOCK_HEARTBEAT_MS, type DispatchSettings, type Git, type LockOwner, type MergeDeps,
	type MergeOutcome, type ReportState, type Repo, type Ticket, type TicketEvent, type TicketReport, type TicketState, type TicketStore,
	type WorkerEvent, type WorkerHost,
} from "./types.ts";

/** Why the owner session hears about a ticket; see DESIGN.md "Reports to the main session". */
export type NotifyKind = "question" | "ready" | "blocked" | "failed" | "waiting" | "dropped" | "merged" | "merge-handed" | "merge-refused";
export const NOTIFY_KINDS: readonly NotifyKind[] = ["question", "ready", "blocked", "failed", "waiting", "dropped", "merged", "merge-handed", "merge-refused"];

export interface NotifyExtra {
	/** Merge hand-off or refusal reason. */
	reason?: string;
	/** For `ready` and `merged`: commits ahead of the target. */
	ahead?: number;
	/** For `ready`: `git diff --name-status` lines against the target. */
	files?: string[];
	/** The branch compared against. */
	target?: string;
}

export interface DispatcherDeps {
	store: TicketStore;
	git: Git;
	repo: Repo;
	/** Builds the session's worker host; called once, lazily, with the dispatcher's event handler. */
	createWorkerHost(onEvent: (event: WorkerEvent) => void): WorkerHost;
	mergeTicket(deps: MergeDeps, id: number): Promise<MergeOutcome>;
	/** Branch names to try for a new ticket, best first (src/store.ts `branchCandidates`). */
	branchCandidates(id: number, slug: string): Iterable<string>;
	/** The first prompt of a ticket (src/worker-prompt.ts `requestPrompt`). */
	requestPrompt(ticket: Ticket): string;
	/** Prefix of the first prompt after a restart (src/worker-prompt.ts `RECOVERY_NOTE`). */
	recoveryNote: string;
	settings: DispatchSettings | (() => DispatchSettings);
	sessionId: string;
	sessionFile?: string;
	pid?: number;
	now?: () => number;
	heartbeatMs?: number;
	notify(ticket: Ticket, kind: NotifyKind, extra?: NotifyExtra): void;
}

export interface CreateInput {
	title: string;
	request: string;
	source: string;
	note?: string;
	/** Start only once these tickets are merged; a closed one fails the ticket. */
	after?: number[];
	/** Merge as soon as the ticket reports ready. */
	mergeWhenReady?: boolean;
	/** The `ticket_create` tool call, recorded in the ticket session's link. */
	parentToolCallId?: string;
}
export type Delivery = "steered" | "prompted" | "reopened" | "started" | "queued";
export interface SendResult { ticket: Ticket; delivery: Delivery }
export type ResumeAction = "started" | "queued" | "owned" | "live";
export interface MergeWhenReadyResult { ticket: Ticket; outcome?: MergeOutcome }
export interface TicketInfo { ticket: Ticket; target?: string; ahead?: number; behind?: number; files?: string[]; holder?: LockOwner; mine: boolean; live: boolean; running: boolean }

export interface DispatchSummary {
	/** Open tickets of the repository, by id. */
	open: Ticket[];
	/** The `superagent-tickets` text (empty when nothing is open). */
	text: string;
	/** Own tickets whose worker is running. */
	working: number;
	/** Own tickets waiting for the user. */
	attention: number;
	queued: number;
}

/** A refusal shown to the user or model as is. */
export class DispatchError extends Error {}

export const NO_TOOL_ERROR = "the worker finished without calling any tool; the model may not have received its tool definitions. Retry with a message, or check the model route.";
const FINAL_REPORTS: ReadonlySet<ReportState> = new Set(["ready", "blocked", "failed", "dropped"]);

export const cut = (text: string, max = LAST_TEXT_CHARS) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export const isOpen = (ticket: Ticket) => !FINAL_STATES.has(ticket.state);

export interface Dispatcher {
	readonly sessionId: string;
	create(input: CreateInput): Promise<Ticket>;
	send(id: number, text: string): Promise<SendResult>;
	merge(id: number): Promise<MergeOutcome>;
	/** Merges now when the ticket is ready and idle, else once it reports ready. */
	mergeWhenReady(id: number): Promise<MergeWhenReadyResult>;
	close(id: number, reason: string): Promise<Ticket>;
	resume(id: number): Promise<{ ticket: Ticket; action: ResumeAction }>;
	get(id: number): Ticket | undefined;
	list(all?: boolean): Ticket[];
	inspect(id: number): Promise<TicketInfo>;
	summary(): DispatchSummary;
	/** Ids whose lock this session holds. */
	held(): number[];
	isRunning(id: number): boolean;
	startup(): void;
	shutdown(): Promise<void>;
	/** Resolves once every queued start, run-end, and merge re-run finished (tests). */
	idle(): Promise<void>;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
	const { store, git, repo } = deps;
	const owner: LockOwner = { pid: deps.pid ?? process.pid, sessionId: deps.sessionId };
	const settings = () => typeof deps.settings === "function" ? deps.settings() : deps.settings;
	const now = () => deps.now?.() ?? Date.now();
	/** Tickets whose lock this session holds. */
	const held = new Set<number>();
	/** Tickets with a run in progress, from `start` until `run_end`. */
	const runs = new Set<number>();
	const starts = new Map<number, Promise<void>>();
	/** Final report state of the current run, per ticket. */
	const finals = new Map<number, ReportState>();
	/** Tickets being closed or merged: their run ends are not outcomes. */
	const stopping = new Set<number>();
	/**
	 * Tickets whose current run is their first, on the request: one that calls no tool did no work, most likely because
	 * the model never received its tools. A later run may rightly answer a message in text alone.
	 */
	const firstRuns = new Set<number>();
	/** `ticket_create` tool call ids of tickets not started yet. */
	const toolCalls = new Map<number, string>();
	const work = new Set<Promise<unknown>>();
	let host: WorkerHost | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let closing = false;
	let shut: Promise<void> | undefined;

	const workers = () => host ??= deps.createWorkerHost((event) => onEvent(event));
	const track = <T>(promise: Promise<T>): Promise<T> => {
		const settled = promise.finally(() => work.delete(settled));
		settled.catch(() => {});
		work.add(settled);
		return promise;
	};
	const update = (id: number, patch: Partial<Ticket>, event?: Omit<TicketEvent, "at">) => store.update(id, patch, event);
	const isMine = (holder: LockOwner | undefined) => holder !== undefined && holder.sessionId === owner.sessionId && holder.pid === owner.pid;
	const running = (id: number) => runs.has(id) || (host?.isRunning(id) ?? false);

	function require(id: number): Ticket {
		const ticket = store.get(id);
		if (!ticket) throw new DispatchError(`Ticket #${id} does not exist.`);
		if (!isOpen(ticket)) throw new DispatchError(`Ticket #${id} is ${ticket.state}${ticket.state === "closed" && ticket.closedReason ? ` (${ticket.closedReason})` : ""}; it takes no more work.`);
		return ticket;
	}

	/** Takes the ticket's lock (a free or stale one) and its reports; refuses while another live session holds it. */
	function own(ticket: Ticket): Ticket {
		if (closing) throw new DispatchError("This session is shutting down.");
		if (!held.has(ticket.id)) {
			const holder = store.holder(ticket.id);
			if (holder && !isMine(holder)) throw new DispatchError(`Ticket #${ticket.id} is run by another Pi session (${holder.sessionId}, pid ${holder.pid}); send it messages from there.`);
			if (!store.acquire(ticket.id, owner)) throw new DispatchError(`Ticket #${ticket.id} is locked by another Pi session.`);
			held.add(ticket.id);
			ensureTimer();
		}
		if (ticket.owner !== owner.sessionId) ticket = update(ticket.id, { owner: owner.sessionId }, { type: "owner", owner: owner.sessionId, previous: ticket.owner });
		return ticket;
	}

	function release(id: number): void {
		if (!held.delete(id)) return;
		try { store.release(id, owner); } catch {}
	}

	function ensureTimer(): void {
		if (timer || closing) return;
		timer = setInterval(heartbeat, deps.heartbeatMs ?? LOCK_HEARTBEAT_MS);
		timer.unref?.();
	}

	function heartbeat(): void {
		for (const id of [...held]) {
			try {
				store.refresh(id, owner);
			} catch {
				// Another session took the lock: this one no longer runs the ticket.
				if (!isMine(store.holder(id))) { held.delete(id); void host?.stop(id).catch(() => {}); }
			}
		}
	}

	/** Starts a run; the ticket becomes `working`. Errors leave it `failed`. */
	function start(ticket: Ticket, prompt: string, resume: boolean, event: string): Promise<void> {
		const id = ticket.id;
		runs.add(id);
		finals.delete(id);
		if (resume) firstRuns.delete(id); else firstRuns.add(id);
		const current = update(id, { state: "working", question: undefined, pending: undefined, error: undefined }, { type: event, resume });
		const parentToolCallId = resume ? undefined : toolCalls.get(id);
		toolCalls.delete(id);
		const begun = (async () => {
			try {
				await workers().start({ ticket: current, prompt, resume, ...(parentToolCallId !== undefined ? { parentToolCallId } : {}) });
			} catch (error) {
				runs.delete(id);
				firstRuns.delete(id);
				const failed = update(id, { state: "failed", error: `the worker could not start: ${errorText(error)}` }, { type: "failed", error: errorText(error) });
				deps.notify(failed, "failed");
				drain();
			} finally {
				starts.delete(id);
			}
		})();
		starts.set(id, begun);
		return track(begun);
	}

	/** The first prompt of a queued ticket: its request (or the recovery note when its session exists) and its pending messages. */
	function queuedPrompt(ticket: Ticket): { prompt: string; resume: boolean } {
		const resume = ticket.sessionFile !== undefined;
		const head = resume ? deps.recoveryNote : deps.requestPrompt(ticket);
		const pending = ticket.pending ?? [];
		return { prompt: pending.length ? `${head}\n\n${messagesBlock(pending)}` : head, resume };
	}

	/**
	 * Whether a queued ticket's `after` tickets let it start: all merged. A closed (or missing) one fails it, as it can
	 * never start; its `after` is cleared, so a message from the user starts it anyway.
	 */
	function dependenciesAllow(ticket: Ticket): boolean {
		for (const dep of ticket.after ?? []) {
			const other = store.get(dep);
			if (other?.state === "merged") continue;
			if (other && other.state !== "closed") return false;
			const why = other ? `was closed${other.closedReason ? ` (${other.closedReason})` : ""}` : "does not exist";
			const error = `ticket #${dep}, which this ticket starts after, ${why}, so it will never be merged. Send a message to start this ticket anyway, or close it.`;
			deps.notify(update(ticket.id, { state: "failed", error, after: undefined }, { type: "failed", error, dependency: dep }), "failed");
			return false;
		}
		return true;
	}

	/** Starts this session's queued tickets, lowest id first, while worker slots are free; tickets wait for their `after` tickets. */
	function drain(): Promise<void> {
		if (closing) return Promise.resolve();
		const started: Promise<void>[] = [];
		const queued = store.list().filter((ticket) => ticket.state === "queued" && held.has(ticket.id) && !runs.has(ticket.id));
		for (const ticket of queued) {
			if (!dependenciesAllow(ticket)) continue;
			if (runs.size >= settings().maxWorkers) break;
			const { prompt, resume } = queuedPrompt(ticket);
			started.push(start(ticket, prompt, resume, "started"));
		}
		return Promise.all(started).then(() => undefined);
	}

	async function create(input: CreateInput): Promise<Ticket> {
		if (closing) throw new DispatchError("This session is shutting down.");
		const title = input.title.replace(/\s+/g, " ").trim();
		if (!title) throw new DispatchError("A ticket needs a title.");
		if (!input.request.trim()) throw new DispatchError("A ticket needs a request.");
		const after = [...new Set(input.after ?? [])];
		for (const dep of after) {
			const other = store.get(dep);
			if (!other) throw new DispatchError(`Ticket #${dep} (in after) does not exist.`);
			if (other.state === "closed") throw new DispatchError(`Ticket #${dep} (in after) is closed; it will never be merged.`);
		}
		const base = await git.revParse(repo.topLevel);
		const target = await git.branch(repo.topLevel);
		let ticket = store.create({
			title, request: input.request, source: input.source || input.request, ...(input.note?.trim() ? { note: input.note.trim() } : {}),
			createdBy: owner.sessionId, base, ...(target !== undefined ? { target } : {}),
		}, owner.sessionId);
		try {
			let branch: string | undefined;
			for (const candidate of deps.branchCandidates(ticket.id, ticket.slug)) {
				if (!await git.branchExists(repo, candidate)) { branch = candidate; break; }
			}
			if (!branch) throw new Error(`no free branch name for ${ticket.branch}`);
			if (branch !== ticket.branch) ticket = update(ticket.id, { branch }, { type: "branch", branch });
			const pending = after.filter((dep) => store.get(dep)?.state !== "merged");
			if (pending.length || input.mergeWhenReady) {
				ticket = update(ticket.id, { ...(pending.length ? { after: pending } : {}), ...(input.mergeWhenReady ? { mergeWhenReady: true } : {}) },
					{ type: "options", ...(pending.length ? { after: pending } : {}), ...(input.mergeWhenReady ? { mergeWhenReady: true } : {}) });
			}
			await git.addWorktree(repo, ticket.worktree, branch, base);
		} catch (error) {
			const closed = update(ticket.id, { state: "closed", closedReason: `could not create the worktree: ${errorText(error)}` }, { type: "closed", reason: errorText(error) });
			throw new DispatchError(`Ticket #${closed.id} could not be set up: ${errorText(error)}`);
		}
		ticket = own(ticket);
		if (input.parentToolCallId !== undefined) toolCalls.set(ticket.id, input.parentToolCallId);
		await drain();
		return store.get(ticket.id)!;
	}

	async function send(id: number, text: string): Promise<SendResult> {
		if (!text.trim()) throw new DispatchError("The message is empty.");
		let ticket = own(require(id));
		await starts.get(id);
		ticket = store.get(id)!;
		if (!isOpen(ticket)) throw new DispatchError(`Ticket #${id} is ${ticket.state}; it takes no more work.`);
		if (ticket.state === "queued") {
			ticket = update(id, { pending: [...(ticket.pending ?? []), text] }, { type: "message", delivery: "queued", text });
			await drain();
			const after = store.get(id)!;
			return { ticket: after, delivery: after.state === "queued" ? "queued" : "started" };
		}
		const host = workers();
		if (host.isLive(id)) {
			// State and run first: a short run may end before `send` resolves.
			const wasRunning = running(id);
			const before = ticket;
			if (!wasRunning) { runs.add(id); finals.delete(id); }
			update(id, { state: "working", question: undefined, error: undefined });
			let delivery: "steered" | "prompted" | "reopened";
			try {
				delivery = await host.send(id, text);
			} catch (error) {
				if (!wasRunning) runs.delete(id);
				update(id, { state: before.state, question: before.question, error: before.error }, { type: "message-failed", error: errorText(error) });
				throw new DispatchError(`Could not deliver the message to #${id}: ${errorText(error)}`);
			}
			const after = update(id, {}, { type: "message", delivery, text });
			return { ticket: after, delivery };
		}
		// No live session: reopen it from its file (with the recovery note after an interruption), or start one.
		if (ticket.sessionFile !== undefined) {
			const prompt = ticket.state === "interrupted" ? `${deps.recoveryNote}\n\n${text}` : text;
			await start(ticket, prompt, true, "reopened");
			update(id, {}, { type: "message", delivery: "reopened", text });
			return { ticket: store.get(id)!, delivery: "reopened" };
		}
		await start(ticket, `${deps.requestPrompt(ticket)}\n\n${messagesBlock([text])}`, false, "started");
		update(id, {}, { type: "message", delivery: "started", text });
		return { ticket: store.get(id)!, delivery: "started" };
	}

	function onEvent(event: WorkerEvent): void {
		try {
			const ticket = store.get(event.ticketId);
			if (!ticket || !isOpen(ticket)) return;
			if (event.type === "session") {
				const patch: Partial<Ticket> = {};
				if (event.sessionFile !== undefined && event.sessionFile !== ticket.sessionFile) patch.sessionFile = event.sessionFile;
				if (event.model !== undefined && event.model !== ticket.model) patch.model = event.model;
				if (event.agentId !== undefined && event.agentId !== ticket.agentId) patch.agentId = event.agentId;
				if (Object.keys(patch).length) update(ticket.id, patch, { type: "session", ...patch });
			} else if (event.type === "report") onReport(ticket, event.report);
			else track(onRunEnd(ticket, event));
		} catch {
			// A store failure must not reach the worker session.
		}
	}

	function onReport(ticket: Ticket, report: TicketReport): void {
		const id = ticket.id;
		const event = { type: "report", report };
		if (FINAL_REPORTS.has(report.state)) finals.set(id, report.state);
		if (closing || stopping.has(id)) { update(id, { report }, event); return; }
		switch (report.state) {
			case "progress":
				if (report.question) deps.notify(update(id, { state: "question", question: report.question, report }, event), "question");
				else update(id, { report }, event);
				return;
			case "dropped":
				// Closed once the run ends, so the worker is not disposed inside its own tool call.
				update(id, { report }, event);
				return;
			case "ready": {
				const after = update(id, { state: "ready", question: undefined, report, error: undefined }, event);
				// A requested (or wanted-when-ready) merge runs when the run ends; its outcome is the report.
				if (!after.mergeRequested && !after.mergeWhenReady) track(notifyReady(after));
				return;
			}
			case "blocked": case "failed":
				deps.notify(update(id, { state: report.state, question: report.question, report, ...(report.state === "failed" ? { error: report.summary } : {}) }, event), report.state);
		}
	}

	async function notifyReady(ticket: Ticket): Promise<void> {
		deps.notify(ticket, "ready", await compare(ticket));
	}

	async function compare(ticket: Ticket): Promise<NotifyExtra> {
		const target = await git.branch(repo.topLevel).catch(() => undefined) ?? ticket.target ?? ticket.base;
		const extra: NotifyExtra = { target };
		try { extra.ahead = (await git.aheadBehind(repo, ticket.branch, target)).ahead; } catch {}
		try { extra.files = await git.changedFiles(repo, ticket.branch, target); } catch {}
		return extra;
	}

	async function onRunEnd(ticket: Ticket, event: Extract<WorkerEvent, { type: "run_end" }>): Promise<void> {
		const id = ticket.id;
		runs.delete(id);
		const first = firstRuns.delete(id);
		const final = event.reported && FINAL_REPORTS.has(event.reported) ? event.reported : finals.get(id);
		finals.delete(id);
		const lastText = event.text.trim() ? cut(event.text) : ticket.lastText;
		const ended = { type: "run_end", toolCalls: event.toolCalls, ...(event.error ? { error: event.error } : {}), ...(event.aborted ? { aborted: true } : {}), ...(final ? { reported: final } : {}) };
		if (closing || stopping.has(id)) { update(id, { lastText }, ended); return; }
		try {
			if (event.error || event.aborted) {
				deps.notify(update(id, { state: "failed", lastText, error: event.error ?? "the run was aborted" }, ended), "failed");
			} else if (event.toolCalls === 0 && first) {
				deps.notify(update(id, { state: "failed", lastText, error: NO_TOOL_ERROR }, ended), "failed");
			} else if (final === "dropped") {
				update(id, { lastText }, ended);
				const report = store.get(id)!.report;
				await closeTicket(id, `nothing to do: ${report?.state === "dropped" ? report.summary : "the worker dropped the ticket"}`, true);
			} else if (final) {
				const after = update(id, { lastText }, ended);
				if (after.state === "ready" && (after.mergeRequested || after.mergeWhenReady)) await rerunMerge(after);
			} else if (ticket.state === "question" && store.get(id)?.question) {
				// The question stays the thing to answer; the run's text is kept.
				update(id, { lastText }, ended);
			} else {
				deps.notify(update(id, { state: "waiting", lastText }, ended), "waiting");
			}
		} finally {
			await drain();
		}
	}

	async function rerunMerge(ticket: Ticket): Promise<void> {
		const outcome = await merge(ticket.id).catch((error): MergeOutcome => ({ kind: "refused", reason: errorText(error) }));
		if (outcome.kind === "refused") {
			const after = update(ticket.id, { mergeRequested: undefined }, { type: "merge", outcome: "refused", reason: outcome.reason });
			deps.notify(after, "merge-refused", { reason: outcome.reason, ...await compare(after) });
		}
	}

	function mergeDeps(): MergeDeps {
		return {
			store, git, repo,
			isRunning: (id) => running(id),
			send: async (id, text) => { await send(id, text); },
			stop: async (id) => { stopping.add(id); try { await host?.stop(id); } finally { stopping.delete(id); runs.delete(id); } },
		};
	}

	async function merge(id: number): Promise<MergeOutcome> {
		own(require(id));
		await starts.get(id);
		const outcome = await deps.mergeTicket(mergeDeps(), id);
		let ticket = store.get(id)!;
		if (outcome.kind === "merged") {
			if (ticket.state !== "merged") ticket = update(id, { state: "merged", mergedAt: now(), mergedInto: outcome.into, mergeRequested: undefined, question: undefined }, { type: "merged", into: outcome.into });
			if (host?.isLive(id)) await mergeDeps().stop(id).catch(() => {});
			release(id);
			deps.notify(ticket, "merged", { ahead: outcome.commits, target: outcome.into });
			void drain();
		} else if (outcome.kind === "handed-to-worker") {
			if (!ticket.mergeRequested) ticket = update(id, { mergeRequested: true }, { type: "merge", outcome: "handed-to-worker" });
			deps.notify(ticket, "merge-handed", { reason: outcome.reason });
		}
		return outcome;
	}

	async function mergeWhenReady(id: number): Promise<MergeWhenReadyResult> {
		own(require(id));
		await starts.get(id);
		let ticket = store.get(id)!;
		if (ticket.state === "ready" && !running(id)) return { ticket, outcome: await merge(id) };
		if (!ticket.mergeWhenReady) ticket = update(id, { mergeWhenReady: true }, { type: "merge-when-ready" });
		return { ticket };
	}

	async function closeTicket(id: number, reason: string, dropped: boolean): Promise<Ticket> {
		stopping.add(id);
		try {
			await starts.get(id);
			if (host?.isLive(id) || running(id)) await host?.stop(id);
			runs.delete(id);
			const ticket = store.get(id)!;
			await git.removeWorktree(repo, ticket.worktree);
			const closed = update(id, { state: "closed", closedReason: reason, question: undefined, pending: undefined, mergeRequested: undefined, mergeWhenReady: undefined }, { type: "closed", reason });
			release(id);
			if (dropped) deps.notify(closed, "dropped");
			return closed;
		} finally {
			stopping.delete(id);
		}
	}

	async function close(id: number, reason: string): Promise<Ticket> {
		own(require(id));
		const closed = await closeTicket(id, reason.trim() || "closed by the user", false);
		void drain();
		return closed;
	}

	async function resume(id: number): Promise<{ ticket: Ticket; action: ResumeAction }> {
		let ticket = own(require(id));
		await starts.get(id);
		ticket = store.get(id)!;
		if (host?.isLive(id)) return { ticket, action: "live" };
		if (ticket.state === "interrupted" || ticket.state === "queued") {
			if (ticket.state === "interrupted") ticket = update(id, { state: "queued", error: undefined }, { type: "resumed" });
			await drain();
			ticket = store.get(id)!;
			return { ticket, action: ticket.state === "queued" ? "queued" : "started" };
		}
		return { ticket, action: "owned" };
	}

	async function inspect(id: number): Promise<TicketInfo> {
		const ticket = store.get(id);
		if (!ticket) throw new DispatchError(`Ticket #${id} does not exist.`);
		const holder = store.holder(id);
		const info: TicketInfo = { ticket, holder, mine: ticket.owner === owner.sessionId, live: host?.isLive(id) ?? false, running: running(id) };
		if (ticket.state === "merged") return info;
		const extra = await compare(ticket);
		info.target = extra.target;
		info.ahead = extra.ahead;
		info.files = extra.files;
		try { info.behind = (await git.aheadBehind(repo, ticket.branch, extra.target!)).behind; } catch {}
		return info;
	}

	function summary(): DispatchSummary {
		const open = store.list().filter(isOpen);
		const mine = open.filter((ticket) => ticket.owner === owner.sessionId);
		const lines: string[] = [];
		for (const ticket of open) {
			const waits = ticket.state === "queued" && ticket.after?.length ? `, starts after ${ticket.after.map((dep) => `#${dep}`).join(", ")} merge${ticket.after.length === 1 ? "s" : ""}` : "";
			const merges = ticket.mergeWhenReady ? ", merges when ready" : "";
			lines.push(`#${ticket.id} [${ticket.state}] ${ticket.title} — branch ${ticket.branch}${waits}${merges}${ticket.owner === owner.sessionId ? "" : " (another session's)"}`);
			if (ticket.question) lines.push(`  question: ${cut(ticket.question.replace(/\s+/g, " "), 300)}`);
		}
		return {
			open,
			text: lines.length ? `Open tickets:\n${lines.join("\n")}` : "",
			working: mine.filter((ticket) => ticket.state === "working" || (ticket.state === "question" && running(ticket.id))).length,
			attention: mine.filter((ticket) => ATTENTION_STATES.has(ticket.state)).length,
			queued: mine.filter((ticket) => ticket.state === "queued").length,
		};
	}

	function startup(): void {
		for (const ticket of store.list()) {
			if (!isOpen(ticket) || (ticket.state !== "working" && ticket.state !== "queued")) continue;
			if (store.holder(ticket.id)) continue;
			try {
				update(ticket.id, { state: "interrupted", error: `Pi stopped while the ticket was ${ticket.state}` }, { type: "interrupted", from: ticket.state, reason: "no live lock at startup" });
			} catch {}
		}
	}

	function shutdown(): Promise<void> {
		return shut ??= (async () => {
			closing = true;
			clearInterval(timer);
			timer = undefined;
			const active = new Set(runs);
			try { await host?.disposeAll(); } catch {}
			for (const id of held) {
				const ticket = store.get(id);
				if (!ticket || !isOpen(ticket)) continue;
				const state: TicketState = ticket.state;
				if (state === "working" || state === "queued" || active.has(id)) {
					try { update(id, { state: "interrupted", error: `Pi stopped while the ticket was ${state}` }, { type: "interrupted", from: state, reason: "session shutdown" }); } catch {}
				}
			}
			for (const id of [...held]) release(id);
			runs.clear();
		})();
	}

	return {
		sessionId: owner.sessionId,
		create, send, merge, mergeWhenReady, close, resume, inspect, summary, startup, shutdown,
		get: (id) => store.get(id),
		list: (all = false) => store.list().filter((ticket) => all || isOpen(ticket)),
		held: () => [...held],
		isRunning: running,
		async idle() {
			while (work.size) await Promise.allSettled([...work]);
		},
	};
}

/** Follow-up messages appended to a first prompt. */
export function messagesBlock(messages: readonly string[]): string {
	return messages.length === 1
		? `Message from the user:\n\n${messages[0]}`
		: `Messages from the user, in order:\n\n${messages.map((text, index) => `${index + 1}. ${text}`).join("\n\n")}`;
}
