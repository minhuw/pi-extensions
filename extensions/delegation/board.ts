import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/*
 * The swarm board: a kanban board a coordinator session and its subagents share, in a registry other extensions in the
 * Pi process read (pika displays it). Cross-extension contract, keep this shape:
 *
 *   globalThis[Symbol.for("pi-extensions.swarm-boards")]: SwarmBoards — whoever needs it first creates it with ??=.
 *   interface SwarmBoards { version: 1; boards: Map<string, SwarmBoard>; listeners: Set<(board: SwarmBoard) => void> }
 *   interface SwarmBoard { version: 1; sessionId: string; updatedAt: number; cards: SwarmCard[] }
 *   type CardStatus = "todo" | "doing" | "blocked" | "done" | "failed" | "dropped";
 *   interface SwarmCard { id: string; title: string; status: CardStatus; agentId?: string; agent?: string; note?: string;
 *     createdBy: string; updatedBy: string; createdAt: number; updatedAt: number }
 *
 * `boards` is keyed by the coordinator's session id (`SwarmBoard.sessionId`). Card ids are `c1`, `c2`, … in creation
 * order. `agentId` links a card to a Subagents agent, and `agent` is its display label (the agent type; the title
 * carries its description). `createdBy` and `updatedBy` are "coordinator" or the agent id of the subagent that wrote.
 * Every mutation replaces the board object in `boards`, with a later `updatedAt`, and then calls every listener with
 * it: treat boards as immutable. A coordinator's board leaves `boards` when its session shuts down, without a call.
 */

const BOARDS = Symbol.for("pi-extensions.swarm-boards");
const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");
const SESSION_MODES = Symbol.for("pi-extensions.session-modes");
const SESSION_LINK_TYPE = "pi-extensions.session-link";
/** The coordinator's snapshot entries: the latest on the branch is its board. */
const ENTRY_TYPE = "swarm-board";
/** A child's section text, fixed at its first run so a reopened child sends the same prompt. */
const SECTION_ENTRY_TYPE = "swarm-board-section";
const SECTION = "swarm-board";
const TOOL = "swarm_board";
/** The child-session hook's name; Subagents admits its tools where an agent's `extensions:` admits the name. */
const HOOK_NAME = "swarm-board";
/** How long changes from outside the coordinator's own tool calls (children, telemetry) gather before one snapshot. */
const PERSIST_DELAY_MS = 100;
const COORDINATOR = "coordinator";

export const MAX_TITLE_CHARS = 240;
export const MAX_NOTE_CHARS = 500;
export const MAX_CARDS = 200;
export const MAX_BYTES = 60 * 1024;

type CardStatus = "todo" | "doing" | "blocked" | "done" | "failed" | "dropped";

export interface SwarmCard {
	id: string;
	title: string;
	status: CardStatus;
	agentId?: string;
	agent?: string;
	note?: string;
	createdBy: string;
	updatedBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface SwarmBoard {
	version: 1;
	sessionId: string;
	updatedAt: number;
	cards: SwarmCard[];
	nextId?: number;
}

interface CoordinatorInstance {
	isActive(): boolean;
}

/** The modes each top-level session has on, shared in the process: Relay reads it, as a room's representative needs swarm mode. */
export interface SessionModesRegistry {
	/** Mode names ("swarm") active on each top-level session's current branch, by session id. */
	modes: Map<string, Set<string>>;
	/** Called with a session id whenever its set changes. */
	listeners: Set<(sessionId: string) => void>;
}

export interface SwarmBoards {
	version: 1;
	boards: Map<string, SwarmBoard>;
	listeners: Set<(board: SwarmBoard) => void>;
	/** Not part of the contract: each subagent session's coordinator session, nested children included. */
	members?: Map<string, string>;
	/** Not part of the contract: open coordinator instances in this process, for dynamic child-hook sync. */
	coordinators?: Set<CoordinatorInstance>;
}

const STATUSES: readonly CardStatus[] = ["doing", "blocked", "todo", "done", "failed", "dropped"];
const OPEN: readonly CardStatus[] = ["doing", "blocked", "todo"];
const TERMINAL: readonly CardStatus[] = ["done", "failed", "dropped"];

/** The registry, created here unless another extension came first. */
export function swarmBoards(): SwarmBoards {
	const shared = globalThis as Record<symbol, unknown>;
	return (shared[BOARDS] ??= { version: 1, boards: new Map(), listeners: new Set() }) as SwarmBoards;
}

const members = () => (swarmBoards().members ??= new Map());
const coordinators = () => (swarmBoards().coordinators ??= new Set());

/** The registry, created here unless another extension came first. */
export function sessionModes(): SessionModesRegistry {
	const shared = globalThis as Record<symbol, unknown>;
	return (shared[SESSION_MODES] ??= { modes: new Map(), listeners: new Set() }) as SessionModesRegistry;
}

function unsubscribeModeListener(listener: (sessionId: string) => void): void {
	const registry = (globalThis as Record<symbol, unknown>)[SESSION_MODES] as SessionModesRegistry | undefined;
	registry?.listeners.delete(listener);
}

/** Replace a coordinator's board and tell every listener. A failing listener is logged and does not stop the others. */
function publish(board: SwarmBoard): void {
	const registry = swarmBoards();
	registry.boards.set(board.sessionId, board);
	syncChildHook();
	for (const listener of [...registry.listeners]) {
		try {
			const result: unknown = listener(board);
			if (result instanceof Promise) result.catch((error: unknown) => console.error("swarm board listener failed:", error));
		} catch (error) {
			console.error("swarm board listener failed:", error);
		}
	}
}

/** Strictly later than the board's last change, so each snapshot has its own `updatedAt`. */
const nextTime = (board: SwarmBoard | undefined) => Math.max(Date.now(), (board?.updatedAt ?? 0) + 1);

const maxCardNum = (cards: readonly SwarmCard[]) =>
	Math.max(0, ...cards.map((card) => Number(/^c(\d+)$/.exec(card.id)?.[1] ?? 0)));

const initialNextId = (board: SwarmBoard | undefined) =>
	Math.max(board?.nextId ?? 1, maxCardNum(board?.cards ?? []) + 1);

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

const formatTitle = (text: string) => truncate(oneLine(text), MAX_TITLE_CHARS);

function formatNote(text?: string): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? truncate(trimmed, MAX_NOTE_CHARS) : undefined;
}

const serializedBytes = (sessionId: string, updatedAt: number, cards: SwarmCard[]) =>
	Buffer.byteLength(JSON.stringify({ version: 1, sessionId, updatedAt, cards }), "utf8");

/** Evict oldest settled cards when card count or serialized size exceeds bounds; never silently delete open cards. */
function trimBoard(sessionId: string, now: number, cards: SwarmCard[]): void {
	while (cards.length > MAX_CARDS || serializedBytes(sessionId, now, cards) > MAX_BYTES) {
		let oldestIndex = -1;
		let oldestUpdatedAt = Infinity;
		for (let i = 0; i < cards.length; i++) {
			const card = cards[i]!;
			if (!TERMINAL.includes(card.status)) continue;
			if (card.updatedAt < oldestUpdatedAt) {
				oldestUpdatedAt = card.updatedAt;
				oldestIndex = i;
			}
		}
		if (oldestIndex === -1) break;
		cards.splice(oldestIndex, 1);
	}
}

/** Apply `change` to a copy of the coordinator's cards and publish the result. */
function mutate(sessionId: string, change: (cards: SwarmCard[], now: number, allocateId: () => string) => void): SwarmBoard {
	const current = swarmBoards().boards.get(sessionId);
	const now = nextTime(current);
	const cards = (current?.cards ?? []).map((card) => ({ ...card }));
	let nextId = initialNextId(current);
	const allocateId = () => {
		const id = Math.max(nextId, maxCardNum(cards) + 1);
		nextId = id + 1;
		return `c${id}`;
	};
	change(cards, now, allocateId);
	nextId = Math.max(nextId, maxCardNum(cards) + 1);
	trimBoard(sessionId, now, cards);
	const board: SwarmBoard = { version: 1, sessionId, updatedAt: now, cards, nextId };
	publish(board);
	return board;
}

function newCard(
	cards: SwarmCard[],
	now: number,
	allocateId: () => string,
	fields: Omit<SwarmCard, "id" | "createdAt" | "updatedAt" | "updatedBy">,
): SwarmCard {
	const title = formatTitle(fields.title);
	const note = formatNote(fields.note);
	const { note: _ignoredNote, ...rest } = fields;
	const card: SwarmCard = {
		id: allocateId(),
		...rest,
		title,
		...(note ? { note } : {}),
		updatedBy: fields.createdBy,
		createdAt: now,
		updatedAt: now,
	};
	cards.push(card);
	return card;
}

function findCard(cards: SwarmCard[], id: string): SwarmCard {
	const card = cards.find((candidate) => candidate.id === id);
	if (!card) throw new Error(`No card ${id} on the swarm board.`);
	return card;
}

function cardLine(card: SwarmCard): string {
	const agent = card.agent || card.agentId ? ` [${[card.agent, card.agentId].filter(Boolean).join(" ")}]` : "";
	return `- ${card.id}${agent} ${card.title}${card.note ? ` — ${card.note}` : ""}`;
}

/** The board grouped by status, open work first. */
export function formatBoard(board: SwarmBoard | undefined, statuses: readonly CardStatus[] = STATUSES): string {
	const cards = board?.cards ?? [];
	const groups = statuses.flatMap((status) => {
		const group = cards.filter((card) => card.status === status);
		return group.length ? [`${status}:\n${group.map(cardLine).join("\n")}`] : [];
	});
	return groups.length ? groups.join("\n") : "The swarm board has no cards.";
}

/** Open cards grouped by status, with a one-line count of settled cards when any exist. */
export function formatBoardCompact(board: SwarmBoard | undefined): string {
	const cards = board?.cards ?? [];
	if (cards.length === 0) return "The swarm board has no cards.";
	const openGroups = OPEN.flatMap((status) => {
		const group = cards.filter((card) => card.status === status);
		return group.length ? [`${status}:\n${group.map(cardLine).join("\n")}`] : [];
	});
	const settledParts = TERMINAL.flatMap((status) => {
		const count = cards.filter((card) => card.status === status).length;
		return count ? [`${count} ${status}`] : [];
	});
	const settledLine = settledParts.length ? `settled: ${settledParts.join(", ")}` : undefined;
	if (!openGroups.length) return settledLine ? `No open cards.\n${settledLine}` : "The swarm board has no cards.";
	return settledLine ? `${openGroups.join("\n")}\n${settledLine}` : openGroups.join("\n");
}

/** Remove all settled (done, failed, dropped) cards from a coordinator's board without publishing when none are removed. */
export function pruneSettled(sessionId: string): { removed: number; board: SwarmBoard | undefined } {
	const current = swarmBoards().boards.get(sessionId);
	if (!current) return { removed: 0, board: undefined };
	const removed = current.cards.filter((card) => TERMINAL.includes(card.status)).length;
	if (removed === 0) return { removed: 0, board: current };
	const board = mutate(sessionId, (cards) => {
		for (let i = cards.length - 1; i >= 0; i--) {
			if (TERMINAL.includes(cards[i]!.status)) cards.splice(i, 1);
		}
	});
	return { removed, board };
}

interface SessionLink { kind?: string; parentSessionId?: string; agentId?: string; agentType?: string; description?: string }

/** The session's link to its spawner, written by Subagents and Herder before the child's extensions bind. */
function sessionLink(ctx: ExtensionContext): SessionLink | undefined {
	let link: SessionLink | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === SESSION_LINK_TYPE) link = (entry.data ?? {}) as SessionLink;
	}
	return link;
}

/**
 * Top-level TUI and RPC sessions. Live children bind extensions with no mode, which Pi runs as print, and persisted
 * children carry a session link when child-session hooks are registered. `parentSession` cannot identify a child: Pi
 * also sets it on forks.
 */
export const isCoordinator = (ctx: ExtensionContext): boolean =>
	(ctx.mode === "tui" || ctx.mode === "rpc") && sessionLink(ctx) === undefined;

interface ChildRole { boardId: string; agentId: string; link: SessionLink }

/** A subagent child whose root coordinator has a board, recorded in `members` so its own children resolve to the root. */
function childRole(ctx: ExtensionContext): ChildRole | undefined {
	const link = sessionLink(ctx);
	if (link?.kind !== "subagent" || !link.agentId || !link.parentSessionId) return undefined;
	const registry = swarmBoards();
	const sessionId = ctx.sessionManager.getSessionId();
	const parent = link.parentSessionId;
	const boardId = members().get(sessionId) ?? (registry.boards.has(parent) ? parent : members().get(parent));
	if (!boardId || !registry.boards.has(boardId)) return undefined;
	members().set(sessionId, boardId);
	return { boardId, agentId: link.agentId, link };
}

interface BoardParams { action: string; id?: string; title?: string; status?: string; note?: string; agentId?: string; includeSettled?: boolean }

const result = (text: string, board: SwarmBoard | undefined) => ({ content: [{ type: "text" as const, text }], details: { board } });

const isStatus = (value: string): value is CardStatus => (STATUSES as readonly string[]).includes(value);
const trimOpt = (value?: string) => value?.trim() || undefined;

/** Attach `agentId` to `card`, absorbing an unmodified auto-created card for that agent instead of clashing. */
function linkAgent(cards: SwarmCard[], card: SwarmCard, agentId: string, explicitStatus: boolean): void {
	const other = cards.find((candidate) => candidate.agentId === agentId && candidate.id !== card.id);
	if (other) {
		const autoCreated = other.createdBy === COORDINATOR
			&& other.updatedBy === COORDINATOR
			&& !other.note
			&& (other.status === "doing" || other.status === "done" || other.status === "failed");
		if (!autoCreated) throw new Error(`Agent ${agentId} is already on card ${other.id}.`);
		cards.splice(cards.indexOf(other), 1);
		if (!card.agent && other.agent) card.agent = other.agent;
		if (card.status === "todo" && !explicitStatus) card.status = other.status;
	}
	card.agentId = agentId;
}

/** Ask Subagents to stop a linked running agent over `pi.events`; returns true iff Subagents confirmed the stop. */
async function stopLinkedAgent(pi: ExtensionAPI, agentId: string): Promise<boolean> {
	const requestId = randomUUID();
	let reply: { success?: boolean; error?: string } | undefined;
	const unsub = pi.events.on(`subagents:rpc:stop:reply:${requestId}`, (data) => {
		reply = data as { success?: boolean; error?: string };
	});
	try {
		pi.events.emit("subagents:rpc:stop", { requestId, agentId });
		// Subagents' handleRpc is async (awaits the handler before emitting the reply), so yield microtasks if needed.
		if (reply === undefined) await Promise.resolve();
		if (reply === undefined) await Promise.resolve();
	} finally {
		unsub();
	}
	return reply?.success === true;
}

async function coordinatorAction(pi: ExtensionAPI, sessionId: string, params: BoardParams) {
	const by = COORDINATOR;
	switch (params.action) {
		case "list": {
			const board = swarmBoards().boards.get(sessionId);
			return result(params.includeSettled ? formatBoard(board) : formatBoardCompact(board), board);
		}
		case "add": {
			const title = formatTitle(params.title ?? "");
			if (!title) throw new Error("add needs a title.");
			const rawStatus = trimOpt(params.status);
			const status = rawStatus ?? "todo";
			if (!isStatus(status)) throw new Error(`Unknown status ${status}.`);
			const note = formatNote(params.note);
			const agentId = trimOpt(params.agentId);
			let id = "";
			const board = mutate(sessionId, (cards, now, allocateId) => {
				const card = newCard(cards, now, allocateId, { title, status, ...(note ? { note } : {}), createdBy: by });
				if (agentId) linkAgent(cards, card, agentId, rawStatus !== undefined);
				id = card.id;
			});
			return result(`Added ${id}.\n${formatBoardCompact(board)}`, board);
		}
		case "update": case "drop": {
			const id = trimOpt(params.id);
			if (!id) throw new Error(`${params.action} needs a card id.`);
			const status = params.action === "drop" ? "dropped" : trimOpt(params.status);
			if (status !== undefined && !isStatus(status)) throw new Error(`Unknown status ${status}.`);
			const agentId = trimOpt(params.agentId);
			let droppedAgentId: string | undefined;
			const board = mutate(sessionId, (cards, now) => {
				const card = findCard(cards, id);
				if (agentId) linkAgent(cards, card, agentId, status !== undefined);
				if (params.action === "update" && params.title !== undefined) {
					const title = formatTitle(params.title);
					if (!title) throw new Error("A card's title cannot be empty.");
					card.title = title;
				}
				if (status) card.status = status;
				if (params.note !== undefined) {
					const note = formatNote(params.note);
					if (note) card.note = note;
					else delete card.note;
				}
				Object.assign(card, { updatedBy: by, updatedAt: now });
				if (params.action === "drop") droppedAgentId = card.agentId;
			});
			if (params.action === "drop" && droppedAgentId) {
				const sharedWithOpen = board.cards.some(
					(candidate) => candidate.id !== id && candidate.agentId === droppedAgentId && OPEN.includes(candidate.status),
				);
				if (!sharedWithOpen && await stopLinkedAgent(pi, droppedAgentId)) {
					return result(`Dropped ${id} (stopped agent ${droppedAgentId}).\n${formatBoardCompact(board)}`, board);
				}
			}
			return result(`${params.action === "drop" ? "Dropped" : "Updated"} ${id}.\n${formatBoardCompact(board)}`, board);
		}
		case "prune": {
			const { removed, board } = pruneSettled(sessionId);
			const summary = formatBoardCompact(board);
			return result(removed === 0 ? `No settled cards to prune.\n${summary}` : `Pruned ${removed} settled card(s).\n${summary}`, board);
		}
		default: throw new Error(`Unknown action ${params.action}: use list, add, update, drop, or prune.`);
	}
}

function childAction(role: ChildRole, params: BoardParams) {
	const { boardId, agentId, link } = role;
	switch (params.action) {
		case "list": {
			const board = swarmBoards().boards.get(boardId);
			const text = params.includeSettled ? formatBoard(board) : formatBoardCompact(board);
			return result(`Your card: ${ownCard(boardId, agentId)?.id ?? "none yet"}.\n${text}`, board);
		}
		case "note": {
			const note = formatNote(params.note);
			if (!note) throw new Error("note needs a note.");
			const status = trimOpt(params.status);
			if (status !== undefined && status !== "doing" && status !== "blocked") throw new Error("A subagent can set its own card only to doing or blocked; the coordinator settles cards.");
			let id = "";
			const board = mutate(boardId, (cards, now, allocateId) => {
				let card = cards.find((candidate) => candidate.agentId === agentId);
				if (card?.status === "dropped") throw new Error(`The coordinator dropped your card ${card.id}; stop and report back.`);
				card ??= newCard(cards, now, allocateId, { title: formatTitle(link.description || link.agentType || agentId), status: "doing", agentId, ...(link.agentType ? { agent: link.agentType } : {}), createdBy: agentId });
				Object.assign(card, { status: status ?? (TERMINAL.includes(card.status) || card.status === "todo" ? "doing" : card.status), note, updatedBy: agentId, updatedAt: now });
				id = card.id;
			});
			return result(`Noted on ${id}.\n${formatBoardCompact(board)}`, board);
		}
		case "add": {
			const title = formatTitle(params.title ?? "");
			if (!title) throw new Error("add needs a title.");
			const status = trimOpt(params.status);
			if (status !== undefined && status !== "todo") throw new Error("A subagent can add only todo cards.");
			const note = formatNote(params.note);
			let id = "";
			const board = mutate(boardId, (cards, now, allocateId) => {
				id = newCard(cards, now, allocateId, { title, status: "todo", ...(note ? { note } : {}), createdBy: agentId }).id;
			});
			return result(`Added ${id}.\n${formatBoardCompact(board)}`, board);
		}
		default: throw new Error(`A subagent can only list, note on its own card, and add todo cards; ${params.action} is for the coordinator.`);
	}
}

const ownCard = (boardId: string, agentId: string) => swarmBoards().boards.get(boardId)?.cards.find((card) => card.agentId === agentId);

/** The tool both sides run: what a call may do follows from the calling session. */
async function execute(pi: ExtensionAPI | undefined, isOn: ((ctx: ExtensionContext) => boolean) | undefined, params: BoardParams, ctx: ExtensionContext) {
	const role = childRole(ctx);
	if (role) return childAction(role, params);
	if (pi && isOn && isCoordinator(ctx)) {
		if (!isOn(ctx)) throw new Error("Swarm mode is off in this session, so the swarm board is closed. The user turns it on with /swarm.");
		return coordinatorAction(pi, ctx.sessionManager.getSessionId(), params);
	}
	throw new Error("This session has no swarm board.");
}

const optionalText = (description: string) => Type.Optional(Type.String({ description }));

const coordinatorTool = (pi: ExtensionAPI, isOn: (ctx: ExtensionContext) => boolean) => ({
	name: TOOL,
	label: "Swarm Board",
	description: "Kanban board you and your subagents share; agents you launch get cards automatically. list shows open cards and a settled summary (pass includeSettled: true for all); add a card (status defaults to todo); update id with title, status, note, or agentId (links a card to a launched agent); drop id cancels the card and stops any running linked agent; prune removes settled cards.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("drop"), Type.Literal("prune")]),
		id: optionalText("Card id, as c3, for update and drop."),
		title: optionalText("Card title."),
		status: Type.Optional(Type.Union(STATUSES.map((status) => Type.Literal(status)))),
		note: optionalText("Short progress or blocker note; empty clears it."),
		agentId: optionalText("Agent id to link the card to."),
		includeSettled: Type.Optional(Type.Boolean({ description: "For list: include done, failed, and dropped cards." })),
	}),
	async execute(_id: string, params: BoardParams, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
		return execute(pi, isOn, params, ctx);
	},
});

const childTool = {
	name: TOOL,
	label: "Swarm Board",
	description: "Kanban board shared with your coordinator and the other agents. list shows open cards and a settled summary (pass includeSettled: true for all); note posts progress on your own card (status doing, or blocked with the reason when you need the coordinator); add creates a todo card for follow-up work.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("list"), Type.Literal("note"), Type.Literal("add")]),
		note: optionalText("For note: progress or the blocker. For add: optional detail."),
		status: Type.Optional(Type.Union([Type.Literal("doing"), Type.Literal("blocked")])),
		title: optionalText("For add: the follow-up's title."),
		includeSettled: Type.Optional(Type.Boolean({ description: "For list: include done, failed, and dropped cards." })),
	}),
	async execute(_id: string, params: BoardParams, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
		return execute(undefined, undefined, params, ctx);
	},
};

const CHILD_SECTION = 'You are one of several agents sharing a swarm board with your coordinator. Call swarm_board with action "list" before editing files another card may own; post progress with note, set blocked with the reason when you need the coordinator, and add todo cards for follow-up work you find instead of doing it.';

export const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

/** Loaded into every child Subagents and Herder create; only a subagent of a coordinator with a board gets the board. */
const childExtension: ExtensionFactory = (pi) => {
	let section: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		section = undefined;
		const role = childRole(ctx);
		if (!role) return;
		// Always register childTool (replaces coordinatorTool if Delegation also loaded into the child).
		pi.registerTool(childTool);
		const fixed = ctx.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === SECTION_ENTRY_TYPE);
		if (fixed?.type === "custom") section = (fixed.data as { section?: string } | undefined)?.section;
		// A child that already talked without the section never gains one: that would rewrite its cached prefix.
		else if (!ctx.sessionManager.getEntries().some(isConversation)) {
			section = CHILD_SECTION;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (section === undefined || !pi.getActiveTools().includes(TOOL)) return undefined;
		if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SECTION_ENTRY_TYPE)) {
			pi.appendEntry(SECTION_ENTRY_TYPE, { section });
		}
		// Set on every run: Pi diffs each run's sections against the transcript, so a missing one would be removed.
		event.systemPromptOptions.sections[SECTION] = section;
		return undefined;
	});
};

const childHookEntry = { name: HOOK_NAME, extensionFactory: childExtension };

/** Keep the child-session hook registered iff at least one coordinator has swarm mode on or any board exists. */
function syncChildHook(): void {
	const registry = swarmBoards();
	const active = registry.boards.size > 0 || [...coordinators()].some((instance) => instance.isActive());
	const shared = globalThis as Record<symbol, unknown>;
	let hooks = shared[CHILD_SESSION_HOOKS] as Set<{ name: string; extensionFactory: ExtensionFactory }> | undefined;
	if (!active) {
		if (hooks instanceof Set) {
			for (const hook of [...hooks]) if (hook.name === HOOK_NAME) hooks.delete(hook);
		}
		return;
	}
	if (!(hooks instanceof Set)) shared[CHILD_SESSION_HOOKS] = hooks = new Set();
	for (const hook of [...hooks]) if (hook.name === HOOK_NAME && hook !== childHookEntry) hooks.delete(hook);
	hooks.add(childHookEntry);
}

interface Telemetry {
	phase: string;
	agentId: string;
	status: string;
	type: string;
	description: string;
	parentSessionId?: string;
}

/**
 * The latest snapshot on the branch, or undefined. A coordinator's board is what its branch last persisted, so `/tree`
 * and forks take the board of the point they land on.
 */
function readBranch(ctx: ExtensionContext): SwarmBoard | undefined {
	let board: SwarmBoard | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) board = entry.data as SwarmBoard;
	}
	return board;
}

/**
 * `swarm_board` in top-level TUI and RPC sessions, open while `isOn` holds, with its snapshots in the session and cards
 * for the session's own subagents; and the child-session hook that gives those subagents a restricted board.
 */
export function registerBoard(pi: ExtensionAPI, isOn: (ctx: ExtensionContext) => boolean): void {
	// Registered at load in every session, so the tool set never changes mid-session; calls check the session's role.
	pi.registerTool(coordinatorTool(pi, isOn));

	let current: ExtensionContext | undefined;
	let sessionId: string | undefined;
	/** `updatedAt` of the board this session last persisted or restored. */
	let persisted: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const instance: CoordinatorInstance = {
		isActive: () => {
			if (current === undefined) return false;
			try { return isOn(current); } catch { return false; }
		},
	};

	const onModeChange = () => {
		syncChildHook();
	};

	function flush(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		const board = sessionId === undefined ? undefined : swarmBoards().boards.get(sessionId);
		if (!board || board.updatedAt === persisted) return;
		try {
			pi.appendEntry<SwarmBoard>(ENTRY_TYPE, board);
			persisted = board.updatedAt;
		} catch (error) {
			console.error("swarm board: could not persist:", error);
		}
	}

	const listener = (board: SwarmBoard) => {
		if (board.sessionId !== sessionId || board.updatedAt === persisted || timer) return;
		timer = setTimeout(flush, PERSIST_DELAY_MS);
	};

	function restore(_event: unknown, ctx: ExtensionContext): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		current = undefined;
		if (!isCoordinator(ctx)) {
			coordinators().delete(instance);
			unsubscribeModeListener(onModeChange);
			syncChildHook();
			return;
		}
		current = ctx;
		const id = ctx.sessionManager.getSessionId();
		if (sessionId !== undefined && sessionId !== id) swarmBoards().boards.delete(sessionId);
		sessionId = id;
		swarmBoards().listeners.add(listener);
		coordinators().add(instance);
		sessionModes().listeners.add(onModeChange);
		const saved = readBranch(ctx);
		const live = swarmBoards().boards.get(id);
		if (!saved && !live) {
			syncChildHook();
			return;
		}
		// The registry may hold a later board than this branch (`/tree`): the branch wins, under a later `updatedAt`.
		// A branch without a snapshot has an empty board. Either way the branch already says it, so nothing is written.
		const cards = saved?.cards ?? [];
		const board: SwarmBoard = { version: 1, sessionId: id, updatedAt: nextTime(live), cards, nextId: initialNextId(saved) };
		persisted = board.updatedAt;
		publish(board);
	}

	pi.on("session_start", async (event, ctx) => {
		if (childRole(ctx)) pi.registerTool(childTool);
		restore(event, ctx);
	});
	pi.on("session_tree", async (event, ctx) => restore(event, ctx));

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!isCoordinator(ctx)) return undefined;
		syncChildHook();
		if (!isOn(ctx)) return undefined;
		// Children launched during the run find their coordinator's board, even an empty one.
		const id = ctx.sessionManager.getSessionId();
		if (!swarmBoards().boards.has(id)) {
			const board: SwarmBoard = { version: 1, sessionId: id, updatedAt: nextTime(undefined), cards: [], nextId: 1 };
			persisted = board.updatedAt;
			publish(board);
		}
		return undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		// The coordinator's own changes are on the branch when its call returns.
		if (event.toolName === TOOL) flush();
	});

	pi.on("session_shutdown", async () => {
		if (sessionId !== undefined) {
			flush();
			swarmBoards().listeners.delete(listener);
			swarmBoards().boards.delete(sessionId);
			for (const [child, board] of members()) if (board === sessionId) members().delete(child);
		}
		coordinators().delete(instance);
		unsubscribeModeListener(onModeChange);
		current = undefined;
		sessionId = undefined;
		syncChildHook();
	});

	pi.events.on("subagents:telemetry", (data) => {
		const ctx = current;
		const telemetry = data as Telemetry;
		if (!ctx || sessionId === undefined || (telemetry.phase !== "started" && telemetry.phase !== "completed")) return;
		if (!isOn(ctx)) return;
		// Only this session's agents and their nested children: other sessions in the process have their own boards.
		const parent = telemetry.parentSessionId;
		if (!parent || (parent !== sessionId && members().get(parent) !== sessionId)) return;
		trackAgent(sessionId, telemetry);
	});

	pi.events.on("subagents:steered", (data) => {
		const ctx = current;
		const id = (data as { id?: unknown } | null | undefined)?.id;
		if (!ctx || sessionId === undefined || !isOn(ctx) || typeof id !== "string" || !id) return;
		const board = swarmBoards().boards.get(sessionId);
		const card = board?.cards.find((candidate) => candidate.agentId === id && candidate.status === "blocked");
		if (!card) return;
		mutate(sessionId, (cards, now) => {
			const target = cards.find((candidate) => candidate.id === card.id && candidate.status === "blocked");
			if (!target) return;
			delete target.note;
			Object.assign(target, { status: "doing", updatedBy: COORDINATOR, updatedAt: now });
		});
	});
}

/**
 * Cards follow the agents: a start opens a `doing` card (or moves the linked card back to `doing`, unless the
 * coordinator dropped it); a completion settles an open card — completed or steered as `done`, anything else as
 * `failed`. A `blocked` card stays blocked when its agent ends normally, as the blocker still needs the coordinator,
 * and settled cards are left as they are.
 */
function trackAgent(sessionId: string, telemetry: Telemetry): void {
	const board = swarmBoards().boards.get(sessionId);
	const card = board?.cards.find((candidate) => candidate.agentId === telemetry.agentId);
	if (telemetry.phase === "started") {
		if (card && (card.status === "doing" || card.status === "dropped")) return;
		mutate(sessionId, (cards, now, allocateId) => {
			const linked = cards.find((candidate) => candidate.agentId === telemetry.agentId);
			if (linked) {
				if (linked.status === "blocked") delete linked.note;
				Object.assign(linked, { status: "doing", updatedBy: COORDINATOR, updatedAt: now });
			} else {
				newCard(cards, now, allocateId, { title: formatTitle(telemetry.description || telemetry.type), status: "doing", agentId: telemetry.agentId, agent: telemetry.type, createdBy: COORDINATOR });
			}
		});
		return;
	}
	if (!card || TERMINAL.includes(card.status)) return;
	const ok = telemetry.status === "completed" || telemetry.status === "steered";
	if (ok && card.status === "blocked") return;
	mutate(sessionId, (cards, now) => {
		Object.assign(findCard(cards, card.id), { status: ok ? "done" : "failed", updatedBy: COORDINATOR, updatedAt: now });
	});
}
