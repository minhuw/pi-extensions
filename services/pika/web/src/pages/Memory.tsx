import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { PikaLogo } from "../components/icons";
import { BUTTON, ConfirmDialog, cx, EmptyState, ErrorState, Page, PageTitle, Pill, Skeleton, SkeletonLines, Toggle } from "../components/ui";
import { ApiError, useApi } from "../lib/api";
import { formatDateTime, formatRelative, plural } from "../lib/format";
import type {
	MemoryBatch,
	MemoryBatchChange,
	MemoryNote,
	MemoryProvenance,
	MemoryRevision,
	MemoryScopeSummary,
	MemorySource,
} from "../lib/types";

const LINK = "text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink";

/** A time as a relative phrase, with the exact time on hover. */
function When({ at }: { at: string | null }) {
	return (
		<span className="tnum" title={at ? formatDateTime(at) : undefined}>
			{formatRelative(at)}
		</span>
	);
}

function SessionLink({ id }: { id: string | null }) {
	if (!id) return null;
	return (
		<Link to={`/s/${encodeURIComponent(id)}`} className={LINK}>
			Session →
		</Link>
	);
}

const PROVENANCE: Record<MemoryProvenance, string> = {
	agent: "Saved by an agent",
	dream: "Saved by a dream",
	owner: "Restored when you undid a dream",
};

function Provenance({ value }: { value: MemoryProvenance }) {
	return (
		<span data-provenance={value}>
			<Pill tone={value === "dream" ? "yellow" : "neutral"} title={PROVENANCE[value]}>
				{value}
			</Pill>
		</span>
	);
}

/** The session entries a note was drawn from, each linked to its place in the session. */
function Sources({ sources }: { sources: MemorySource[] | undefined }) {
	if (!sources?.length) return null;
	return (
		<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px] text-muted">
			<span>Sources</span>
			<ul aria-label="Sources" className="contents">
				{sources.map((source) => (
					<li key={`${source.sessionId}:${source.seq}`} className="min-w-0">
						<Link to={`/s/${encodeURIComponent(source.sessionId)}?seq=${source.seq}`} className={cx(LINK, "mono break-all")}>
							{source.sessionId} #{source.seq}
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}

/** Note text as written: plain text with its line breaks, never markup. */
function Body({ text }: { text: string }) {
	if (!text) return <div className="text-[13px] text-muted">No body</div>;
	return <div className="text-[13.5px] leading-[1.55] break-words whitespace-pre-wrap">{text}</div>;
}

function ScopeRow({ scope, selected }: { scope: MemoryScopeSummary; selected: boolean }) {
	return (
		<Link
			to={{ search: `?${new URLSearchParams({ scope: scope.key })}` }}
			aria-current={selected ? "true" : undefined}
			title={scope.key}
			className={cx("block border-b border-line px-1.5 py-1.5 text-[13px] leading-5 hover:bg-hover", selected && "bg-hover")}
			data-memory-scope={scope.key}
		>
			<span className="flex min-w-0 items-center gap-2">
				<span className={cx("min-w-0 flex-1 truncate text-[13.5px]", selected ? "font-semibold" : "font-medium")}>{scope.label}</span>
				<Pill>{scope.kind}</Pill>
			</span>
			<span className="flex min-w-0 items-center gap-x-3 text-[12px] text-muted">
				<span className="tnum">{plural(scope.noteCount, "note")}</span>
				<span className="ml-auto">{scope.updatedAt ? <When at={scope.updatedAt} /> : "never updated"}</span>
			</span>
		</Link>
	);
}

function RevisionRow({ revision }: { revision: MemoryRevision }) {
	return (
		<li className="border-b border-line py-1.5 last:border-b-0" data-revision={revision.revision} data-action={revision.action}>
			<div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-muted">
				<Pill tone={revision.action === "forget" ? "red" : revision.action === "revert" ? "yellow" : "neutral"}>{revision.action}</Pill>
				<span className="tnum">Revision {revision.revision}</span>
				<When at={revision.at} />
				<Pill>{revision.category}</Pill>
				<Provenance value={revision.provenance} />
				{revision.batchId && (
					<span>
						Batch <span className="mono">{revision.batchId}</span>
					</span>
				)}
				<span className="ml-auto">
					<SessionLink id={revision.sessionId} />
				</span>
			</div>
			<div className="mt-1 text-[13.5px] font-medium">{revision.title}</div>
			<div className="text-[13px] text-muted">{revision.hook}</div>
			<div className="mt-1">
				<Body text={revision.body} />
			</div>
			{revision.reason && <div className="mt-1 text-[12.5px] text-muted">Reason: {revision.reason}</div>}
			<div className="mt-1">
				<Sources sources={revision.sources} />
			</div>
		</li>
	);
}

/** A note's history, loaded when it is opened. */
function NoteHistory({ id }: { id: string }) {
	const api = useApi();
	const revisions = useQuery({ queryKey: ["memory-revisions", id], queryFn: () => api.memoryRevisions(id) });
	if (revisions.isPending) return <SkeletonLines lines={2} />;
	if (revisions.isError) return <ErrorState error={revisions.error} onRetry={() => void revisions.refetch()} />;
	if (revisions.data.revisions.length === 0) return <div className="py-1 text-[13px] text-muted">No revisions</div>;
	return (
		<ol aria-label="Revisions" data-revisions={id}>
			{revisions.data.revisions.map((revision) => (
				<RevisionRow key={revision.revision} revision={revision} />
			))}
		</ol>
	);
}

function NoteRow({ note }: { note: MemoryNote }) {
	return (
		<article className="border-b border-line py-3 last:border-b-0" aria-labelledby={`memory-note-${note.id}`} data-memory-note={note.id}>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<Pill>{note.category}</Pill>
				<h3 id={`memory-note-${note.id}`} className="min-w-0 flex-1 text-[14.5px] font-semibold break-words">
					{note.title}
				</h3>
				<span className="mono shrink-0 text-[11.5px] text-muted">{note.id}</span>
			</div>
			<div className="mt-0.5 text-[13.5px] text-muted">{note.hook}</div>
			<div className="mt-2">
				<Body text={note.body} />
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
				<Provenance value={note.provenance} />
				<span className="tnum">Revision {note.revision}</span>
				<span>
					Updated <When at={note.updatedAt} />
				</span>
				<SessionLink id={note.sessionId} />
			</div>
			<div className="mt-1">
				<Sources sources={note.sources} />
			</div>
			<Toggle className="mt-1.5 text-[13px]" label={<span className="text-muted">History</span>}>
				<NoteHistory id={note.id} />
			</Toggle>
		</article>
	);
}

function changeLabel(change: MemoryBatchChange): string {
	if (change.action === "forget") return "forgotten";
	return change.created ? "created" : "updated";
}

/** The error code in an `ApiError`'s body, such as `revert_conflict`. */
function errorCode(cause: unknown): string | undefined {
	if (!(cause instanceof ApiError) || !cause.body || typeof cause.body !== "object") return undefined;
	const error = (cause.body as { error?: unknown }).error;
	return typeof error === "string" ? error : undefined;
}

/** Why an undo failed; a conflict names the notes changed since the batch, by title where the batch knows it. */
function undoError(batch: MemoryBatch, cause: unknown): string {
	if (errorCode(cause) === "revert_conflict") {
		const body = (cause as ApiError).body as { notes?: unknown };
		const notes = Array.isArray(body.notes) ? body.notes.map(String) : [];
		const names = notes.map((id) => {
			const title = batch.changes.find((change) => change.noteId === id)?.title;
			return title ? `“${title}” (${id})` : id;
		});
		const which = names.length ? `${names.join(", ")} ${names.length === 1 ? "has" : "have"}` : "Some of its notes have";
		return `Could not undo this dream: ${which} changed since. Nothing was restored.`;
	}
	return `Could not undo this dream: ${cause instanceof Error ? cause.message : String(cause)}`;
}

function BatchRow({ batch, busy, error, onUndo }: { batch: MemoryBatch; busy: boolean; error: string | undefined; onUndo: () => void }) {
	return (
		<li className="border-b border-line py-3 last:border-b-0" data-memory-batch={batch.id} data-reverted={batch.revertedAt ? "true" : "false"}>
			<div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-muted">
				<Pill title={batch.mode === "auto" ? "Dreamt on its own after the sessions went idle" : "Dreamt on request"}>{batch.mode}</Pill>
				<When at={batch.at} />
				{batch.dreamSessionId && (
					<Link to={`/s/${encodeURIComponent(batch.dreamSessionId)}`} className={LINK}>
						Dream session →
					</Link>
				)}
				<span className="ml-auto flex items-center gap-2">
					{batch.revertedAt ? (
						<span data-batch-reverted="">
							Reverted <When at={batch.revertedAt} />
						</span>
					) : (
						<button
							type="button"
							onClick={onUndo}
							disabled={busy}
							className={cx(BUTTON.quiet, "!px-2")}
							aria-label={`Undo the dream of ${formatDateTime(batch.at)}`}
						>
							Undo
						</button>
					)}
				</span>
			</div>
			{batch.summary ? (
				<div className="mt-1 text-[13.5px] leading-[1.55] break-words whitespace-pre-wrap">{batch.summary}</div>
			) : (
				<div className="mt-1 text-[13px] text-muted">No summary</div>
			)}
			{batch.sessions.length > 0 && (
				<div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px] text-muted">
					<span>Consolidated {plural(batch.sessions.length, "session")}</span>
					<ul aria-label="Consolidated sessions" className="contents">
						{batch.sessions.map((id) => (
							<li key={id} className="min-w-0">
								<Link to={`/s/${encodeURIComponent(id)}`} className={cx(LINK, "mono break-all")}>
									{id}
								</Link>
							</li>
						))}
					</ul>
				</div>
			)}
			{batch.changes.length > 0 && (
				<ul aria-label="Changes" className="mt-1.5">
					{batch.changes.map((change) => (
						<li
							key={`${change.noteId}:${change.revision}`}
							className="flex min-w-0 items-center gap-2 py-0.5 text-[13px]"
							data-change={change.noteId}
							data-action={changeLabel(change)}
						>
							<Pill tone={change.action === "forget" ? "red" : "neutral"}>{changeLabel(change)}</Pill>
							<span className="min-w-0 flex-1 truncate" title={change.title}>
								{change.title}
							</span>
							<span className="tnum shrink-0 text-[12px] text-muted">Revision {change.revision}</span>
							<span className="mono shrink-0 text-[11.5px] text-muted">{change.noteId}</span>
						</li>
					))}
				</ul>
			)}
			{error && (
				<div role="alert" className="mt-1.5 text-[13px] text-red">
					{error}
				</div>
			)}
		</li>
	);
}

/** The scope's dream batches, newest first. Undoing one is the only change this page makes. */
function ScopeDreams({ scope }: { scope: MemoryScopeSummary }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const queryKey = ["memory-batches", scope.key];
	const batches = useQuery({ queryKey, queryFn: () => api.memoryBatches(scope.key) });
	const [undoing, setUndoing] = useState<MemoryBatch | null>(null);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});

	const undo = async (batch: MemoryBatch) => {
		setBusy(true);
		setErrors(({ [batch.id]: _cleared, ...rest }) => rest);
		try {
			const result = await api.revertMemoryBatch(batch.id);
			if (result?.batch) {
				queryClient.setQueryData<{ batches: MemoryBatch[] }>(queryKey, (data) =>
					data && { ...data, batches: data.batches.map((item) => (item.id === batch.id ? result.batch : item)) },
				);
			}
		} catch (cause) {
			// Already reverted elsewhere: the refetch shows it so.
			if (errorCode(cause) !== "already_reverted") setErrors((current) => ({ ...current, [batch.id]: undoError(batch, cause) }));
		} finally {
			setBusy(false);
			setUndoing(null);
			// A batch may touch user notes too, so every scope's notes, histories, and counts refetch.
			for (const key of ["memory-batches", "memory-notes", "memory-revisions", "memory-scopes"]) {
				void queryClient.invalidateQueries({ queryKey: [key] });
			}
		}
	};

	const notes = undoing ? new Set(undoing.changes.map((change) => change.noteId)).size : 0;
	return (
		<section aria-labelledby="memory-dreams-title" className="mt-10" data-memory-dreams={scope.key}>
			<div className="flex min-h-7 items-center border-b border-ink pb-1">
				<h3 id="memory-dreams-title" className="text-[14.5px] font-semibold">
					Dreams
				</h3>
			</div>
			{batches.isPending ? (
				<div className="pt-3">
					<SkeletonLines lines={2} />
				</div>
			) : batches.isError ? (
				<ErrorState error={batches.error} onRetry={() => void batches.refetch()} />
			) : batches.data.batches.length === 0 ? (
				<EmptyState title="No dreams">
					{scope.kind === "user"
						? "Dreams run for projects; one that changes user notes is listed under its project."
						: "No dream has consolidated this project’s sessions yet."}
				</EmptyState>
			) : (
				<ol aria-label="Dream batches">
					{batches.data.batches.map((batch) => (
						<BatchRow key={batch.id} batch={batch} busy={busy} error={errors[batch.id]} onUndo={() => setUndoing(batch)} />
					))}
				</ol>
			)}
			{undoing && (
				<ConfirmDialog
					title="Undo this dream?"
					confirmLabel="Undo"
					locked={busy}
					onConfirm={() => void undo(undoing)}
					onCancel={() => setUndoing(null)}
				>
					<div data-dialog="undo-dream">
						This restores the {plural(notes, "note")} it changed to how {notes === 1 ? "it was" : "they were"} before: notes it
						created are forgotten, notes it updated get their previous text, and notes it forgot come back. Each restore is a new
						revision, so the history keeps both. The sessions it consolidated are not dreamt again.
					</div>
				</ConfirmDialog>
			)}
		</section>
	);
}

function ScopeNotes({ scope }: { scope: MemoryScopeSummary | undefined }) {
	const api = useApi();
	const key = scope?.key ?? "";
	const notes = useQuery({ queryKey: ["memory-notes", key], queryFn: () => api.memoryNotes(key), enabled: scope !== undefined });
	if (!scope || (notes.error instanceof ApiError && notes.error.status === 404)) {
		return <EmptyState title="No such scope">It may have been deleted with its project.</EmptyState>;
	}
	return (
		<section aria-labelledby="memory-scope-title" data-memory-notes={scope.key}>
			<div className="flex min-h-7 flex-wrap items-center gap-2 border-b border-ink pb-1">
				<h2 id="memory-scope-title" className="text-[16px] font-semibold">
					{scope.label}
				</h2>
				<Pill>{scope.kind}</Pill>
				<span className="mono min-w-0 truncate text-[12px] text-muted">{scope.key}</span>
			</div>
			{notes.isPending ? (
				<div className="pt-3">
					<SkeletonLines lines={4} />
				</div>
			) : notes.isError ? (
				<ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
			) : notes.data.notes.length === 0 ? (
				<EmptyState title="No notes">Agents haven’t saved notes to this scope, or have forgotten them all.</EmptyState>
			) : (
				<div>
					{notes.data.notes.map((note) => (
						<NoteRow key={note.id} note={note} />
					))}
				</div>
			)}
			<ScopeDreams scope={scope} />
		</section>
	);
}

/** The agents' memory, read-only but for undoing a dream: notes change only through the agents and dreams that write them. */
export function MemoryPage() {
	const api = useApi();
	const [params] = useSearchParams();
	const scopes = useQuery({ queryKey: ["memory-scopes"], queryFn: () => api.memoryScopes() });
	const items = scopes.data?.scopes ?? [];
	const selectedKey = params.get("scope") ?? items[0]?.key ?? "";
	const selected = items.find((scope) => scope.key === selectedKey);
	return (
		<Page className="pb-24">
			<div data-memory-page="">
				<PageTitle>Memory</PageTitle>
				<p className="mt-2 max-w-[70ch] text-[14px] text-muted">Notes your agents keep for you and for each project. Agents save and forget them, and dreams consolidate them from recent sessions; this page shows them and can undo a dream.</p>
				{scopes.isPending ? (
					<div className="mt-6" aria-busy="true" aria-label="Loading memory">
						{[0, 1, 2].map((i) => (
							<div key={i} className="border-b border-line px-1.5 py-2">
								<Skeleton className="h-4 w-1/3" />
								<Skeleton className="mt-1.5 h-3 w-1/5" />
							</div>
						))}
					</div>
				) : scopes.isError ? (
					<ErrorState error={scopes.error} onRetry={() => void scopes.refetch()} />
				) : items.length === 0 ? (
					<EmptyState title="No memory yet" visual={<PikaLogo size={40} />}>
						Scopes appear here once an agent saves its first note.
					</EmptyState>
				) : (
					<div className="mt-6 gap-10 lg:grid lg:grid-cols-[280px_minmax(0,1fr)]">
						<nav aria-label="Memory scopes" className="max-lg:mb-8">
							<div className="h-7 border-b border-ink px-1.5 pb-1 text-[12px] font-medium text-muted">Scopes</div>
							{items.map((scope) => (
								<ScopeRow key={scope.key} scope={scope} selected={scope.key === selectedKey} />
							))}
						</nav>
						<ScopeNotes key={selectedKey} scope={selected} />
					</div>
				)}
			</div>
		</Page>
	);
}
