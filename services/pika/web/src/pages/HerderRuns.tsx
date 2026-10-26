import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { EmptyState, ErrorState, PageTitle, Pill, Properties, Skeleton, SkeletonLines, Toggle, type Property } from "../components/ui";
import {
	buildRunView,
	label,
	runStatusTone,
	shortSha,
	verdictTone,
	type CheckRun,
	type LaunchGroup,
	type StepView,
} from "../herder/run";
import { ApiError, useApi } from "../lib/api";
import { formatDateTime, formatDuration, formatRelative, plural } from "../lib/format";
import type { RunDetail, RunSummary } from "../lib/types";
import { NotFoundPage } from "./NotFound";

const PAGE_SIZE = 50;

function runDuration(run: RunSummary): number | undefined {
	const ms = Date.parse(run.lastAt) - Date.parse(run.startedAt);
	return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function RunRow({ run }: { run: RunSummary }) {
	return (
		<Link to={`/runs/${encodeURIComponent(run.runId)}`} className="block rounded-md px-3 py-2.5 hover:bg-hover" data-run-row={run.runId}>
			<div className="flex min-w-0 items-center gap-2">
				<span className="min-w-0 truncate font-medium">{run.title || run.runId}</span>
				<Pill tone={runStatusTone(run.status)}>{label(run.status)}</Pill>
				{run.verdict && <Pill tone={verdictTone(run.verdict)}>{label(run.verdict)}</Pill>}
				<span className="ml-auto shrink-0 pl-3 text-[13px] text-muted" title={run.startedAt}>
					{formatRelative(run.startedAt)}
				</span>
			</div>
			<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
				<span className="flex items-center gap-1">
					<Icon name="folder" size={13} />
					{run.repo || "—"}
				</span>
				<span className="flex items-center gap-1">
					<Icon name="device" size={13} />
					{run.device}
				</span>
				<span>{plural(run.stepCount, "step")}</span>
				<span className="mono">{run.runId}</span>
			</div>
		</Link>
	);
}

export function HerderRunsPage() {
	const api = useApi();
	const runs = useInfiniteQuery({
		queryKey: ["herder-runs"],
		queryFn: ({ pageParam }) => api.herderRuns(pageParam, PAGE_SIZE),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
	});
	const items = useMemo(() => runs.data?.pages.flatMap((page) => page.items) ?? [], [runs.data]);
	return (
		<div className="mx-auto w-full max-w-[1200px] px-12 pt-16 pb-24">
			<PageTitle>Herder runs</PageTitle>
			<hr className="mt-6 mb-2 border-0 border-t border-line" />
			{runs.isPending ? (
				<div aria-busy="true" aria-label="Loading runs" className="space-y-4 px-3 py-3">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-10 w-full" />
					))}
				</div>
			) : runs.isError && items.length === 0 ? (
				<ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
			) : items.length === 0 ? (
				<EmptyState title="No Herder runs">Runs appear here once a device uploads a Herder journal.</EmptyState>
			) : (
				<div data-run-list="">
					{items.map((run) => (
						<RunRow key={run.runId} run={run} />
					))}
					{runs.hasNextPage && (
						<button
							type="button"
							disabled={runs.isFetchingNextPage}
							onClick={() => void runs.fetchNextPage()}
							className="mt-2 rounded-sm px-3 py-1 text-[14px] text-muted hover:bg-hover"
						>
							{runs.isFetchingNextPage ? "Loading…" : "Load more"}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function H2({ children }: { children: ReactNode }) {
	return <h2 className="mt-10 mb-2 text-[20px] font-semibold">{children}</h2>;
}

function CheckPill({ check }: { check: CheckRun }) {
	return (
		<Pill tone={check.passed ? "green" : "red"} title={check.timedOut ? "timed out" : `exit ${check.exitCode ?? "?"}`}>
			{check.passed ? "✓" : "✗"} {check.id}
		</Pill>
	);
}

function CheckList({ checks }: { checks: CheckRun[] }) {
	return (
		<div className="space-y-1">
			{checks.map((check, index) => (
				<div key={`${check.id}:${index}`} data-check={check.id} data-passed={check.passed}>
					<div className="flex flex-wrap items-center gap-2 text-[14px]">
						<CheckPill check={check} />
						<span className="text-muted">{check.passed ? "pass" : check.timedOut ? "timed out" : `fail · exit ${check.exitCode ?? "?"}`}</span>
						{check.purpose && <span className="text-[13px] text-muted">{check.purpose}</span>}
						{check.key && <span className="mono text-[12px] text-muted">{check.key}</span>}
						{check.commit && <span className="mono text-[12px] text-muted">{shortSha(check.commit)}</span>}
						{check.durationMs !== undefined && <span className="ml-auto text-[13px] text-muted">{formatDuration(check.durationMs)}</span>}
					</div>
					{check.tail && (
						<Toggle className="mt-0.5 text-[13px]" label={<span className="text-muted">Tail</span>}>
							<pre className="code-block wrap" style={{ maxHeight: "20rem" }}>
								{check.tail}
							</pre>
						</Toggle>
					)}
				</div>
			))}
		</div>
	);
}

function StepRow({ step }: { step: StepView }) {
	return (
		<div className="border-b border-line py-2.5 last:border-b-0" data-step={step.key}>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<Pill tone="accent">{step.role}</Pill>
				<span className="min-w-0 flex-1 truncate font-medium">{step.label || step.task || step.id}</span>
				<Pill tone={runStatusTone(step.status)}>{label(step.status)}</Pill>
			</div>
			<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
				{step.task && <span>{step.task}</span>}
				{step.phase && <span>{step.phase}</span>}
				<span className="mono">{step.id}</span>
				<span>{plural(step.attempts, "attempt")}</span>
				{step.durationMs !== undefined && <span>{formatDuration(step.durationMs)}</span>}
				{step.commit && (
					<span className="mono" title={step.commit}>
						{shortSha(step.commit)}
					</span>
				)}
				{step.sessionId && (
					<Link to={`/s/${encodeURIComponent(step.sessionId)}`} className="ml-auto text-accent hover:underline">
						Session →
					</Link>
				)}
			</div>
			{step.error && <div className="mt-1 text-[13px] text-red">{step.error}</div>}
			{step.checks.length > 0 && (
				<div className="mt-1.5">
					<CheckList checks={step.checks} />
				</div>
			)}
		</div>
	);
}

function LaunchBlock({ group }: { group: LaunchGroup }) {
	const counts = [
		group.new !== undefined && `${group.new} new`,
		group.reused !== undefined && `${group.reused} reused`,
		group.changed !== undefined && `${group.changed} changed`,
	].filter(Boolean);
	return (
		<div className="mt-4 rounded-md border border-line px-4 py-3" data-launch={group.launch ?? "none"}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{group.launch === null ? "Other steps" : `Launch ${group.launch}`}</span>
				{group.status && <Pill tone={runStatusTone(group.status)}>{label(group.status)}</Pill>}
				{counts.length > 0 && <span className="text-[13px] text-muted">{counts.join(" · ")}</span>}
				{group.at && <span className="ml-auto text-[13px] text-muted">{formatDateTime(group.at)}</span>}
			</div>
			{group.error && <div className="mt-1 text-[13px] text-red">{group.error}</div>}
			<div className="mt-1">
				{group.steps.length ? group.steps.map((step) => <StepRow key={step.key} step={step} />) : <div className="py-2 text-[14px] text-muted italic">No steps</div>}
			</div>
		</div>
	);
}

function runProperties(detail: RunDetail, sessionId?: string): Property[] {
	const { run } = detail;
	const items: Property[] = [
		{ icon: "info", label: "Status", value: <Pill tone={runStatusTone(run.status)}>{label(run.status)}</Pill> },
		{
			icon: "sparkle",
			label: "Verdict",
			value: run.verdict ? <Pill tone={verdictTone(run.verdict)}>{label(run.verdict)}</Pill> : <span className="text-muted">—</span>,
		},
		{ icon: "folder", label: "Repo", value: run.repo || "—" },
		{ icon: "device", label: "Device", value: <Pill>{run.device}</Pill> },
		{
			icon: "calendar",
			label: "Started",
			value: (
				<span title={run.startedAt}>
					{formatDateTime(run.startedAt)} <span className="text-muted">· {formatRelative(run.startedAt)}</span>
				</span>
			),
		},
		{ icon: "clock", label: "Duration", value: formatDuration(runDuration(run)) },
		{ icon: "tag", label: "Run", value: <span className="mono">{run.runId}</span> },
	];
	if (sessionId) {
		items.push({
			icon: "parent",
			label: "Orchestrator",
			value: (
				<Link to={`/s/${encodeURIComponent(sessionId)}`} className="text-accent hover:underline">
					Orchestrating session
				</Link>
			),
		});
	}
	return items;
}

export function HerderRunPage() {
	const { id = "" } = useParams();
	const api = useApi();
	const run = useQuery({ queryKey: ["herder-run", id], queryFn: () => api.herderRun(id) });
	const view = useMemo(() => (run.data ? buildRunView(run.data) : undefined), [run.data]);

	if (run.error instanceof ApiError && run.error.status === 404) return <NotFoundPage what="run" />;
	return (
		<div className="mx-auto w-full max-w-[900px] px-12 pt-16 pb-32">
			<nav className="mb-6 flex items-center gap-1.5 text-[13px] text-muted" aria-label="Breadcrumb">
				<Link to="/runs" className="rounded-sm px-1 hover:bg-hover">
					Herder runs
				</Link>
				{run.data?.run.repo && (
					<>
						<span>/</span>
						<span className="px-1">{run.data.run.repo}</span>
					</>
				)}
			</nav>
			{run.isPending ? (
				<SkeletonLines lines={6} />
			) : run.isError ? (
				<ErrorState error={run.error} onRetry={() => void run.refetch()} />
			) : (
				view && (
					<>
						<PageTitle>{run.data.run.title || run.data.run.runId}</PageTitle>
						<Properties items={runProperties(run.data, view.sessionId)} />
						<div className="space-y-1 border-y border-line py-2">
							<Toggle label={<span className="font-medium">Goal</span>}>
								{run.data.goal ? <Markdown text={run.data.goal} className="pb-3" /> : <div className="text-muted italic">No goal uploaded</div>}
							</Toggle>
							<Toggle label={<span className="font-medium">Plan</span>}>
								{run.data.plan ? <Markdown text={run.data.plan} className="pb-3" /> : <div className="text-muted italic">No plan uploaded</div>}
							</Toggle>
						</div>

						<H2>Timeline</H2>
						{view.launches.length ? (
							view.launches.map((group) => <LaunchBlock key={group.launch ?? "none"} group={group} />)
						) : (
							<div className="text-muted italic">No launches yet</div>
						)}

						{view.checkRuns.length > 0 && (
							<section data-section="checks">
								<H2>Checks</H2>
								<CheckList checks={view.checkRuns} />
							</section>
						)}

						{view.integrations.length > 0 && (
							<section data-section="integrations">
								<H2>Integrations</H2>
								{view.integrations.map((item, index) => (
									<div key={index} className="border-b border-line py-2.5 last:border-b-0" data-integration={item.key}>
										<div className="flex flex-wrap items-center gap-2">
											<Pill tone={item.ok ? "green" : "red"}>{item.ok ? "integrated" : label(item.reason ?? "failed")}</Pill>
											<span className="min-w-0 flex-1 truncate font-medium">{item.message ?? item.key}</span>
											{item.head && <span className="mono text-[12px] text-muted">{shortSha(item.head)}</span>}
										</div>
										<div className="mt-1 flex flex-wrap gap-x-3 text-[13px] text-muted">
											<span className="mono">{item.key}</span>
											{item.task && <span>{item.task}</span>}
											<span>{formatDateTime(item.at)}</span>
										</div>
										{item.conflicts.length > 0 && <div className="mt-1 text-[13px] text-red">Conflicts: {item.conflicts.join(", ")}</div>}
										{item.error && <div className="mt-1 text-[13px] text-red">{item.error}</div>}
										{item.checks.length > 0 && (
											<div className="mt-1.5 flex flex-wrap gap-1.5">
												{item.checks.map((check, i) => (
													<CheckPill key={i} check={check} />
												))}
											</div>
										)}
									</div>
								))}
							</section>
						)}

						{view.verification && (
							<section data-section="verification">
								<H2>Verification</H2>
								<div className="flex flex-wrap items-center gap-2">
									<Pill tone={verdictTone(view.verification.verdict)}>{label(view.verification.verdict)}</Pill>
									{view.verification.head && <span className="mono text-[12px] text-muted">{shortSha(view.verification.head)}</span>}
									<span className="text-[13px] text-muted">{formatDateTime(view.verification.at)}</span>
								</div>
								{view.verification.criteria.length > 0 && (
									<div className="mt-3 space-y-2">
										{view.verification.criteria.map((criterion) => (
											<div key={criterion.id} className="flex gap-3" data-criterion={criterion.id}>
												<span className="w-16 shrink-0 font-medium">{criterion.id}</span>
												<div className="min-w-0 flex-1">
													<Pill tone={verdictTone(criterion.status)}>{label(criterion.status)}</Pill>
													{criterion.evidence && <div className="mt-0.5 text-[14px] text-muted">{criterion.evidence}</div>}
												</div>
											</div>
										))}
									</div>
								)}
								{view.verification.gaps.length > 0 && (
									<div className="mt-3 space-y-1 text-[14px]">
										{view.verification.gaps.map((gap, index) => (
											<div key={index}>
												<Pill tone="yellow">{gap.kind}</Pill> {gap.criteria.join(", ")} <span className="text-muted">{gap.text}</span>
											</div>
										))}
									</div>
								)}
								{view.verification.checks.length > 0 && (
									<div className="mt-3">
										<CheckList checks={view.verification.checks} />
									</div>
								)}
							</section>
						)}

						{view.decisions.length > 0 && (
							<section data-section="decisions">
								<H2>Decisions</H2>
								{view.decisions.map((decision, index) => (
									<div key={index} className="border-b border-line py-2 last:border-b-0">
										<div className="font-medium">{decision.question}</div>
										<div className="text-[14px] text-muted">{decision.answer}</div>
									</div>
								))}
							</section>
						)}

						{view.delivery && (
							<section data-section="delivery">
								<H2>Delivery</H2>
								<div className="flex flex-wrap items-center gap-2 text-[14px]">
									<Pill tone={view.delivery.done ? "green" : "accent"}>{view.delivery.done ? "delivered" : "delivering"}</Pill>
									{view.delivery.mode && <span>{view.delivery.mode}</span>}
									{view.delivery.target && <span className="mono text-[13px]">{view.delivery.target}</span>}
									{view.delivery.tip && <span className="mono text-[12px] text-muted">{shortSha(view.delivery.tip)}</span>}
									<span className="text-muted">{plural(view.delivery.commits.length, "commit")}</span>
								</div>
								{view.delivery.checks.length > 0 && (
									<div className="mt-2 flex flex-wrap gap-1.5">
										{view.delivery.checks.map((check, i) => (
											<CheckPill key={i} check={check} />
										))}
									</div>
								)}
							</section>
						)}

						{view.finished && (
							<div className="mt-10 text-[14px] text-muted">
								Finished {formatDateTime(view.finished.at)} · {label(view.finished.status)}
								{view.finished.reason ? ` · ${view.finished.reason}` : ""}
							</div>
						)}
					</>
				)
			)}
		</div>
	);
}
