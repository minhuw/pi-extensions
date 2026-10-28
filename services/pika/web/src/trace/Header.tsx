import { useState, type ReactNode } from "react";
import { PikaLink as Link } from "../components/PikaLink";
import { Icon, type IconName } from "../components/icons";
import { cx } from "../components/ui";
import { deviceLabel } from "../lib/devices";
import { formatCost, formatCount, formatDateTime, formatDuration, formatRelative, plural, totalTokens } from "../lib/format";
import type { ChildSession, SessionDetail, SessionTrace, Tokens } from "../lib/types";
import { childLabel } from "../session/subagents";
import { formatSpan, middleTruncate } from "./format";
import { contextTokens, FAMILIES, FAMILY_CLASSES, FAMILY_LABELS, recordDuration, recordFamily, recordIsError, type Family } from "./kinds";

export type SessionViewMode = "trajectory" | "transcript";

function Chip({ icon, children, title, className }: { icon: IconName; children: ReactNode; title?: string; className?: string }) {
	return (
		<span className={cx("inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-[12.5px] text-muted", className)} title={title}>
			<Icon name={icon} size={13} className="shrink-0 opacity-80" />
			{children}
		</span>
	);
}

function CopyPath({ path }: { path: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(path);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			setCopied(false);
		}
	};
	return (
		<span className="group inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-[12.5px] text-muted hover:bg-hover" title={path} data-cwd="">
			<Icon name="terminal" size={13} className="shrink-0 opacity-80" />
			<span className="mono truncate text-[12px] text-ink/80">{middleTruncate(path, 44)}</span>
			<button
				type="button"
				onClick={() => void copy()}
				className="shrink-0 rounded-sm text-muted opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
				aria-label="Copy the working directory"
			>
				<Icon name={copied ? "check" : "copy"} size={12} />
			</button>
		</span>
	);
}

/** The line of chips under the title: where, when, how long, which models, and the session's parents. */
export function SessionChips({ session }: { session: SessionDetail }) {
	const link = session.link;
	const what = link?.kind === "herder-step" ? "Herder step" : link?.agentType ? `${link.agentType} subagent` : "Child session";
	return (
		<div className="mt-1.5 -ml-1.5 flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-0.5" data-session-chips="">
			<Chip icon="device" title={session.device}>
				<span className="truncate" data-device-chip="">
					{deviceLabel(session)}
				</span>
			</Chip>
			<Link to={`/?project=${encodeURIComponent(session.project)}`} className="rounded-sm hover:bg-hover">
				<Chip icon="folder">
					<span className="truncate text-ink/80">{session.project || "—"}</span>
				</Chip>
			</Link>
			<CopyPath path={session.cwd} />
			<Chip icon="calendar" title={formatDateTime(session.startedAt)}>
				<span data-started="">{formatRelative(session.startedAt)}</span>
			</Chip>
			<Chip icon="clock" title="Duration">
				<span className="tnum">{formatDuration(session.durationMs)}</span>
			</Chip>
			{session.models.map((model) => (
				<span key={model} className="mono mx-0.5 inline-flex h-5 items-center rounded-[3px] bg-hover px-1.5 text-[11.5px] text-ink/80" title="Model">
					{model}
				</span>
			))}
			{session.parentSessionId && (
				<Link
					to={`/s/${encodeURIComponent(session.parentSessionId)}`}
					className="inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-[12.5px] text-accent hover:bg-hover"
					title={link?.description ? `${what} · ${link.description}` : what}
				>
					<Icon name="parent" size={13} />
					Parent session
					<span className="text-muted">· {what}</span>
				</Link>
			)}
			{session.herderRunId && (
				<Link
					to={`/runs/${encodeURIComponent(session.herderRunId)}`}
					className="inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-[12.5px] text-accent hover:bg-hover"
					title="Herder run"
				>
					<Icon name="herder" size={13} />
					<span className="mono text-[12px]">{session.herderRunId}</span>
					{link?.herder?.task && <span className="text-muted">· step {link.herder.task}</span>}
				</Link>
			)}
		</div>
	);
}

function Tile({ kpi, label, value, sub, visual, title }: { kpi: string; label: string; value: ReactNode; sub?: ReactNode; visual?: ReactNode; title?: string }) {
	return (
		<div className="group relative flex h-[58px] min-w-0 flex-col justify-center gap-1 px-3" data-kpi={kpi} title={title}>
			<div className="flex min-w-0 items-center gap-2">
				<span className="truncate text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
			</div>
			<div className="flex min-w-0 items-end gap-2">
				<span className="tnum shrink-0 text-[17px] leading-none font-semibold tracking-[-0.01em]" data-kpi-value="">
					{value}
				</span>
				{sub && <span className="tnum shrink-0 text-[11.5px] leading-none whitespace-nowrap text-muted">{sub}</span>}
				{visual && <span className="ml-auto flex min-w-0 flex-1 items-end justify-end overflow-hidden">{visual}</span>}
			</div>
		</div>
	);
}

/** The largest of `values[from..to)`, or 0; a loop, since spreading a long session's values overflows the stack. */
function largest(values: number[], from = 0, to = values.length): number {
	let top = 0;
	for (let i = from; i < Math.min(to, values.length); i++) if (values[i] > top) top = values[i];
	return top;
}

/** Tiny columns, one per value, aggregated to at most `max`. */
function Columns({ values, max = 28, className }: { values: number[]; max?: number; className: string }) {
	if (values.length < 2) return null;
	const buckets: number[] = [];
	const size = Math.ceil(values.length / max);
	for (let i = 0; i < values.length; i += size) buckets.push(largest(values, i, i + size));
	const top = Math.max(1, largest(buckets));
	return (
		<span className="flex h-[18px] items-end gap-[1.5px]" aria-hidden="true">
			{buckets.map((value, i) => (
				<span key={i} className={cx("w-[3px] rounded-[1px] opacity-70", className)} style={{ height: `${Math.max(8, (value / top) * 100)}%` }} />
			))}
		</span>
	);
}

function Sparkline({ values, className }: { values: number[]; className: string }) {
	if (values.length < 2) return null;
	const top = Math.max(1, largest(values));
	const w = 64;
	const h = 18;
	const points = values.map((value, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 1 - (value / top) * (h - 2)).toFixed(1)}`).join(" ");
	return (
		<svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cx("shrink-0", className)} aria-hidden="true">
			<polyline points={`0,${h} ${points} ${w},${h}`} fill="currentColor" fillOpacity={0.1} stroke="none" />
			<polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
		</svg>
	);
}

const TOKEN_PARTS: [keyof Tokens, string, string][] = [
	["cacheRead", "Cache read", "bg-k-read"],
	["cacheWrite", "Cache write", "bg-k-compaction"],
	["input", "Input", "bg-k-user"],
	["output", "Output", "bg-k-llm"],
];

function TokenBar({ tokens }: { tokens: Tokens }) {
	const total = totalTokens(tokens);
	if (!total) return null;
	return (
		<>
			<span className="flex h-[6px] w-full max-w-[72px] min-w-[20px] overflow-hidden rounded-full bg-hover" aria-hidden="true">
				{TOKEN_PARTS.map(([key, , color]) =>
					tokens[key] ? <span key={key} className={cx(color, "opacity-80")} style={{ width: `${(tokens[key] / total) * 100}%` }} /> : null,
				)}
			</span>
			<span
				role="tooltip"
				className="pointer-events-none absolute top-full left-2 z-30 mt-1 hidden w-[210px] rounded-md border border-line bg-page px-3 py-2 text-[12px] shadow-[0_4px_16px_rgba(15,15,15,0.12)] group-hover:block"
				data-token-legend=""
			>
				{TOKEN_PARTS.map(([key, label, color]) => (
					<span key={key} className="flex items-center gap-2 py-px">
						<span className={cx("size-2 rounded-[2px] opacity-80", color)} />
						<span className="text-muted">{label}</span>
						<span className="mono tnum ml-auto text-[11.5px]">{tokens[key].toLocaleString("en-US")}</span>
					</span>
				))}
			</span>
		</>
	);
}

function FamilyBar({ counts }: { counts: Map<Family, number> }) {
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	if (!total) return null;
	return (
		<span
			className="flex h-[6px] w-full max-w-[64px] min-w-[20px] overflow-hidden rounded-full bg-hover"
			title={FAMILIES.filter((f) => counts.get(f))
				.map((f) => `${FAMILY_LABELS[f]}: ${counts.get(f)}`)
				.join("\n")}
		>
			{FAMILIES.map((family) =>
				counts.get(family) ? (
					<span key={family} className={cx(FAMILY_CLASSES[family].bar, "opacity-80")} style={{ width: `${((counts.get(family) ?? 0) / total) * 100}%` }} />
				) : null,
			)}
		</span>
	);
}

function SubagentLinks({ items }: { items: ChildSession[] }) {
	const [open, setOpen] = useState(false);
	const shown = items.slice(0, 1);
	return (
		<span className="flex min-w-0 items-center gap-1" data-subagents="">
			{shown.map((child) => {
				const { type, description } = childLabel(child);
				return (
					<Link
						key={child.id}
						to={`/s/${encodeURIComponent(child.id)}`}
						className="inline-flex h-[18px] max-w-[84px] min-w-0 items-center truncate rounded-[3px] bg-k-agent/12 px-1.5 text-[11px] text-k-agent hover:bg-k-agent/20"
						title={`${type} · ${description}`}
					>
						{type}
					</Link>
				);
			})}
			{items.length > shown.length && (
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					className="inline-flex h-[18px] items-center rounded-[3px] px-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
				>
					+{items.length - shown.length}
				</button>
			)}
			{open && (
				<span className="absolute top-full right-0 z-30 mt-1 flex max-h-[320px] w-[300px] flex-col overflow-y-auto rounded-md border border-line bg-page p-1 shadow-[0_4px_16px_rgba(15,15,15,0.12)]">
					{items.map((child) => {
						const { type, description } = childLabel(child);
						return (
							<Link
								key={child.id}
								to={`/s/${encodeURIComponent(child.id)}`}
								className="flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-[12.5px] hover:bg-hover"
								title={child.title}
							>
								<span className="shrink-0 font-medium text-k-agent">{type}</span>
								<span className="min-w-0 truncate text-muted">{description}</span>
							</Link>
						);
					})}
				</span>
			)}
		</span>
	);
}

/** Dense key numbers, each with a tiny graphic. */
export function KpiStrip({ session, trace }: { session: SessionDetail; trace?: SessionTrace }) {
	const records = trace?.records ?? [];
	const llm = records.filter((record) => record.kind === "llm");
	const tools = records.filter((record) => record.kind === "tool");
	const errors = tools.filter(recordIsError).length;
	const families = new Map<Family, number>();
	for (const record of tools) families.set(recordFamily(record), (families.get(recordFamily(record)) ?? 0) + 1);
	const durations = llm.map((record) => recordDuration(record)).filter((d): d is number => d !== undefined);
	const average = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : undefined;
	const contexts = llm.map(contextTokens);
	const peak = largest(contexts);
	const turns = trace?.turns ?? [];
	const total = totalTokens(session.tokens);
	const children = session.children;
	return (
		<div
			className="mt-4 grid grid-cols-2 divide-line overflow-visible rounded-md border border-line sm:grid-cols-4 sm:divide-x xl:grid-cols-7"
			data-kpi-strip=""
		>
			<Tile kpi="turns" label="Turns" value={trace ? formatCount(turns.length) : "—"} visual={<Columns values={turns.map((turn) => turn.durationMs)} className="bg-k-user" />} title="Turn durations" />
			<Tile kpi="llm" label="Model calls" value={trace ? formatCount(llm.length) : "—"} sub={average !== undefined ? `avg ${formatSpan(average)}` : undefined} />
			<Tile
				kpi="tools"
				label="Tool calls"
				value={trace ? formatCount(tools.length) : "—"}
				sub={errors > 0 ? <span className="text-red" data-kpi-errors="">{plural(errors, "error")}</span> : undefined}
				visual={<FamilyBar counts={families} />}
			/>
			<Tile kpi="tokens" label="Tokens" value={formatCount(total)} visual={<TokenBar tokens={session.tokens} />} />
			<Tile kpi="cost" label="Cost" value={formatCost(session.cost)} sub={turns.length > 1 && session.cost > 0 ? `${formatCost(session.cost / turns.length)} / turn` : undefined} />
			<Tile
				kpi="subagents"
				label="Subagents"
				value={formatCount(children.length)}
				visual={children.length > 0 ? <SubagentLinks items={children} /> : undefined}
			/>
			<Tile
				kpi="context"
				label="Peak context"
				value={peak ? formatCount(peak) : "—"}
				visual={<Sparkline values={contexts} className="text-k-llm" />}
				title="The most tokens one model call read: input, cache read, and cache write"
			/>
		</div>
	);
}

export function ViewSwitch({ view, onChange }: { view: SessionViewMode; onChange: (view: SessionViewMode) => void }) {
	const options: [SessionViewMode, string][] = [
		["trajectory", "Trajectory"],
		["transcript", "Transcript"],
	];
	return (
		<div className="flex h-7 items-center rounded-md bg-hover p-0.5" role="radiogroup" aria-label="View" data-view-switch={view}>
			{options.map(([value, label]) => (
				<button
					key={value}
					type="button"
					role="radio"
					aria-checked={view === value}
					onClick={() => onChange(value)}
					className={cx(
						"h-full rounded-[4px] px-2.5 text-[12.5px] transition-colors duration-150",
						view === value ? "bg-page font-medium text-ink shadow-[0_1px_2px_rgba(15,15,15,0.1)]" : "text-muted hover:text-ink",
					)}
					data-view={value}
				>
					{label}
				</button>
			))}
		</div>
	);
}
