import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useApi } from "../../lib/api";
import { RELAY_ROOMS_KEY, relayRoomKey, sessionLabel } from "../../lib/relay";
import type { OnlineSession, RelayRoom } from "../../lib/types";
import { Icon } from "../icons";
import { useSigningOut } from "../Layout";
import { BUTTON, cx, Dialog } from "../ui";
import { FIELD, formatError, ROOM_NAME_RE } from "./helpers";
import { StateDot } from "./primitives";
import type { PeerState } from "./types";

export function NewRoomDialog({
	initialName,
	sessions,
	onCancel,
	onCreated,
}: {
	initialName: string;
	sessions: readonly OnlineSession[];
	onCancel: () => void;
	onCreated: (roomName: string) => void;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const { signingOut } = useSigningOut();
	const roomNameId = useId();
	const roomTopicId = useId();
	const nameRef = useRef<HTMLInputElement>(null);

	const [roomName, setRoomName] = useState(initialName);
	const [roomTopic, setRoomTopic] = useState("");
	const [filter, setFilter] = useState("");
	const [members, setMembers] = useState<ReadonlySet<string>>(() => new Set());
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const recentQuery = useQuery({
		queryKey: ["sessions", "relay-picker"],
		queryFn: () => api.sessions({}, undefined, 30),
		enabled: !signingOut,
	});

	useEffect(() => {
		nameRef.current?.focus();
	}, []);

	const candidates = useMemo(() => {
		const list: { id: string; label: string; named: boolean; project: string; state: PeerState }[] = [];
		const seen = new Set<string>();
		for (const s of sessions) {
			seen.add(s.id);
			list.push({ id: s.id, label: sessionLabel(s), named: Boolean(s.name || s.title), project: s.project || "—", state: s.state });
		}
		for (const rec of recentQuery.data?.items ?? []) {
			if (seen.has(rec.id)) continue;
			seen.add(rec.id);
			list.push({ id: rec.id, label: sessionLabel(rec), named: Boolean(rec.title), project: rec.project || "—", state: "offline" });
		}
		const q = filter.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(item) => item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q) || item.project.toLowerCase().includes(q),
		);
	}, [sessions, recentQuery.data, filter]);

	const handleSubmit = async () => {
		if (saving) return;
		const cleanName = roomName.trim().replace(/^#/, "");
		if (!ROOM_NAME_RE.test(cleanName)) {
			setFormError("Use 1–64 letters, digits, dots, hyphens, or underscores, such as auth-sync.");
			return;
		}
		setSaving(true);
		setFormError(null);
		try {
			const created = await api.saveRelayRoom({
				name: cleanName,
				...(roomTopic.trim() ? { topic: roomTopic.trim() } : {}),
				members: [...members],
			});
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
				queryClient.invalidateQueries({ queryKey: relayRoomKey(created.room.name) }),
			]);
			onCreated(created.room.name);
		} catch (cause) {
			setFormError(formatError(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog title="New room" label="new-room" locked={saving} onCancel={onCancel}>
			<form
				data-imessage-room-form=""
				className="mt-2"
				onSubmit={(event) => {
					event.preventDefault();
					void handleSubmit();
				}}
			>
				<p className="text-[13px] text-muted">
					Coordinate sessions across repositories. Agents can also join with <code className="code-chip">/relay join</code>.
				</p>
				<label htmlFor={roomNameId} className="mt-3 block text-[12.5px] font-medium text-ink">
					Room name
				</label>
				<input
					ref={nameRef}
					id={roomNameId}
					type="text"
					value={roomName}
					onChange={(e) => {
						setRoomName(e.target.value);
						setFormError(null);
					}}
					placeholder="auth-sync"
					className={cx(FIELD, "mono")}
				/>
				<label htmlFor={roomTopicId} className="mt-3 block text-[12.5px] font-medium text-ink">
					Topic (optional)
				</label>
				<input
					id={roomTopicId}
					type="text"
					value={roomTopic}
					onChange={(e) => setRoomTopic(e.target.value)}
					placeholder="What are these agents coordinating?"
					className={FIELD}
				/>

				<fieldset className="mt-3">
					<legend className="text-[12.5px] font-medium text-ink">Initial members (optional)</legend>
					{(sessions.length > 0 || (recentQuery.data?.items.length ?? 0) > 0) && (
						<div className="mt-1 flex h-7 items-center gap-1.5 rounded-sm border border-line bg-page px-2 text-muted focus-within:border-ink">
							<Icon name="search" size={12} className="shrink-0" />
							<input
								type="search"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="Filter sessions"
								aria-label="Filter sessions for room"
								className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
							/>
						</div>
					)}
					{recentQuery.isError && (
						<div
							role="alert"
							className="mt-1.5 flex items-center justify-between gap-2 rounded-sm bg-red-soft px-2.5 py-1.5 text-[12px] text-red"
						>
							<span className="min-w-0 flex-1">Couldn’t load recent sessions: {formatError(recentQuery.error)}</span>
							<button
								type="button"
								onClick={() => void recentQuery.refetch()}
								className="shrink-0 font-medium underline hover:no-underline"
							>
								Retry
							</button>
						</div>
					)}
					{candidates.length === 0 ? (
						<p className="mt-1.5 text-[12px] text-muted">
							{filter.trim() ? `No sessions matching “${filter.trim()}”.` : "No online or recent sessions available yet."}
						</p>
					) : (
						<ul className="mt-1.5 max-h-44 overflow-y-auto rounded-sm border border-line">
							{candidates.map((s) => (
								<li key={s.id} className="border-b border-line last:border-b-0">
									<label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12.5px] hover:bg-hover">
										<input
											type="checkbox"
											checked={members.has(s.id)}
											onChange={() =>
												setMembers((prev) => {
													const next = new Set(prev);
													if (!next.delete(s.id)) next.add(s.id);
													return next;
												})
											}
											className="accent-ink"
										/>
										<StateDot state={s.state} />
										<span className={cx("min-w-0 truncate font-medium", !s.named && "mono")}>{s.label}</span>
										<span className="ml-auto shrink-0 text-[11.5px] text-muted">{s.project}</span>
									</label>
								</li>
							))}
						</ul>
					)}
				</fieldset>

				{formError && (
					<p role="alert" className="mt-2 text-[12.5px] text-red">
						{formError}
					</p>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" disabled={saving} onClick={onCancel} className={BUTTON.secondary}>
						Cancel
					</button>
					<button
						type="submit"
						disabled={saving || !roomName.trim()}
						data-imessage-create-room=""
						className={BUTTON.primary}
					>
						{saving ? "Creating…" : "Create room"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function DeleteRoomDialog({
	room,
	onCancel,
	onDelete,
}: {
	room: RelayRoom;
	onCancel: () => void;
	onDelete: (roomName: string) => Promise<void>;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	const handleConfirm = async () => {
		if (deleting) return;
		setDeleting(true);
		setError(null);
		try {
			await onDelete(room.name);
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			setDeleting(false);
		}
	};

	return (
		<Dialog
			title={`Delete #${room.name}?`}
			label="delete-room"
			locked={deleting}
			onCancel={onCancel}
		>
			<p className="mt-2 text-[14px] text-muted">
				Deletes <span className="mono text-ink">#{room.name}</span> and its room message history. Sessions in the room are not
				stopped.
			</p>
			{error && (
				<p role="alert" data-imessage-delete-error="" className="mt-3 text-[12.5px] text-red">
					{error}
				</p>
			)}
			<div className="mt-5 flex justify-end gap-2">
				<button
					ref={cancelRef}
					type="button"
					disabled={deleting}
					onClick={onCancel}
					className={BUTTON.secondary}
				>
					Cancel
				</button>
				<button
					type="button"
					disabled={deleting}
					onClick={() => void handleConfirm()}
					data-imessage-delete-room=""
					className={BUTTON.danger}
				>
					{deleting ? "Deleting…" : "Delete room"}
				</button>
			</div>
		</Dialog>
	);
}
