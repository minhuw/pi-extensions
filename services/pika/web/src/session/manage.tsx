import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { PikaLink as Link } from "../components/PikaLink";
import { Icon } from "../components/icons";
import { BUTTON, ConfirmDialog, Pill } from "../components/ui";
import { useApi } from "../lib/api";
import { formatCount } from "../lib/format";
import type { SessionSummary } from "../lib/types";

/** Whether the session is hidden through a recorded ancestor rather than by its own flag. */
function hiddenByAncestor(session: SessionSummary): boolean {
	return Boolean(session.hidden && session.hiddenBy && session.hiddenBy !== session.id);
}

/** The owner's "Hidden from public" badge; public responses never mark sessions, and public pages show nothing. */
export function HiddenBadge({ session }: { session: SessionSummary }) {
	const api = useApi();
	if (api.publicView || !session.hidden) return null;
	const title = hiddenByAncestor(session)
		? "Hidden from public with the session that started it; visitors cannot see it even when its project is published"
		: "Hidden from public: visitors cannot see it, or the sessions it started, even when its project is published";
	return (
		<span className="flex shrink-0" data-hidden-badge="" title={title}>
			<Pill tone="yellow">Hidden from public</Pill>
		</span>
	);
}

function plural(n: number, noun: string): string {
	return `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** The owner's actions in a session's header: hide or show it in public, and delete it. None on public pages. */
export function SessionManageActions({ session }: { session: SessionSummary }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [deleting, setDeleting] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (api.publicView) return null;

	const toggle = async () => {
		setBusy(true);
		setError(null);
		try {
			const updated = await api.setSessionHidden(session.id, !session.hidden);
			queryClient.setQueryData(["session", session.id], (old: object | undefined) => (old ? { ...old, ...updated } : old));
			// The flag also marks its descendants, in lists, trees, and the publishing counts.
			void queryClient.invalidateQueries();
		} catch (cause) {
			setError(`Could not change its visibility: ${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{hiddenByAncestor(session) ? (
				<span className="inline-flex h-8 items-center text-[13px] text-muted" data-hidden-by={session.hiddenBy}>
					Hidden with&nbsp;
					<Link to={`/s/${encodeURIComponent(session.hiddenBy!)}`} className="text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink">
						the session that started it
					</Link>
				</span>
			) : (
				<button
					type="button"
					onClick={() => void toggle()}
					disabled={busy}
					aria-pressed={Boolean(session.hidden)}
					className={BUTTON.secondary}
					data-action="toggle-hidden"
					title={session.hidden ? "Visitors can see it again when its project is published" : "Visitors cannot see it, or the sessions it started, even when its project is published"}
				>
					<Icon name="eye" size={13} />
					{session.hidden ? "Show in public" : "Hide from public"}
				</button>
			)}
			<button type="button" onClick={() => setDeleting(true)} className={BUTTON.secondary} data-action="delete-session">
				Delete…
			</button>
			{error && (
				<span role="alert" className="text-[13px] text-red">
					{error}
				</span>
			)}
			{deleting && <DeleteSessionDialog session={session} onCancel={() => setDeleting(false)} />}
		</>
	);
}

function DeleteSessionDialog({ session, onCancel }: { session: SessionSummary; onCancel: () => void }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const count = useQuery({ queryKey: ["deletion", "session", session.id], queryFn: () => api.sessionDeletion(session.id), gcTime: 0 });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sessions = count.data?.deletedSessions;

	const confirm = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.deleteSession(session.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
			return;
		}
		// Every page refetches when it next shows; nothing refetches now, so the deleted session is not fetched again.
		void queryClient.invalidateQueries({ refetchType: "none" });
		// Go to the parent only when it is still recorded: it may never have been uploaded, or have gone with this
		// session when their links form a cycle. Otherwise go to the session list.
		const parent = session.parentSessionId;
		let target = "/";
		if (parent && parent !== session.id) {
			try {
				await queryClient.fetchQuery({ queryKey: ["session", parent], queryFn: () => api.session(parent) });
				target = `/s/${encodeURIComponent(parent)}`;
			} catch {
				queryClient.removeQueries({ queryKey: ["session", parent], exact: true });
			}
		}
		queryClient.removeQueries({ queryKey: ["session", session.id] });
		navigate(target);
	};

	return (
		<ConfirmDialog
			title={`Delete ${session.title || "this session"}?`}
			confirmLabel={sessions === undefined ? "Delete" : `Delete ${plural(sessions, "session")}`}
			busy={count.isPending}
			locked={busy}
			onConfirm={() => void confirm()}
			onCancel={onCancel}
		>
			<div data-dialog="delete-session">
				{count.isPending ? (
					"Counting the sessions it started…"
				) : count.isError ? (
					"pika could not count the sessions this one started; deleting it deletes them too."
				) : sessions === 1 ? (
					"This deletes the session, its captured requests, and its search entries."
				) : (
					<>
						This deletes {plural(sessions!, "session")}: this one and the {plural(sessions! - 1, "session")} it started (subagents, Herder steps, and tickets), with their captured requests and search entries.
					</>
				)}{" "}
				<strong className="font-medium text-ink">It cannot be undone.</strong> A pi that is still running this session keeps working, but pika discards what it uploads, and deletes the sessions it starts later as they arrive.
				{error && (
					<div role="alert" className="mt-2 text-red">
						Could not delete it: {error}
					</div>
				)}
			</div>
		</ConfirmDialog>
	);
}
