import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../lib/api";
import { deviceLabel } from "../../lib/devices";
import { sessionLabel, shortId } from "../../lib/relay";
import type { OnlineSession, RelayRoom } from "../../lib/types";
import { Icon } from "../icons";
import { useSigningOut } from "../Layout";
import { BUTTON, cx } from "../ui";
import { formatError, memberDevice, STATE_WORD } from "./helpers";
import { RepBadge, StateDot } from "./primitives";
import type { PeerState } from "./types";

export function RoomMembersRail({
	room,
	onlineSessions,
	memberBusyId,
	onToggleMember,
	onToggleRepresentative,
	onClose,
}: {
	room: RelayRoom;
	onlineSessions: readonly OnlineSession[];
	memberBusyId: string | null;
	onToggleMember: (roomName: string, sessionId: string, isMember: boolean) => Promise<void>;
	onToggleRepresentative: (roomName: string, sessionId: string, isRepresentative: boolean) => Promise<void>;
	onClose: () => void;
}) {
	const api = useApi();
	const { signingOut } = useSigningOut();
	const [filter, setFilter] = useState("");
	const [customSessionId, setCustomSessionId] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	const [memberError, setMemberError] = useState<string | null>(null);

	const [prevRoomName, setPrevRoomName] = useState(room.name);
	if (prevRoomName !== room.name) {
		setPrevRoomName(room.name);
		setAddError(null);
		setMemberError(null);
	}

	const recentSessionsQuery = useQuery({
		queryKey: ["sessions", "relay-picker"],
		queryFn: () => api.sessions({}, undefined, 30),
		enabled: !signingOut,
	});

	const onlineById = useMemo(() => new Map(onlineSessions.map((s) => [s.id, s])), [onlineSessions]);
	const memberIds = useMemo(() => new Set(room.members.map((m) => m.sessionId)), [room.members]);

	const availableToAdd = useMemo(() => {
		const list: { id: string; label: string; named: boolean; project: string; device: string; state: PeerState }[] = [];
		const seen = new Set<string>(memberIds);
		for (const s of onlineSessions) {
			if (seen.has(s.id)) continue;
			seen.add(s.id);
			list.push({
				id: s.id,
				label: sessionLabel(s),
				named: Boolean(s.name || s.title),
				project: s.project || "—",
				device: deviceLabel(s),
				state: s.state,
			});
		}
		for (const rec of recentSessionsQuery.data?.items ?? []) {
			if (seen.has(rec.id)) continue;
			seen.add(rec.id);
			list.push({
				id: rec.id,
				label: sessionLabel(rec),
				named: Boolean(rec.title),
				project: rec.project || "—",
				device: deviceLabel(rec),
				state: "offline",
			});
		}
		const q = filter.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(c) =>
				c.label.toLowerCase().includes(q)
				|| c.id.toLowerCase().includes(q)
				|| c.project.toLowerCase().includes(q)
				|| c.device.toLowerCase().includes(q),
		);
	}, [onlineSessions, recentSessionsQuery.data, memberIds, filter]);

	const handleMemberToggle = async (sessionId: string, isMember: boolean) => {
		setMemberError(null);
		try {
			await onToggleMember(room.name, sessionId, isMember);
		} catch (cause) {
			setMemberError(formatError(cause));
		}
	};

	const handleRepresentativeToggle = async (sessionId: string, isRep: boolean) => {
		setMemberError(null);
		try {
			await onToggleRepresentative(room.name, sessionId, isRep);
		} catch (cause) {
			setMemberError(formatError(cause));
		}
	};

	const handleAddById = async () => {
		const sid = customSessionId.trim();
		if (!sid) return;
		setAddError(null);
		setMemberError(null);
		try {
			await onToggleMember(room.name, sid, false);
			setCustomSessionId("");
		} catch (cause) {
			setAddError(formatError(cause));
		}
	};

	return (
		<aside
			aria-label="Room members"
			data-imessage-member-drawer=""
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
			className="flex h-full min-h-0 flex-col bg-page max-xl:fixed max-xl:inset-y-12 max-xl:right-0 max-xl:z-30 max-xl:w-full max-xl:max-w-[420px] max-xl:border-l max-xl:border-ink xl:w-[420px] xl:shrink-0 xl:border-l xl:border-ink"
		>
			<div className="flex items-center justify-between gap-2 border-b border-ink px-4 py-2.5">
				<div className="flex min-w-0 items-baseline gap-2">
					<h2 className="text-[14px] font-semibold">Members</h2>
					<span className="tnum text-[12px] text-muted">{room.members.length}</span>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close members"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line bg-page text-muted hover:border-ink hover:bg-hover hover:text-ink"
				>
					<Icon name="close" size={14} className="shrink-0" />
				</button>
			</div>

			{memberError && (
				<div
					role="alert"
					data-imessage-member-error=""
					className="flex items-start justify-between gap-2 border-b border-line bg-red-soft px-4 py-2 text-[12.5px] text-red"
				>
					<span className="min-w-0 flex-1">{memberError}</span>
					<button
						type="button"
						onClick={() => setMemberError(null)}
						aria-label="Dismiss member error"
						className="shrink-0 font-medium underline hover:no-underline"
					>
						Dismiss
					</button>
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto">
				<section aria-label="Current members">
					{room.members.length === 0 ? (
						<p className="px-4 py-4 text-[12.5px] text-muted" data-imessage-room-members="">
							No members yet. Add a session below or run <code className="code-chip">/relay join {room.name}</code>.
						</p>
					) : (
						<ul data-imessage-room-members="">
							{room.members.map((m) => {
								const isRep = m.sessionId === room.representative;
								const onlineEntry = onlineById.get(m.sessionId);
								const canLink = onlineEntry ? onlineEntry.recorded : true;
								const label = sessionLabel(m);
								const named = Boolean(m.name || m.title);
								const subtitle = [m.project, memberDevice(m)].filter(Boolean).join(" · ");
								return (
									<li
										key={m.sessionId}
										className="flex items-center gap-2.5 border-b border-line px-4 py-2.5 text-[13px] last:border-b-0"
									>
										<StateDot state={m.state} />
										<div className="min-w-0 flex-1">
											<div className="flex min-w-0 items-center gap-1.5">
												{canLink ? (
													<Link
														to={`/s/${encodeURIComponent(m.sessionId)}`}
														className={cx(
															"min-w-0 truncate font-medium underline decoration-line underline-offset-[3px] hover:decoration-ink",
															!named && "mono",
														)}
														title={m.sessionId}
													>
														{label}
													</Link>
												) : (
													<span className={cx("min-w-0 truncate font-medium", !named && "mono")} title={m.sessionId}>
														{label}
													</span>
												)}
												{isRep && <RepBadge />}
												<span className="sr-only">{STATE_WORD[m.state]}</span>
											</div>
											<div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
												{subtitle && <span className="truncate">{subtitle}</span>}
												<span className="mono shrink-0 !text-[11px]">{shortId(m.sessionId)}</span>
											</div>
										</div>
										<div className="flex shrink-0 items-center gap-1.5">
											<button
												type="button"
												disabled={memberBusyId === m.sessionId}
												onClick={() => void handleRepresentativeToggle(m.sessionId, isRep)}
												data-imessage-represent-member={m.sessionId}
												className={cx(
													"rounded-sm border bg-page px-2.5 py-1 text-[12.5px] whitespace-nowrap disabled:cursor-default disabled:opacity-45",
													isRep
														? "border-ink font-semibold text-ink hover:bg-hover"
														: "border-line font-medium text-ink hover:border-ink hover:bg-hover",
												)}
											>
												{isRep ? "Clear rep" : "Make rep"}
											</button>
											<button
												type="button"
												disabled={memberBusyId === m.sessionId}
												onClick={() => void handleMemberToggle(m.sessionId, true)}
												data-imessage-toggle-member={m.sessionId}
												className="rounded-sm border border-line bg-page px-2.5 py-1 text-[12.5px] whitespace-nowrap text-muted hover:border-red hover:bg-hover hover:text-red disabled:cursor-default disabled:opacity-45"
											>
												Remove
											</button>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</section>

				<section aria-label="Add member" className="border-t border-ink" data-imessage-add-members="">
					<h3 className="border-b border-line bg-soft px-4 py-2 text-[12px] font-semibold text-ink">Add member</h3>
					<div className="px-4 py-3">
						<div className="flex h-8 items-center gap-1.5 rounded-sm border border-line bg-page px-2 text-muted focus-within:border-ink">
							<Icon name="search" size={13} className="shrink-0" />
							<input
								type="search"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="Filter online or recorded sessions"
								aria-label="Filter sessions to add"
								className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
							/>
						</div>

						{recentSessionsQuery.isError && (
							<div
								role="alert"
								data-imessage-recent-sessions-error=""
								className="mt-2 flex items-center justify-between gap-2 rounded-sm bg-red-soft px-2.5 py-1.5 text-[12px] text-red"
							>
								<span className="min-w-0 flex-1">Couldn’t load recent sessions: {formatError(recentSessionsQuery.error)}</span>
								<button
									type="button"
									onClick={() => void recentSessionsQuery.refetch()}
									className="shrink-0 font-medium underline hover:no-underline"
								>
									Retry
								</button>
							</div>
						)}

						{availableToAdd.length === 0 ? (
							<p className="pt-3 text-[12px] text-muted">
								{filter.trim() ? `No sessions matching “${filter.trim()}”.` : "No other online or recent sessions to add."}
							</p>
						) : (
							<ul className="mt-2.5 border-t border-line">
								{availableToAdd.map((c) => (
									<li key={c.id} className="flex items-center gap-2 border-b border-line py-2 text-[12.5px] last:border-b-0">
										<StateDot state={c.state} />
										<div className="min-w-0 flex-1">
											<div className={cx("truncate font-medium", !c.named && "mono")}>{c.label}</div>
											<div className="truncate text-[11.5px] text-muted">
												{[c.project !== "—" ? c.project : "", c.device, STATE_WORD[c.state]].filter(Boolean).join(" · ")}
											</div>
										</div>
										<button
											type="button"
											disabled={memberBusyId === c.id}
											onClick={() => void handleMemberToggle(c.id, false)}
											data-imessage-toggle-member={c.id}
											className="shrink-0 rounded-sm border border-ink bg-page px-2.5 py-1 text-[12.5px] font-medium text-ink hover:bg-hover disabled:cursor-default disabled:opacity-45"
										>
											Add
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</section>

				<section aria-label="Add by session ID" className="border-t border-ink">
					<h3 className="border-b border-line bg-soft px-4 py-2 text-[12px] font-semibold text-ink">Add by session ID</h3>
					<form
						className="px-4 py-3"
						data-imessage-add-by-id=""
						onSubmit={(event) => {
							event.preventDefault();
							void handleAddById();
						}}
					>
						<div className="flex items-center gap-1.5">
							<input
								type="text"
								value={customSessionId}
								onChange={(e) => {
									setCustomSessionId(e.target.value);
									setAddError(null);
								}}
								placeholder="00000000-0000-4000-8000-000000000000"
								aria-label="Session ID to add"
								className="mono h-8 min-w-0 flex-1 rounded-sm border border-line bg-page !text-[12px] px-2 text-ink outline-none placeholder:font-sans placeholder:text-muted focus:border-ink"
							/>
							<button
								type="submit"
								disabled={!customSessionId.trim() || memberBusyId !== null}
								className={cx(BUTTON.secondary, "h-8 shrink-0")}
							>
								Add
							</button>
						</div>
						{addError && (
							<p role="alert" className="mt-1.5 text-[12px] text-red">
								{addError}
							</p>
						)}
					</form>
				</section>
			</div>
		</aside>
	);
}
