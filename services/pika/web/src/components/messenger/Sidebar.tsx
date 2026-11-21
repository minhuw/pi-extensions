import type { ReactNode } from "react";
import { formatRelative } from "../../lib/format";
import { Icon } from "../icons";
import { cx, Segmented } from "../ui";
import { formatError, STATE_WORD } from "./helpers";
import { RepBadge, StateDot } from "./primitives";
import type { DmThread, RoomThread, ThreadFilter, ThreadItem, ThreadSelection } from "./types";

function ThreadRow({
	item,
	selected,
	now,
	onSelect,
}: {
	item: ThreadItem;
	selected: boolean;
	now: number;
	onSelect: () => void;
}) {
	const quiet = selected ? "text-page/75" : "text-muted";
	if (item.kind === "room") {
		const total = item.room.members.length;
		const onlineCount = item.room.members.filter((m) => m.online || m.state !== "offline").length;
		const anyBusy = item.room.members.some((m) => m.state === "busy");
		const hasRep = Boolean(item.room.representative && item.room.members.some((m) => m.sessionId === item.room.representative));
		const repos = [...new Set(item.room.members.map((m) => m.project).filter(Boolean))];
		const statusText = total === 0 ? "0 members" : `${onlineCount}/${total} online`;
		const meta = [statusText, ...repos].join(" · ");
		return (
			<li className="border-b border-line last:border-b-0">
				<button
					type="button"
					onClick={onSelect}
					data-imessage-thread={item.key}
					aria-current={selected ? "true" : undefined}
					className={cx(
						"flex w-full flex-col gap-0.5 px-3.5 py-2.5 text-left",
						selected ? "bg-ink text-page" : "text-ink hover:bg-hover",
					)}
				>
					<span className="flex min-w-0 items-center gap-1.5">
						{anyBusy && <StateDot state="busy" />}
						<span className="mono min-w-0 flex-1 truncate !text-[14px] leading-5 font-semibold">#{item.room.name}</span>
						{hasRep && <RepBadge inverted={selected} />}
						{item.lastAt > 0 && (
							<span className={cx("tnum shrink-0 text-[12px]", quiet)}>
								{formatRelative(new Date(item.lastAt).toISOString(), now)}
							</span>
						)}
					</span>
					<span className={cx("tnum truncate text-[12.5px]", quiet)}>{meta}</span>
					<span className={cx("truncate text-[12.5px]", selected ? "text-page/90" : "text-ink/80")}>{item.preview}</span>
				</button>
			</li>
		);
	}

	const meta = [item.project !== "—" ? item.project : "", item.device].filter(Boolean).join(" · ") || "—";
	return (
		<li className="border-b border-line last:border-b-0">
			<button
				type="button"
				onClick={onSelect}
				data-imessage-thread={item.key}
				aria-current={selected ? "true" : undefined}
				className={cx(
					"flex w-full flex-col gap-0.5 px-3.5 py-2.5 text-left",
					selected ? "bg-ink text-page" : "text-ink hover:bg-hover",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					<StateDot state={item.state} />
					<span className={cx("min-w-0 flex-1 truncate text-[14px] leading-5 font-semibold", !item.named && "mono")}>
						{item.label}
					</span>
					{item.lastAt > 0 && (
						<span className={cx("tnum shrink-0 text-[12px]", quiet)}>
							{formatRelative(new Date(item.lastAt).toISOString(), now)}
						</span>
					)}
				</span>
				<span className={cx("truncate text-[12.5px]", quiet)}>
					<span className="sr-only">{STATE_WORD[item.state]} · </span>
					{meta}
				</span>
				<span className={cx("truncate text-[12.5px]", selected ? "text-page/90" : "text-ink/80")}>{item.preview}</span>
			</button>
		</li>
	);
}

function ThreadGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
	return (
		<section aria-label={title} className="border-t border-line first:border-t-0">
			<div className="flex items-baseline justify-between border-b border-line bg-soft px-3.5 py-1.5 text-[11.5px] font-bold tracking-[0.05em] text-muted uppercase">
				<span>{title}</span>
				<span className="tnum font-medium">{count}</span>
			</div>
			<ul>{children}</ul>
		</section>
	);
}

export function Sidebar({
	hiddenOnMobile,
	filter,
	onFilterChange,
	search,
	onSearchChange,
	totalThreads,
	searchMatchedCount,
	roomMatches,
	dmMatches,
	visibleThreads,
	resolvedKey,
	now,
	roomsError,
	retryingRooms,
	onRetryRooms,
	onNewRoom,
	onSelectThread,
}: {
	hiddenOnMobile: boolean;
	filter: ThreadFilter;
	onFilterChange: (next: ThreadFilter) => void;
	search: string;
	onSearchChange: (next: string) => void;
	totalThreads: number;
	searchMatchedCount: number;
	roomMatches: readonly RoomThread[];
	dmMatches: readonly DmThread[];
	visibleThreads: readonly ThreadItem[];
	resolvedKey: string;
	now: number;
	roomsError: unknown;
	retryingRooms: boolean;
	onRetryRooms: () => void;
	onNewRoom: () => void;
	onSelectThread: (next: ThreadSelection) => void;
}) {
	const renderThreadRow = (item: ThreadItem) => (
		<ThreadRow
			key={item.key}
			item={item}
			now={now}
			selected={resolvedKey === item.key}
			onSelect={() =>
				onSelectThread(item.kind === "room" ? { kind: "room", room: item.room.name } : { kind: "dm", sessionId: item.sessionId })
			}
		/>
	);

	return (
		<aside
			aria-label="Thread directory"
			className={cx(
				"flex min-h-0 w-full flex-col border-ink bg-page md:w-[272px] md:shrink-0 md:border-r",
				hiddenOnMobile && "max-md:hidden",
			)}
		>
			<div className="flex items-center justify-between gap-2 border-b border-ink px-3.5 py-2.5">
				<h1 className="text-[16px] leading-6 font-semibold tracking-[-0.01em]">Chatrooms</h1>
				<button
					type="button"
					onClick={onNewRoom}
					data-imessage-new-room=""
					className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-ink bg-page px-2.5 text-[12.5px] font-medium whitespace-nowrap text-ink hover:bg-hover"
				>
					<Icon name="plus" size={13} />
					New room
				</button>
			</div>

			<div className="space-y-2 border-b border-line px-3 py-2.5">
				<Segmented
					fullWidth
					size="sm"
					label="Filter conversations"
					value={filter}
					options={[
						["all", `All ${searchMatchedCount}`],
						["rooms", `Rooms ${roomMatches.length}`],
						["direct", `Direct ${dmMatches.length}`],
					]}
					onChange={onFilterChange}
				/>
				<div className="flex h-8 min-w-0 items-center gap-1.5 rounded-sm border border-line bg-page px-2.5 text-muted focus-within:border-ink">
					<Icon name="search" size={13} className="shrink-0" />
					<input
						type="search"
						value={search}
						onChange={(e) => onSearchChange(e.target.value)}
						placeholder="Search rooms or sessions"
						aria-label="Search conversations by agent, project, or room"
						data-imessage-search=""
						className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
					/>
				</div>
			</div>

			{roomsError !== null && roomsError !== undefined && (
				<div
					role="alert"
					data-imessage-rooms-error=""
					className="flex items-start justify-between gap-2 border-b border-line bg-red-soft px-3.5 py-2 text-[12px] text-red"
				>
					<span className="min-w-0 flex-1">Couldn’t load rooms: {formatError(roomsError)}</span>
					<button
						type="button"
						disabled={retryingRooms}
						onClick={onRetryRooms}
						className="shrink-0 font-medium underline hover:no-underline disabled:opacity-45"
					>
						{retryingRooms ? "Retrying…" : "Retry"}
					</button>
				</div>
			)}

			<nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto" data-imessage-threads="">
				{visibleThreads.length === 0 ? (
					<p className="px-4 py-10 text-center text-[12.5px] text-muted">
						{totalThreads === 0
							? "No conversations yet. Sessions appear here while online; create a room to bring several together."
							: search.trim()
								? `Nothing matches “${search.trim()}”.`
								: filter === "rooms"
									? "No chatrooms yet."
									: "No direct conversations yet."}
					</p>
				) : filter === "all" ? (
					<>
						{roomMatches.length > 0 && (
							<ThreadGroup title="Rooms" count={roomMatches.length}>
								{roomMatches.map(renderThreadRow)}
							</ThreadGroup>
						)}
						{dmMatches.length > 0 && (
							<ThreadGroup title="Direct" count={dmMatches.length}>
								{dmMatches.map(renderThreadRow)}
							</ThreadGroup>
						)}
					</>
				) : (
					<ul>{visibleThreads.map(renderThreadRow)}</ul>
				)}
			</nav>
		</aside>
	);
}
