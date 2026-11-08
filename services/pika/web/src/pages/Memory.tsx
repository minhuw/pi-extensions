import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { PikaLogo } from "../components/icons";
import { cx, EmptyState, ErrorState, Page, PageTitle, Pill, Skeleton, SkeletonLines, Toggle } from "../components/ui";
import { ApiError, useApi } from "../lib/api";
import { formatDateTime, formatRelative, plural } from "../lib/format";
import type { MemoryNote, MemoryRevision, MemoryScopeSummary } from "../lib/types";

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
				<Pill tone={revision.action === "forget" ? "red" : "neutral"}>{revision.action}</Pill>
				<span className="tnum">Revision {revision.revision}</span>
				<When at={revision.at} />
				<Pill>{revision.category}</Pill>
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
				<span className="tnum">Revision {note.revision}</span>
				<span>
					Updated <When at={note.updatedAt} />
				</span>
				<SessionLink id={note.sessionId} />
			</div>
			<Toggle className="mt-1.5 text-[13px]" label={<span className="text-muted">History</span>}>
				<NoteHistory id={note.id} />
			</Toggle>
		</article>
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
		</section>
	);
}

/** The agents' memory, read-only: notes change only through the agents that save and forget them. */
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
				<p className="mt-2 max-w-[70ch] text-[14px] text-muted">Notes your agents keep for you and for each project. Agents save and forget them; this page only shows them.</p>
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
