import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Callout, EmptyState, ErrorState, Page, PageTitle, Pill, SkeletonLines } from "../components/ui";
import { useApi } from "../lib/api";
import { formatCount } from "../lib/format";

const PUBLISHING_KEY = ["settings", "publishing"] as const;

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
			<section className="mt-6" aria-labelledby="publishing-title">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 id="publishing-title" className="text-[16px] font-semibold">Published projects</h2>
					<Link to="/public" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">Open public gallery ↗</Link>
				</div>
				<p className="mt-2 text-[14px] text-muted">Choose which projects anyone can browse without signing in. Projects are private until you publish them.</p>
				<div className="mt-4">
					<Callout title="Publishing includes existing and future trajectories">
						<p className="text-[13px]">Visitors can read prompts, responses, thinking, tool inputs and outputs, images, raw session entries, and session metadata. Captured provider requests stay private. Unpublishing removes public access; it cannot recall copies visitors already saved.</p>
					</Callout>
				</div>
				<p className="mt-3 text-[13px] text-muted">A project is the repository or working directory name shown in pika. Matching names across machines and directories share this setting.</p>
				{update.isError && <div className="mt-4"><ErrorState error={update.error} onRetry={() => update.variables && update.mutate(update.variables)} /></div>}
				{settings.isPending ? <div className="mt-6"><SkeletonLines /></div> : settings.isError ? (
					<ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
				) : settings.data.projects.length === 0 ? (
					<EmptyState title="No projects yet">Projects appear here after their first session is uploaded.</EmptyState>
				) : (
					<ul className="mt-5 divide-y divide-line border-y border-line">
						{settings.data.projects.map(({ project, sessionCount, published }) => (
							<li key={project} className="flex flex-wrap items-center gap-3 py-4" data-publishing-project={project}>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2"><span className="break-all text-[14px] font-medium">{project}</span><Pill tone={published ? "green" : "neutral"}>{published ? "Public" : "Private"}</Pill></div>
									<div className="mt-1 text-[13px] text-muted">{formatCount(sessionCount)} {sessionCount === 1 ? "trajectory" : "trajectories"}</div>
								</div>
								{published && <Link to={`/public?project=${encodeURIComponent(project)}`} target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">View public project ↗</Link>}
								<button type="button" role="switch" aria-checked={published} aria-label={`Publish ${project}`} disabled={update.isPending} onClick={() => update.mutate({ project, published: !published })} className="rounded-sm border border-line px-3 py-1.5 text-[13px] hover:bg-hover disabled:opacity-50">
									{update.isPending && update.variables?.project === project ? "Saving…" : published ? "Unpublish" : "Publish"}
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
		</Page>
	);
}
