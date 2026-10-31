import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { PikaLogo } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { BUTTON, cx, EmptyState, ErrorState, Page, PageTitle, Pill, Properties, Skeleton, SkeletonLines, Toggle, type Property } from "../components/ui";
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
import { deviceLabel } from "../lib/devices";
import { formatDateTime, formatDuration, formatRelative, plural } from "../lib/format";
import type { RunDetail, RunSummary } from "../lib/types";
import { NotFoundPage } from "./NotFound";

const PAGE_SIZE = 50;

function runDuration(run: RunSummary): number | undefined {
	const ms = Date.parse(run.lastAt) - Date.parse(run.startedAt);
	return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** The runs list's columns: the name plate, the status, the steps, and the start. */
const RUN_COLUMNS = "grid grid-cols-[minmax(0,1fr)_96px] gap-x-4 md:grid-cols-[minmax(0,1fr)_minmax(140px,auto)_64px_104px]";
const WIDE = "max-md:hidden";
const LINK = "text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink";

function RunRow({ run }: { run: RunSummary }) {
	return (
		<Link
			to={`/runs/${encodeURIComponent(run.runId)}`}
			className={cx(RUN_COLUMNS, "items-start border-b border-line px-1.5 py-1.5 text-[13px] leading-5 hover:bg-hover")}
			data-run-row={run.runId}
		>
			<span className="flex min-w-0 flex-col">
				<span className="flex min-w-0 items-center gap-2">
					<span className="min-w-0 truncate text-[13.5px] font-medium">{run.title || run.runId}</span>
					<span className="mono shrink-0 text-[11.5px] leading-5 text-muted">{run.runId}</span>
				</span>
				<span className="flex min-w-0 items-center gap-x-3 text-[12px] text-muted">
					<span className="min-w-0 truncate text-ink/80">{run.repo || "—"}</span>
					<span className="min-w-0 truncate">{deviceLabel(run)}</span>
				</span>
			</span>
			<span className={cx("flex min-w-0 flex-wrap items-center gap-1 pt-px", WIDE)}>
				<Pill tone={runStatusTone(run.status)}>{label(run.status)}</Pill>
				{run.verdict && <Pill tone={verdictTone(run.verdict)}>{label(run.verdict)}</Pill>}
			</span>
			<span className={cx("tnum text-right text-muted", WIDE)}>{plural(run.stepCount, "step")}</span>
			<span className="tnum truncate text-right text-muted" title={run.startedAt}>
				{formatRelative(run.startedAt)}
			</span>
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
		<Page className="pb-24">
			<PageTitle>Herder runs</PageTitle>
			<div className={cx(RUN_COLUMNS, "mt-6 h-7 items-end border-b border-ink px-1.5 pb-1 text-[12px] font-medium text-muted")} aria-hidden="true">
				<span>Run</span>
				<span className={WIDE}>Status</span>
				<span className={cx("text-right", WIDE)}>Steps</span>
				<span className="text-right">Started</span>
			</div>
			{runs.isPending ? (
				<div aria-busy="true" aria-label="Loading runs">
					{[0, 1, 2].map((i) => (
						<div key={i} className="border-b border-line px-1.5 py-2">
							<Skeleton className="h-4 w-1/2" />
							<Skeleton className="mt-1.5 h-3 w-1/4" />
						</div>
					))}
				</div>
			) : runs.isError && items.length === 0 ? (
				<ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
			) : items.length === 0 ? (
				<EmptyState title="No Herder runs" visual={<PikaLogo size={40} />}>
					Runs appear here once a device uploads a Herder journal.
				</EmptyState>
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
							className={cx(BUTTON.secondary, "mt-3")}
						>
							{runs.isFetchingNextPage ? "Loading…" : "Load more"}
						</button>
					)}
				</div>
			)}
		</Page>
	);
}

function H2({ children }: { children: ReactNode }) {
	return <h2 className="mt-9 mb-2 text-[16px] font-semibold">{children}</h2>;
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
		<div>
			{checks.map((check, index) => (
				<div key={`${check.id}:${index}`} className="border-b border-line py-1 last:border-b-0" data-check={check.id} data-passed={check.passed}>
					<div className="flex min-h-6 flex-wrap items-center gap-2 text-[13px]">
						<CheckPill check={check} />
						<span className={check.passed ? "text-muted" : "text-red"}>{check.passed ? "pass" : check.timedOut ? "timed out" : `fail · exit ${check.exitCode ?? "?"}`}</span>
						{check.purpose && <span className="text-muted">{check.purpose}</span>}
						{check.key && <span className="mono text-[12px] text-muted">{check.key}</span>}
						{check.commit && <span className="mono text-[12px] text-muted">{shortSha(check.commit)}</span>}
						{check.durationMs !== undefined && <span className="tnum ml-auto text-muted">{formatDuration(check.durationMs)}</span>}
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
		<div className="border-b border-line py-1.5 last:border-b-0" data-step={step.key}>
			<div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]">
				<Pill>{step.role}</Pill>
				<span className="min-w-0 flex-1 truncate font-medium">{step.label || step.task || step.id}</span>
				<Pill tone={runStatusTone(step.status)}>{label(step.status)}</Pill>
			</div>
			<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
				{step.task && <span>{step.task}</span>}
				{step.phase && <span>{step.phase}</span>}
				<span className="mono">{step.id}</span>
				<span>{plural(step.attempts, "attempt")}</span>
				{step.durationMs !== undefined && <span className="tnum">{formatDuration(step.durationMs)}</span>}
				{step.commit && (
					<span className="mono" title={step.commit}>
						{shortSha(step.commit)}
					</span>
				)}
				{step.sessionId && (
					<Link to={`/s/${encodeURIComponent(step.sessionId)}`} className={cx("ml-auto", LINK)}>
						Session →
					</Link>
				)}
			</div>
			{step.error && <div className="mt-0.5 text-[12.5px] text-red">{step.error}</div>}
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
		<div className="mt-5 first:mt-0" data-launch={group.launch ?? "none"}>
			<div className="flex min-h-7 flex-wrap items-center gap-2 border-b border-ink pb-1 text-[13px]">
				<span className="font-medium">{group.launch === null ? "Other steps" : `Launch ${group.launch}`}</span>
				{group.status && <Pill tone={runStatusTone(group.status)}>{label(group.status)}</Pill>}
				{counts.length > 0 && <span className="tnum text-muted">{counts.join(" · ")}</span>}
				{group.at && <span className="tnum ml-auto text-muted">{formatDateTime(group.at)}</span>}
			</div>
			{group.error && <div className="mt-1 text-[13px] text-red">{group.error}</div>}
			<div>
				{group.steps.length ? group.steps.map((step) => <StepRow key={step.key} step={step} />) : <div className="py-2 text-[13px] text-muted">No steps</div>}
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
		{ icon: "device", label: "Device", value: <Pill title={run.device}>{deviceLabel(run)}</Pill> },
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
				<Link to={`/s/${encodeURIComponent(sessionId)}`} className={LINK}>
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
		<Page className="pb-32">
			<nav className="mb-6 flex items-center gap-1.5 text-[13px] text-muted" aria-label="Breadcrumb">
				<Link to="/runs" className={cx("px-1", LINK)}>
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
								{run.data.goal ? <Markdown text={run.data.goal} className="pb-3" /> : <div className="pb-2 text-[13px] text-muted">No goal uploaded</div>}
							</Toggle>
							<Toggle label={<span className="font-medium">Plan</span>}>
								{run.data.plan ? <Markdown text={run.data.plan} className="pb-3" /> : <div className="pb-2 text-[13px] text-muted">No plan uploaded</div>}
							</Toggle>
						</div>

						<H2>Timeline</H2>
						{view.launches.length ? (
							view.launches.map((group) => <LaunchBlock key={group.launch ?? "none"} group={group} />)
						) : (
							<div className="text-[13px] text-muted">No launches yet</div>
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
									<div key={index} className="border-b border-line py-1.5 last:border-b-0" data-integration={item.key}>
										<div className="flex flex-wrap items-center gap-2 text-[13px]">
											<Pill tone={item.ok ? "green" : "red"}>{item.ok ? "integrated" : label(item.reason ?? "failed")}</Pill>
											<span className="min-w-0 flex-1 truncate font-medium">{item.message ?? item.key}</span>
											{item.head && <span className="mono text-[12px] text-muted">{shortSha(item.head)}</span>}
										</div>
										<div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-muted">
											<span className="mono">{item.key}</span>
											{item.task && <span>{item.task}</span>}
											<span className="tnum">{formatDateTime(item.at)}</span>
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
									<span className="tnum text-[13px] text-muted">{formatDateTime(view.verification.at)}</span>
								</div>
								{view.verification.criteria.length > 0 && (
									<div className="mt-3 border-t border-ink">
										{view.verification.criteria.map((criterion) => (
											<div key={criterion.id} className="flex gap-3 border-b border-line py-1.5 text-[13px] last:border-b-0" data-criterion={criterion.id}>
												<span className="mono w-16 shrink-0 pt-px text-[12px]">{criterion.id}</span>
												<div className="min-w-0 flex-1">
													<Pill tone={verdictTone(criterion.status)}>{label(criterion.status)}</Pill>
													{criterion.evidence && <div className="mt-0.5 text-muted">{criterion.evidence}</div>}
												</div>
											</div>
										))}
									</div>
								)}
								{view.verification.gaps.length > 0 && (
									<div className="mt-3 text-[13px]">
										{view.verification.gaps.map((gap, index) => (
											<div key={index} className="border-b border-line py-1.5 last:border-b-0">
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
									<div key={index} className="border-b border-line py-1.5 text-[13px] last:border-b-0">
										<div className="font-medium">{decision.question}</div>
										<div className="text-muted">{decision.answer}</div>
									</div>
								))}
							</section>
						)}

						{view.delivery && (
							<section data-section="delivery">
								<H2>Delivery</H2>
								<div className="flex flex-wrap items-center gap-2 text-[13px]">
									<Pill tone={view.delivery.done ? "green" : "neutral"}>{view.delivery.done ? "delivered" : "delivering"}</Pill>
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
							<div className="mt-9 border-t border-line pt-2 text-[13px] text-muted">
								Finished {formatDateTime(view.finished.at)} · {label(view.finished.status)}
								{view.finished.reason ? ` · ${view.finished.reason}` : ""}
							</div>
						)}
					</>
				)
			)}
		</Page>
	);
}
