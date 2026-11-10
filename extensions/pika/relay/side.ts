/**
 * Side answers (`services/pika/docs/RELAY.md`, Side answers): a message from another session that a busy session
 * has not read within `sideAnswerSeconds` is answered by one model request beside the turn. The request repeats the
 * turn's last model request, so it reads that request's cached prefix, and adds what the turn produced since. Tool
 * calls it returns are never run. Nothing here touches the relay connection.
 */
import { convertToLlm, type ContextWithSystemEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deviceLabel, headerField, type MessageFrame, sanitize, since } from "./protocol.ts";

type AgentMessage = ContextWithSystemEvent["messages"][number];
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** The custom message that tells the turn what a side request answered for it. */
export const SIDE_TYPE = "relay-side";
/** What starts a side answer or a busy notice; a session never side-answers a message that starts with either. */
export const SIDE_MARK = "[side answer]";
export const BUSY_MARK = "[busy notice]";
export const automatic = (text: string): boolean => text.startsWith(SIDE_MARK) || text.startsWith(BUSY_MARK);

/** A top-level tool call of the turn that has not finished. */
export interface Running { name: string; startedAt: number }

/** A message waiting for a side answer. `soon`: pi steered it, so the turn reads it after its current tool calls. */
export interface SideJob { frame: MessageFrame; label: string; soon: boolean; at: number }

/** What a side request answered during the turn, so the next one stays consistent with it. */
export interface SideAnswer { id: string; label: string; text: string }

export type SideOutcome = { kind: "answer"; text: string } | { kind: "defer"; reason: string } | { kind: "none" };

export interface SideDetails { id: string; replyId: string; label: string; question: string; text: string }

/**
 * The turn's last model request, as the last `context_with_system` handler left it, and the assistant messages and
 * tool results that followed it.
 */
export class Transcript {
	private request?: AgentMessage[];
	private after: AgentMessage[] = [];

	onRequest(messages: AgentMessage[]): void {
		this.request = messages;
		this.after = [];
	}

	onMessageEnd(message: AgentMessage): void {
		if (!this.request) return;
		if (message.role === "toolResult" || (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted")) this.after.push(message);
	}

	clear(): void {
		this.request = undefined;
		this.after = [];
	}

	/** The request, what followed it, and a placeholder result for every tool call without one; undefined before any request. */
	snapshot(running: ReadonlyMap<string, Running>, now = Date.now()): AgentMessage[] | undefined {
		if (!this.request) return undefined;
		const done = new Set(this.after.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []));
		const pending = this.after.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) => part.type === "toolCall" && !done.has(part.id) ? [part] : []) : []);
		return [...this.request, ...this.after, ...pending.map((call): AgentMessage => {
			const run = running.get(call.id);
			const text = run ? `This tool call is still running (for ${since(run.startedAt, now)}); its result is not available yet.` : "This tool call has not finished; its result is not available yet.";
			return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: now };
		})];
	}
}

/** "pi session <id> ("name") on <device>, project <p>": every part comes from another device. */
function senderText(frame: MessageFrame): string {
	if (frame.from.kind !== "session") return "your user in the pika web UI";
	const name = headerField(frame.from.name) || headerField(frame.from.title);
	const project = headerField(frame.from.project);
	return `pi session ${headerField(frame.from.sessionId)}${name ? ` ("${name}")` : ""} on ${deviceLabel(frame.from)}${project ? `, project ${project}` : ""}`;
}

/** The user message a side request ends with. */
export function sideRequest(job: SideJob, earlier: readonly SideAnswer[], now = Date.now()): string {
	const { frame } = job;
	const room = headerField(frame.room);
	const replyTo = headerField(frame.replyTo);
	const header = `Message ${headerField(frame.id)}${room ? ` in room #${room}` : ""} from ${senderText(frame)}${replyTo ? `, replying to ${replyTo}` : ""}, received ${since(job.at, now)} ago:`;
	const answered = earlier.length
		? `\n\nWhile this turn runs, side requests already answered:\n${earlier.map((answer) => `- message ${answer.id} from ${answer.label}: ${answer.text}`).join("\n")}`
		: "";
	return `[relay side request] Your current turn is still working. This request runs beside it: nothing written here reaches that turn, your user, or a tool, and you cannot call tools now. Another pi session sent you this message through pika relay and waits for an answer:\n\n${header}\n\n${sanitize(frame.text)}${answered}\n\n`
		+ "Reply in exactly one of these forms:\n"
		+ "- NO_REPLY, when the message needs no answer: it answers you, acknowledges, or only informs.\n"
		+ "- DEFER: <one line>, when an answer needs an action, a decision, a commitment, your user, or facts this conversation does not show; the line says what it needs.\n"
		+ "- Otherwise the answer itself, written to the sender and as short as it can be. Use only what this conversation shows, say what is still uncertain or in progress, and promise no work on behalf of your turn.";
}

export function parseSide(text: string): SideOutcome {
	const trimmed = text.trim();
	if (/^NO_REPLY\b/.test(trimmed)) return { kind: "none" };
	const defer = /^DEFER\b:?\s*(.*)/.exec(trimmed);
	if (defer || !trimmed) return { kind: "defer", reason: (defer?.[1] ?? "").trim().slice(0, 300) };
	return { kind: "answer", text: trimmed };
}

/** One side request through the session's model and thinking level; undefined without a model, or when it fails. */
export async function askSide(ctx: ExtensionContext, thinking: ThinkingLevel, messages: AgentMessage[], signal: AbortSignal): Promise<SideOutcome | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	// No `toolChoice`: a request that changes it loses the cached messages (Anthropic), and its tool calls are never run.
	const stream = ctx.modelRegistry.streamSimple(model, { messages: convertToLlm(messages) }, {
		signal,
		sessionId: ctx.sessionManager.getSessionId(),
		// As the turn's own requests set it.
		...(thinking === "off" ? {} : { reasoning: thinking }),
	});
	// A provider that ignores the signal must not hold every later side request.
	const aborted = new Promise<undefined>((resolve) => {
		if (signal.aborted) resolve(undefined);
		else signal.addEventListener("abort", () => resolve(undefined), { once: true });
	});
	const message = await Promise.race([stream.result(), aborted]);
	if (!message || message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
	if (!text.trim() && message.content.some((part) => part.type === "toolCall")) return { kind: "defer", reason: "the answer needs tool calls" };
	return parseSide(text);
}

/** What the sender gets for a side answer. */
export const answerText = (answer: string): string =>
	`${SIDE_MARK} This session's current turn is still running, so a side request answered your message from its conversation so far, without tools. The turn reads your message later and corrects this answer if it needs to.\n\n${answer}`;

/** What the sender gets when no side answer came: how long the turn has run, and when it reads the message. */
export function busyText(job: SideJob, turnStartedAt: number | undefined, tool: Running | undefined, reason: string, now = Date.now()): string {
	const turn = turnStartedAt === undefined ? "its current turn is still running" : `its current turn has run for ${since(turnStartedAt, now)}`;
	const running = tool ? `, and it has been running ${tool.name} for ${since(tool.startedAt, now)}` : "";
	const when = job.soon ? "after its current tool calls" : "when that turn ends";
	return `${BUSY_MARK} This session has not read your message ${headerField(job.frame.id)} yet: ${turn}${running}. It reads your message ${when}.${reason ? ` It could not answer from its conversation so far: ${reason}` : ""}`;
}

/**
 * What the turn reads, steered in before the message itself, which pi may hold until the turn ends and then deliver
 * in a turn of its own: the turn knows the answer before it would answer again.
 */
export function sideNote(details: SideDetails): string {
	const id = headerField(details.id);
	return `[relay] While this turn ran, a side request answered message ${id} from ${details.label} for you, from this conversation and without tools. The message:\n\n${sanitize(details.question)}\n\nThe answer (message ${headerField(details.replyId)}):\n\n${sanitize(details.text)}\n\n`
		+ `You read message ${id} itself later. If that answer is wrong or incomplete, send ${details.label} a correction with replyTo "${id}"; otherwise do not answer message ${id} again.`;
}

export interface SchedulerDeps {
	/** Whether the message is still unread while the session is busy, so a side request should handle it. */
	waiting(id: string): boolean;
	run(job: SideJob, signal: AbortSignal): Promise<void>;
}

/** Times each waiting message and runs one side request at a time, in the order the messages became due. */
export class SideScheduler {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly due: SideJob[] = [];
	private active?: { id: string; controller: AbortController };

	constructor(private readonly deps: SchedulerDeps) {}

	schedule(job: SideJob, afterMs: number): void {
		const id = job.frame.id;
		clearTimeout(this.timers.get(id));
		const timer = setTimeout(() => {
			this.timers.delete(id);
			if (!this.deps.waiting(id)) return;
			this.due.push(job);
			this.pump();
		}, afterMs);
		timer.unref?.();
		this.timers.set(id, timer);
	}

	/** The model read the message: it needs no side request, and one running for it is aborted. */
	read(id: string): void {
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		const index = this.due.findIndex((job) => job.frame.id === id);
		if (index >= 0) this.due.splice(index, 1);
		if (this.active?.id === id) this.active.controller.abort();
	}

	clear(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.due.length = 0;
		this.active?.controller.abort();
	}

	private pump(): void {
		if (this.active) return;
		const job = this.due.shift();
		if (!job) return;
		if (!this.deps.waiting(job.frame.id)) { this.pump(); return; }
		const active = { id: job.frame.id, controller: new AbortController() };
		this.active = active;
		void this.deps.run(job, active.controller.signal).catch(() => undefined).finally(() => {
			if (this.active === active) this.active = undefined;
			this.pump();
		});
	}
}
