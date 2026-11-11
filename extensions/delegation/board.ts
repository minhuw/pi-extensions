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

export type CardStatus = "todo" | "doing" | "blocked" | "done" | "failed" | "dropped";

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
}

export interface SwarmBoards {
	version: 1;
	boards: Map<string, SwarmBoard>;
	listeners: Set<(board: SwarmBoard) => void>;
	/** Not part of the contract: each subagent session's coordinator session, nested children included. */
	members?: Map<string, string>;
}

const STATUSES: readonly CardStatus[] = ["doing", "blocked", "todo", "done", "failed", "dropped"];
const TERMINAL: readonly CardStatus[] = ["done", "failed", "dropped"];

/** The registry, created here unless another extension came first. */
export function swarmBoards(): SwarmBoards {
	const shared = globalThis as Record<symbol, unknown>;
	return (shared[BOARDS] ??= { version: 1, boards: new Map(), listeners: new Set() }) as SwarmBoards;
}

const members = () => (swarmBoards().members ??= new Map());

/** Replace a coordinator's board and tell every listener. A failing listener is logged and does not stop the others. */
function publish(board: SwarmBoard): void {
	const registry = swarmBoards();
	registry.boards.set(board.sessionId, board);
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

/** Apply `change` to a copy of the coordinator's cards and publish the result. */
function mutate(sessionId: string, change: (cards: SwarmCard[], now: number) => void): SwarmBoard {
	const current = swarmBoards().boards.get(sessionId);
	const now = nextTime(current);
	const cards = (current?.cards ?? []).map((card) => ({ ...card }));
	change(cards, now);
	const board: SwarmBoard = { version: 1, sessionId, updatedAt: now, cards };
	publish(board);
	return board;
}

function newCard(cards: SwarmCard[], now: number, fields: Omit<SwarmCard, "id" | "createdAt" | "updatedAt" | "updatedBy">): SwarmCard {
	const next = Math.max(0, ...cards.map((card) => Number(/^c(\d+)$/.exec(card.id)?.[1] ?? 0))) + 1;
	const card: SwarmCard = { id: `c${next}`, ...fields, updatedBy: fields.createdBy, createdAt: now, updatedAt: now };
	cards.push(card);
	return card;
}

function findCard(cards: SwarmCard[], id: string): SwarmCard {
	const card = cards.find((candidate) => candidate.id === id);
	if (!card) throw new Error(`No card ${id} on the swarm board.`);
	return card;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

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

interface SessionLink { kind?: string; parentSessionId?: string; agentId?: string; agentType?: string; description?: string }

/** The session's link to its spawner, written by Subagents and Herder before the child's extensions bind. */
function sessionLink(ctx: ExtensionContext): SessionLink | undefined {
	let link: SessionLink | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === SESSION_LINK_TYPE) link = (entry.data ?? {}) as SessionLink;
	}
	return link;
}

/** Top-level TUI and RPC sessions, as in `switch.ts`: a persisted child carries a session link. */
const isCoordinator = (ctx: ExtensionContext) => (ctx.mode === "tui" || ctx.mode === "rpc") && sessionLink(ctx) === undefined;

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

interface BoardParams { action: string; id?: string; title?: string; status?: string; note?: string; agentId?: string }

const result = (text: string, board: SwarmBoard | undefined) => ({ content: [{ type: "text" as const, text }], details: { board } });

const isStatus = (value: string): value is CardStatus => (STATUSES as readonly string[]).includes(value);

function coordinatorAction(sessionId: string, params: BoardParams) {
	const by = COORDINATOR;
	switch (params.action) {
		case "list": return result(formatBoard(swarmBoards().boards.get(sessionId)), swarmBoards().boards.get(sessionId));
		case "add": {
			const title = oneLine(params.title ?? "");
			if (!title) throw new Error("add needs a title.");
			const status = params.status ?? "todo";
			if (!isStatus(status)) throw new Error(`Unknown status ${status}.`);
			let id = "";
			const board = mutate(sessionId, (cards, now) => {
				id = newCard(cards, now, { title, status, ...(params.note ? { note: params.note } : {}), createdBy: by }).id;
			});
			return result(`Added ${id}.\n${formatBoard(board)}`, board);
		}
		case "update": case "drop": {
			const { id } = params;
			if (!id) throw new Error(`${params.action} needs a card id.`);
			const status = params.action === "drop" ? "dropped" : params.status;
			if (status !== undefined && !isStatus(status)) throw new Error(`Unknown status ${status}.`);
			const board = mutate(sessionId, (cards, now) => {
				const card = findCard(cards, id);
				if (params.agentId) {
					const other = cards.find((candidate) => candidate.agentId === params.agentId && candidate.id !== id);
					if (other) throw new Error(`Agent ${params.agentId} is already on card ${other.id}.`);
					card.agentId = params.agentId;
				}
				if (params.action === "update" && params.title !== undefined) {
					const title = oneLine(params.title);
					if (!title) throw new Error("A card's title cannot be empty.");
					card.title = title;
				}
				if (status) card.status = status;
				if (params.note !== undefined) card.note = params.note || undefined;
				Object.assign(card, { updatedBy: by, updatedAt: now });
			});
			return result(`${params.action === "drop" ? "Dropped" : "Updated"} ${id}.\n${formatBoard(board)}`, board);
		}
		default: throw new Error(`Unknown action ${params.action}: use list, add, update, or drop.`);
	}
}

function childAction(role: ChildRole, params: BoardParams) {
	const { boardId, agentId, link } = role;
	switch (params.action) {
		case "list": return result(`Your card: ${ownCard(boardId, agentId)?.id ?? "none yet"}.\n${formatBoard(swarmBoards().boards.get(boardId))}`, swarmBoards().boards.get(boardId));
		case "note": {
			const note = params.note?.trim();
			if (!note) throw new Error("note needs a note.");
			const status = params.status;
			if (status !== undefined && status !== "doing" && status !== "blocked") throw new Error("A subagent can set its own card only to doing or blocked; the coordinator settles cards.");
			let id = "";
			const board = mutate(boardId, (cards, now) => {
				let card = cards.find((candidate) => candidate.agentId === agentId);
				if (card?.status === "dropped") throw new Error(`The coordinator dropped your card ${card.id}; stop and report back.`);
				card ??= newCard(cards, now, { title: oneLine(link.description || link.agentType || agentId), status: "doing", agentId, ...(link.agentType ? { agent: link.agentType } : {}), createdBy: agentId });
				Object.assign(card, { status: status ?? (TERMINAL.includes(card.status) || card.status === "todo" ? "doing" : card.status), note, updatedBy: agentId, updatedAt: now });
				id = card.id;
			});
			return result(`Noted on ${id}.\n${formatBoard(board)}`, board);
		}
		case "add": {
			const title = oneLine(params.title ?? "");
			if (!title) throw new Error("add needs a title.");
			if (params.status !== undefined && params.status !== "todo") throw new Error("A subagent can add only todo cards.");
			let id = "";
			const board = mutate(boardId, (cards, now) => {
				id = newCard(cards, now, { title, status: "todo", ...(params.note ? { note: params.note } : {}), createdBy: agentId }).id;
			});
			return result(`Added ${id}.\n${formatBoard(board)}`, board);
		}
		default: throw new Error(`A subagent can only list, note on its own card, and add todo cards; ${params.action} is for the coordinator.`);
	}
}

const ownCard = (boardId: string, agentId: string) => swarmBoards().boards.get(boardId)?.cards.find((card) => card.agentId === agentId);

/** The tool both sides run: what a call may do follows from the calling session. */
function execute(isOn: ((ctx: ExtensionContext) => boolean) | undefined, params: BoardParams, ctx: ExtensionContext) {
	const role = childRole(ctx);
	if (role) return childAction(role, params);
	if (isOn && isCoordinator(ctx)) {
		if (!isOn(ctx)) throw new Error("Swarm mode is off in this session, so the swarm board is closed. The user turns it on with /swarm.");
		return coordinatorAction(ctx.sessionManager.getSessionId(), params);
	}
	throw new Error("This session has no swarm board.");
}

const optionalText = (description: string) => Type.Optional(Type.String({ description }));

const coordinatorTool = (isOn: (ctx: ExtensionContext) => boolean) => ({
	name: TOOL,
	label: "Swarm Board",
	description: "Kanban board you and your subagents share; agents you launch get cards automatically. list shows it; add a card (status defaults to todo); update id with title, status, note, or agentId (links a card to a launched agent); drop id.",
	parameters: Type.Object({
		// `note` serves a subagent session that loads Delegation itself, where this tool stands in for the child's.
		action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("drop"), Type.Literal("note")]),
		id: optionalText("Card id, as c3, for update and drop."),
		title: optionalText("Card title."),
		status: Type.Optional(Type.Union(STATUSES.map((status) => Type.Literal(status)))),
		note: optionalText("Short progress or blocker note; empty clears it."),
		agentId: optionalText("Agent id to link the card to."),
	}),
	async execute(_id: string, params: BoardParams, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
		return execute(isOn, params, ctx);
	},
});

const childTool = {
	name: TOOL,
	label: "Swarm Board",
	description: "Kanban board shared with your coordinator and the other agents. list shows it; note posts progress on your own card (status doing, or blocked with the reason when you need the coordinator); add creates a todo card for follow-up work.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("list"), Type.Literal("note"), Type.Literal("add")]),
		note: optionalText("For note: progress or the blocker. For add: optional detail."),
		status: Type.Optional(Type.Union([Type.Literal("doing"), Type.Literal("blocked")])),
		title: optionalText("For add: the follow-up's title."),
	}),
	async execute(_id: string, params: BoardParams, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
		return execute(undefined, params, ctx);
	},
};

const GUIDANCE = "Read swarm_board before editing files another card may own; post progress with note, set blocked with the reason when you need the coordinator, and add todo cards for follow-up work you find instead of doing it.";

const isConversation = (entry: SessionEntry) => entry.type === "message"
	? entry.message.role !== "system"
	: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";

/** Loaded into every child Subagents and Herder create; only a subagent of a coordinator with a board gets the board. */
const childExtension: ExtensionFactory = (pi) => {
	let section: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		section = undefined;
		const role = childRole(ctx);
		if (!role) return;
		// Delegation itself may load into the child and register the tool, which then also serves the child's role.
		if (!pi.getAllTools().some((tool) => tool.name === TOOL)) pi.registerTool(childTool);
		const fixed = ctx.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === SECTION_ENTRY_TYPE);
		if (fixed?.type === "custom") section = (fixed.data as { section?: string } | undefined)?.section;
		// A child that already talked without the section never gains one: that would rewrite its cached prefix.
		else if (!ctx.sessionManager.getEntries().some(isConversation)) {
			const card = ownCard(role.boardId, role.agentId);
			const open = formatBoard(swarmBoards().boards.get(role.boardId), ["doing", "blocked", "todo"]);
			section = `You are one of several agents sharing a swarm board with your coordinator. Your card: ${card?.id ?? "none yet (note creates it)"}.\nOpen cards:\n${open}\n${GUIDANCE}`;
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

/** Load the board extension into every child session, replacing an earlier copy (a `/reload` makes a new one). */
function installChildHook(): void {
	const shared = globalThis as Record<symbol, unknown>;
	let hooks = shared[CHILD_SESSION_HOOKS] as Set<{ name: string; extensionFactory: ExtensionFactory }> | undefined;
	if (!(hooks instanceof Set)) shared[CHILD_SESSION_HOOKS] = hooks = new Set();
	for (const hook of [...hooks]) if (hook.name === HOOK_NAME) hooks.delete(hook);
	hooks.add({ name: HOOK_NAME, extensionFactory: childExtension });
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
	installChildHook();
	// Registered at load in every session, so the tool set never changes mid-session; calls check the session's role.
	pi.registerTool(coordinatorTool(isOn));

	let current: ExtensionContext | undefined;
	let sessionId: string | undefined;
	/** `updatedAt` of the board this session last persisted or restored. */
	let persisted: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function flush(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		const board = sessionId === undefined ? undefined : swarmBoards().boards.get(sessionId);
		if (!board || board.updatedAt === persisted) return;
		persisted = board.updatedAt;
		pi.appendEntry<SwarmBoard>(ENTRY_TYPE, board);
	}

	const listener = (board: SwarmBoard) => {
		if (board.sessionId !== sessionId || board.updatedAt === persisted || timer) return;
		timer = setTimeout(flush, PERSIST_DELAY_MS);
	};

	function restore(_event: unknown, ctx: ExtensionContext): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		current = undefined;
		if (!isCoordinator(ctx)) return;
		current = ctx;
		const id = ctx.sessionManager.getSessionId();
		if (sessionId !== undefined && sessionId !== id) swarmBoards().boards.delete(sessionId);
		sessionId = id;
		swarmBoards().listeners.add(listener);
		const saved = readBranch(ctx);
		const live = swarmBoards().boards.get(id);
		if (!saved && !live) return;
		// The registry may hold a later board than this branch (`/tree`): the branch wins, under a later `updatedAt`.
		// A branch without a snapshot has an empty board. Either way the branch already says it, so nothing is written.
		const board: SwarmBoard = { version: 1, sessionId: id, updatedAt: nextTime(live), cards: saved?.cards ?? [] };
		persisted = board.updatedAt;
		publish(board);
	}

	pi.on("session_start", async (event, ctx) => restore(event, ctx));
	pi.on("session_tree", async (event, ctx) => restore(event, ctx));

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!isCoordinator(ctx) || !isOn(ctx)) return undefined;
		// Children launched during the run find their coordinator's board, even an empty one.
		const id = ctx.sessionManager.getSessionId();
		if (!swarmBoards().boards.has(id)) {
			const board: SwarmBoard = { version: 1, sessionId: id, updatedAt: nextTime(undefined), cards: [] };
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
			try { flush(); } catch (error) { console.error("swarm board: could not persist at shutdown:", error); }
			swarmBoards().listeners.delete(listener);
			swarmBoards().boards.delete(sessionId);
			for (const [child, board] of members()) if (board === sessionId) members().delete(child);
		}
		current = undefined;
		sessionId = undefined;
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
		mutate(sessionId, (cards, now) => {
			const linked = cards.find((candidate) => candidate.agentId === telemetry.agentId);
			if (linked) Object.assign(linked, { status: "doing", updatedBy: COORDINATOR, updatedAt: now });
			else newCard(cards, now, { title: oneLine(telemetry.description || telemetry.type), status: "doing", agentId: telemetry.agentId, agent: telemetry.type, createdBy: COORDINATOR });
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
