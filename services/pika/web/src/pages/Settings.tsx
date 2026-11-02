import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { BUTTON, Callout, cx, Dialog, EmptyState, ErrorState, Page, PageTitle, Pill, SkeletonLines } from "../components/ui";
import { VisitorOriginsSection } from "../components/VisitorOrigins";
import { useApi } from "../lib/api";
import { formatCount } from "../lib/format";

const PUBLISHING_KEY = ["settings", "publishing"] as const;
/** The published projects table's columns: the project, its trajectories, its status, and its switch. */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-1.5 sm:grid-cols-[minmax(0,1fr)_132px_minmax(0,220px)_auto]";
const INPUT = "mt-1 h-8 w-full rounded-sm border border-line bg-page px-2.5 text-[14px] outline-none focus:border-ink";

function plural(n: number, noun: string): string {
	return `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** Deleting a project: says what goes, and asks for its name to be typed before it can go. */
function DeleteProjectDialog({ project, onDone, onCancel }: { project: string; onDone: (text: string) => void; onCancel: () => void }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const count = useQuery({ queryKey: ["deletion", "project", project], queryFn: () => api.projectDeletion(project), gcTime: 0 });
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	useEffect(() => inputRef.current?.focus(), []);
	const matches = typed === project;

	const confirm = async () => {
		if (!matches || busy) return;
		setBusy(true);
		setError(null);
		try {
			const deleted = await api.deleteProject(project);
			// Sessions, facets, runs, search, and this list all change.
			void queryClient.invalidateQueries();
			onDone(`Deleted ${project}: ${plural(deleted.deletedSessions, "session")} and ${plural(deleted.deletedHerderRuns, "Herder run")}.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	};

	return (
		<Dialog title={`Delete ${project}?`} onCancel={onCancel} label="delete-project" locked={busy}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void confirm();
				}}
			>
				<p className="mt-2 text-[14px] text-muted" data-deletion-count="">
					{count.isPending
						? "Counting what it holds…"
						: count.data
							? <>This deletes {plural(count.data.deletedSessions, "session")}, with the sessions they started even when those are filed under another project, and {plural(count.data.deletedHerderRuns, "Herder run")}, and makes the project private.</>
							: "This deletes every session of the project, the sessions they started, and its Herder runs, and makes it private."}{" "}
					<strong className="font-medium text-ink">It cannot be undone.</strong>
				</p>
				<label htmlFor={inputId} className="mt-3 block text-[13px] text-muted">
					Type <code className="font-mono text-ink">{project}</code> to confirm
				</label>
				<input
					ref={inputRef}
					id={inputId}
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					spellCheck={false}
					autoComplete="off"
					className={INPUT}
				/>
				{error && (
					<div role="alert" className="mt-2 text-[13px] text-red">
						Could not delete it: {error}
					</div>
				)}
				<div className="mt-5 flex justify-end gap-2">
					<button type="button" onClick={onCancel} disabled={busy} className={BUTTON.secondary}>
						Cancel
					</button>
					<button type="submit" disabled={!matches || busy || count.isPending} className={BUTTON.danger}>
						Delete project
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function SettingsPage() {
	const api = useApi();
	const queryClient = useQueryClient();
	const settings = useQuery({ queryKey: PUBLISHING_KEY, queryFn: () => api.publishing() });
	const update = useMutation({
		mutationFn: ({ project, published }: { project: string; published: boolean }) => api.setPublished(project, published),
		onSuccess: (value) => queryClient.setQueryData(PUBLISHING_KEY, value),
	});
	const [deleting, setDeleting] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	return (
		<Page className="pb-24">
			<PageTitle>Settings</PageTitle>
			<section className="mt-9" aria-labelledby="publishing-title">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 id="publishing-title" className="text-[16px] font-semibold">Published projects</h2>
					<Link to="/public" target="_blank" rel="noreferrer" className="text-[13px] text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink">Open public gallery ↗</Link>
				</div>
				<p className="mt-1 max-w-[72ch] text-[14px] text-muted">Choose which projects anyone can browse without signing in. Projects are private until you publish them.</p>
				<div className="mt-4 max-w-[860px]">
					<Callout title="Publishing includes existing and future trajectories">
						<p className="text-[13px]">Visitors can read prompts, responses, thinking, tool inputs and outputs, images, raw session entries, and session metadata. Captured provider requests stay private. Unpublishing removes public access; it cannot recall copies visitors already saved.</p>
					</Callout>
				</div>
				<p className="mt-3 max-w-[72ch] text-[13px] text-muted">A project is the repository or working directory name shown in pika. Matching names across machines and directories share this setting.</p>
				{notice && <div className="mt-4" role="status"><Callout title={notice} /></div>}
				{update.isError && <div className="mt-4"><ErrorState error={update.error} onRetry={() => update.variables && update.mutate(update.variables)} /></div>}
				{settings.isPending ? <div className="mt-6"><SkeletonLines /></div> : settings.isError ? (
					<ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
				) : settings.data.projects.length === 0 ? (
					<EmptyState title="No projects yet">Projects appear here after their first session is uploaded.</EmptyState>
				) : (
					<div className="mt-6">
						<div className={cx(ROW, "hidden h-7 items-end border-b border-ink pb-1 text-[12px] font-medium text-muted sm:grid")} aria-hidden="true">
							<span>Project</span>
							<span className="text-right">Trajectories</span>
							<span>Status</span>
							<span />
						</div>
						<ul>
							{settings.data.projects.map(({ project, sessionCount, hiddenCount = 0, published }) => (
								<li key={project} className={cx(ROW, "min-h-9 gap-y-2 border-b border-line py-2 text-[13px] hover:bg-hover sm:py-1")} data-publishing-project={project}>
									<span className="min-w-0 font-medium break-all">{project}</span>
									<span className="tnum text-right text-muted">
										{formatCount(sessionCount)} {sessionCount === 1 ? "trajectory" : "trajectories"}
										{hiddenCount > 0 && (
											<span className="block text-[12px]" data-hidden-count="" title="Hidden from public, themselves or with the session that started them">
												{formatCount(hiddenCount)} hidden
											</span>
										)}
									</span>
									<span className="flex min-w-0 items-center gap-3">
										<Pill tone={published ? "green" : "neutral"}>{published ? "Public" : "Private"}</Pill>
										{published && (
											<Link to={`/public?project=${encodeURIComponent(project)}`} target="_blank" rel="noreferrer" className="text-[13px] text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink truncate">
												View public project ↗
											</Link>
										)}
									</span>
									<span className="flex justify-end gap-1">
										<button
											type="button"
											role="switch"
											aria-checked={published}
											aria-label={`Publish ${project}`}
											disabled={update.isPending}
											onClick={() => update.mutate({ project, published: !published })}
											className={cx(published ? BUTTON.quiet : BUTTON.secondary, "h-7 min-w-[96px] justify-center")}
										>
											{update.isPending && update.variables?.project === project ? "Saving…" : published ? "Unpublish" : "Publish"}
										</button>
										<button
											type="button"
											onClick={() => {
												setNotice(null);
												setDeleting(project);
											}}
											aria-label={`Delete project ${project}`}
											className={cx(BUTTON.quiet, "h-7 !px-2")}
										>
											Delete project…
										</button>
									</span>
								</li>
							))}
						</ul>
					</div>
				)}
				{deleting && (
					<DeleteProjectDialog
						project={deleting}
						onCancel={() => setDeleting(null)}
						onDone={(text) => {
							setDeleting(null);
							setNotice(text);
						}}
					/>
				)}
			</section>
			<VisitorOriginsSection />
		</Page>
	);
}
