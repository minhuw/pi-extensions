import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { BUTTON, Callout, cx, EmptyState, ErrorState, Page, PageTitle, Pill, SkeletonLines } from "../components/ui";
import { useApi } from "../lib/api";
import { formatCount } from "../lib/format";

const PUBLISHING_KEY = ["settings", "publishing"] as const;
/** The published projects table's columns: the project, its trajectories, its status, and its switch. */
const ROW = "grid grid-cols-[minmax(0,1fr)_112px_minmax(0,220px)_112px] items-center gap-x-4 px-1.5";

export function SettingsPage() {
	const api = useApi();
	const queryClient = useQueryClient();
	const settings = useQuery({ queryKey: PUBLISHING_KEY, queryFn: () => api.publishing() });
	const update = useMutation({
		mutationFn: ({ project, published }: { project: string; published: boolean }) => api.setPublished(project, published),
		onSuccess: (value) => queryClient.setQueryData(PUBLISHING_KEY, value),
	});
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
				{update.isError && <div className="mt-4"><ErrorState error={update.error} onRetry={() => update.variables && update.mutate(update.variables)} /></div>}
				{settings.isPending ? <div className="mt-6"><SkeletonLines /></div> : settings.isError ? (
					<ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
				) : settings.data.projects.length === 0 ? (
					<EmptyState title="No projects yet">Projects appear here after their first session is uploaded.</EmptyState>
				) : (
					<div className="mt-6">
						<div className={cx(ROW, "h-7 items-end border-b border-ink pb-1 text-[12px] font-medium text-muted")} aria-hidden="true">
							<span>Project</span>
							<span className="text-right">Trajectories</span>
							<span>Status</span>
							<span />
						</div>
						<ul>
							{settings.data.projects.map(({ project, sessionCount, published }) => (
								<li key={project} className={cx(ROW, "min-h-9 border-b border-line py-1 text-[13px] hover:bg-hover")} data-publishing-project={project}>
									<span className="min-w-0 font-medium break-all">{project}</span>
									<span className="tnum text-right text-muted">
										{formatCount(sessionCount)} {sessionCount === 1 ? "trajectory" : "trajectories"}
									</span>
									<span className="flex min-w-0 items-center gap-3">
										<Pill tone={published ? "green" : "neutral"}>{published ? "Public" : "Private"}</Pill>
										{published && (
											<Link to={`/public?project=${encodeURIComponent(project)}`} target="_blank" rel="noreferrer" className="text-[13px] text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink truncate">
												View public project ↗
											</Link>
										)}
									</span>
									<span className="flex justify-end">
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
									</span>
								</li>
							))}
						</ul>
					</div>
				)}
			</section>
		</Page>
	);
}
