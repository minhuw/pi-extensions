import { useQuery } from "@tanstack/react-query";
import { ApiError, useApi } from "../lib/api";
import { deviceLabel } from "../lib/devices";
import { formatDateTime, formatRelative } from "../lib/format";
import { isRelayDisabled, RELAY_POLL_MS, relayRoomBoardsKey, sessionLabel } from "../lib/relay";
import type { SwarmBoard, SwarmCard, SwarmCardStatus } from "../lib/types";
import { useSigningOut } from "./Layout";
import { Tag } from "./Tag";
import { ErrorState, SkeletonLines } from "./ui";

/** The board's columns; failed and dropped cards sit under Done with a marker. */
const COLUMNS: readonly { key: string; title: string; statuses: readonly SwarmCardStatus[] }[] = [
	{ key: "todo", title: "To do", statuses: ["todo"] },
	{ key: "doing", title: "Doing", statuses: ["doing"] },
	{ key: "blocked", title: "Blocked", statuses: ["blocked"] },
	{ key: "done", title: "Done", statuses: ["done", "failed", "dropped"] },
];

function BoardCard({ card, now }: { card: SwarmCard; now: number }) {
	return (
		<li
			data-board-card={card.id}
			data-board-status={card.status}
			className="rounded-sm border border-line bg-page px-2.5 py-2"
		>
			<div className="flex items-start gap-1.5">
				<p className="min-w-0 flex-1 text-[13px] leading-5 font-medium break-words text-ink">{card.title}</p>
				{card.status === "failed" && <Tag color="red">Failed</Tag>}
				{card.status === "dropped" && <Tag>Dropped</Tag>}
			</div>
			{card.note && <p className="mt-1 line-clamp-3 text-[12.5px] leading-[18px] break-words text-muted">{card.note}</p>}
			<div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11.5px] text-muted">
				{(card.agent || card.agentId) && (
					<span className="mono min-w-0 truncate !text-[11px]" title={card.agentId}>
						{card.agent ?? card.agentId}
					</span>
				)}
				<time className="ml-auto shrink-0 tnum" dateTime={card.updatedAt} title={formatDateTime(card.updatedAt)}>
					{formatRelative(card.updatedAt, now)}
				</time>
			</div>
		</li>
	);
}

function Board({ board, now }: { board: SwarmBoard; now: number }) {
	const meta = [board.project, deviceLabel(board)].filter(Boolean).join(" · ");
	return (
		<section aria-label={`Board of ${sessionLabel(board)}`} data-board={board.sessionId} className="border-b border-line last:border-b-0">
			<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line bg-soft px-5 py-2 max-sm:px-4">
				<h3 className="min-w-0 truncate text-[13.5px] font-semibold text-ink">{sessionLabel(board)}</h3>
				{meta && <span className="min-w-0 truncate text-[12px] text-muted">{meta}</span>}
				<span className="ml-auto shrink-0 text-[12px] text-muted tnum" title={formatDateTime(board.updatedAt)}>
					Updated {formatRelative(board.updatedAt, now)}
				</span>
			</div>
			<div className="grid gap-3 px-5 py-3 max-sm:px-4 sm:grid-cols-2 lg:grid-cols-4">
				{COLUMNS.map((column) => {
					const cards = board.cards.filter((card) => column.statuses.includes(card.status));
					return (
						<div key={column.key} data-board-column={column.key} className="min-w-0">
							<div className="mb-1.5 flex items-baseline justify-between text-[11.5px] font-bold tracking-[0.05em] text-muted uppercase">
								<span>{column.title}</span>
								<span className="tnum font-medium">{cards.length}</span>
							</div>
							{cards.length > 0 ? (
								<ul className="space-y-1.5">
									{cards.map((card) => (
										<BoardCard key={card.id} card={card} now={now} />
									))}
								</ul>
							) : (
								<p className="rounded-sm border border-dashed border-line px-2.5 py-2 text-[12px] text-muted">None</p>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}

/** The swarm boards of a room's member sessions, polled like the room's history. */
export function RoomBoard({ room, now }: { room: string; now: number }) {
	const api = useApi();
	const { signingOut } = useSigningOut();
	const boards = useQuery({
		queryKey: relayRoomBoardsKey(room),
		queryFn: () => api.relayRoomBoards(room),
		enabled: !signingOut,
		staleTime: 0,
		refetchInterval: (query) =>
			signingOut || isRelayDisabled(query.state.error) || (query.state.error instanceof ApiError && query.state.error.status === 404)
				? false
				: RELAY_POLL_MS,
	});

	let body;
	if (boards.isPending) {
		body = (
			<div className="p-6">
				<SkeletonLines lines={4} />
			</div>
		);
	} else if (boards.isError && !boards.data) {
		body = (
			<div className="p-6">
				<ErrorState error={boards.error} onRetry={() => void boards.refetch()} />
			</div>
		);
	} else if (boards.data.items.length === 0) {
		body = <p className="px-6 py-16 text-center text-[13px] text-muted">No member of this room has a swarm board.</p>;
	} else {
		body = boards.data.items.map((board) => <Board key={board.sessionId} board={board} now={now} />);
	}

	return (
		<div data-room-board="" className="min-h-0 flex-1 overflow-y-auto">
			{body}
		</div>
	);
}
