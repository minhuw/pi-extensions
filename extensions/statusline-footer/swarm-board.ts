export const SWARM_BOARDS = Symbol.for("pi-extensions.swarm-boards");

type CardStatus = "todo" | "doing" | "blocked" | "done" | "failed" | "dropped";

interface SwarmCard {
	status: CardStatus;
}

interface SwarmBoard {
	version: 1;
	sessionId: string;
	updatedAt: number;
	cards: SwarmCard[];
}

interface SwarmBoards {
	version: 1;
	boards: Map<string, SwarmBoard>;
	listeners: Set<(board: SwarmBoard) => void>;
}

export interface SwarmBoardSummary {
	total: number;
	done: number;
	doing: number;
	todo: number;
	blocked: number;
	failed: number;
	dropped: number;
	/** Compact status label for the footer bar (without leading emoji). */
	text: string;
}

const globalRegistry = globalThis as { [SWARM_BOARDS]?: SwarmBoards };

function getOrCreateRegistry(): SwarmBoards {
	return (globalRegistry[SWARM_BOARDS] ??= {
		version: 1,
		boards: new Map(),
		listeners: new Set(),
	});
}

export function summarizeSwarmBoard(sessionId: string): SwarmBoardSummary | undefined {
	const reg = globalRegistry[SWARM_BOARDS];
	const board = reg?.boards?.get(sessionId);
	if (!board || !Array.isArray(board.cards) || board.cards.length === 0) {
		return undefined;
	}

	let done = 0;
	let doing = 0;
	let todo = 0;
	let blocked = 0;
	let failed = 0;
	let dropped = 0;

	for (const card of board.cards) {
		switch (card?.status) {
			case "done":
				done++;
				break;
			case "doing":
				doing++;
				break;
			case "todo":
				todo++;
				break;
			case "blocked":
				blocked++;
				break;
			case "failed":
				failed++;
				break;
			case "dropped":
				dropped++;
				break;
		}
	}

	const total = done + doing + todo + blocked + failed + dropped;
	const activeTotal = total - dropped;
	if (activeTotal === 0) {
		return undefined;
	}

	let text = `swarm ${done}/${activeTotal}`;
	if (blocked > 0) text += ` · ${blocked} blocked`;
	if (failed > 0) text += ` · ${failed} failed`;
	else if (doing > 0 && blocked === 0) text += ` · ${doing} doing`;

	return {
		total,
		done,
		doing,
		todo,
		blocked,
		failed,
		dropped,
		text,
	};
}

export function watchSwarmBoard(sessionId: string, onChange: () => void): () => void {
	const reg = getOrCreateRegistry();
	const listener = (board: SwarmBoard) => {
		if (board?.sessionId === sessionId) {
			onChange();
		}
	};
	reg.listeners.add(listener);
	return () => {
		reg.listeners.delete(listener);
	};
}
