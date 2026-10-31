import { useState, type ReactNode } from "react";
import { PikaLink as Link } from "../components/PikaLink";
import { Icon, type IconName } from "../components/icons";
import { cx } from "../components/ui";
import { deviceLabel } from "../lib/devices";
import { formatCost, formatCount, formatDateTime, formatDuration, formatRelative, plural, totalTokens } from "../lib/format";
import type { ChildSession, SessionDetail, SessionTrace, Tokens, TraceCompactionRecord } from "../lib/types";
import { childLabel } from "../lib/labels";
import { formatSpan, middleTruncate } from "./format";
import { contextTokens, FAMILIES, FAMILY_LABELS, recordDuration, recordFamily, recordIsError, type Family } from "./kinds";
import { KindBullet } from "./parts";

export type SessionViewMode = "trajectory" | "transcript" | "agents";

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

/**
 * One figure of the totals row: the number over its label, set in tabular figures. `detail` is a labelled breakdown on
 * the label's line; `visual` is a small graphic beside the number, which must carry its own labels. Nothing is clipped:
 * where a tile is too narrow, the pieces wrap onto the next line and the row grows.
 */
function Tile({
	kpi,
	label,
	value,
	sub,
	visual,
	detail,
	title,
}: {
	kpi: string;
	label: string;
	value: ReactNode;
	sub?: ReactNode;
	visual?: ReactNode;
	detail?: ReactNode;
	title?: string;
}) {
	return (
		<div className="group relative flex min-h-[62px] min-w-0 flex-col justify-center gap-1.5 px-4 py-2.5 first:pl-6" data-kpi={kpi} title={title}>
			<div className="flex min-w-0 flex-wrap items-end gap-x-2 gap-y-1.5">
				<span className="tnum shrink-0 text-[21px] leading-none font-semibold tracking-[-0.02em]" data-kpi-value="">
					{value}
				</span>
				{sub && <span className="tnum shrink-0 text-[12px] leading-none whitespace-nowrap text-muted">{sub}</span>}
				{visual && <span className="ml-auto flex max-w-full min-w-0 items-end justify-end">{visual}</span>}
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<span className="shrink-0 text-[12px] leading-none text-muted">{label}</span>
				{detail && (
					<span className="tnum ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11.5px] leading-none whitespace-nowrap text-muted">
						{detail}
					</span>
				)}
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

/**
 * The context window as a fixed-length bar, like a tape filling toward its length. pika does not know a model's window,
 * so the track runs from 0 to the session's peak, both ends labelled; the fill is what the latest call read, and each
 * compaction is a tick where the context stood when it was compacted.
 */
function ContextBar({ latest, peak, compactions }: { latest: number; peak: number; compactions: TraceCompactionRecord[] }) {
	const at = (tokens: number) => `${Math.max(0, Math.min(1, tokens / peak)) * 100}%`;
	return (
		<span className="flex w-[76px] shrink-0 flex-col gap-[3px]" aria-hidden="true">
			<span className="relative h-[6px] bg-hover">
				<span className="absolute inset-y-0 left-0 bg-ink" style={{ width: at(latest) }} />
				{compactions.map((record) =>
					record.tokensBefore ? <span key={record.seq} className="absolute -inset-y-[3px] w-[2px] -translate-x-1/2 bg-k-compaction" style={{ left: at(record.tokensBefore) }} /> : null,
				)}
			</span>
			<span className="tnum flex justify-between text-[9.5px] leading-none text-muted">
				<span>0</span>
				<span>{formatCount(peak)}</span>
			</span>
		</span>
	);
}

/** The share of the prompt read from cache, over the whole session. */
function cachedShare(tokens: Tokens): number | undefined {
	const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	return prompt > 0 && tokens.cacheRead > 0 ? tokens.cacheRead / prompt : undefined;
}

/** Token kinds as steps of ink, so the line colours stay with record kinds. */
const TOKEN_PARTS: [keyof Tokens, string, string][] = [
	["cacheRead", "Cache read", "bg-ink/20"],
	["cacheWrite", "Cache write", "bg-ink/45"],
	["input", "Input", "bg-ink/70"],
	["output", "Output", "bg-ink"],
];

/** The tokens tile's breakdown: the cached share in words, and every kind of token on hover. */
function TokenDetail({ tokens }: { tokens: Tokens }) {
	if (!totalTokens(tokens)) return null;
	const share = cachedShare(tokens);
	return (
		<>
			{share !== undefined ? `${Math.round(share * 100)}% cached` : `${formatCount(tokens.output)} out`}
			<span
				role="tooltip"
				className="pointer-events-none absolute top-full left-2 z-30 mt-1 hidden w-[210px] rounded-sm border border-ink bg-page px-3 py-2 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.14)] group-hover:block"
				data-token-legend=""
			>
				{TOKEN_PARTS.map(([key, label, color]) => (
					<span key={key} className="flex items-center gap-2 py-px">
						<span className={cx("size-2", color)} />
						<span className="text-muted">{label}</span>
						<span className="mono tnum ml-auto text-[11.5px]">{tokens[key].toLocaleString("en-US")}</span>
					</span>
				))}
			</span>
		</>
	);
}

/** The tool calls tile's breakdown: the three largest kinds, each as its bullet and count; all of them on hover. */
function FamilyCounts({ counts }: { counts: Map<Family, number> }) {
	const shown = FAMILIES.filter((f) => counts.get(f));
	if (!shown.length) return null;
	const top = [...shown].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)).slice(0, 3);
	return (
		<span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1" title={shown.map((f) => `${FAMILY_LABELS[f]}: ${counts.get(f)}`).join("\n")}>
			{top.map((family) => (
				<span key={family} className="flex shrink-0 items-center gap-1">
					<KindBullet family={family} size={13} />
					{formatCount(counts.get(family) ?? 0)}
				</span>
			))}
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
						className="inline-flex h-[20px] max-w-[104px] min-w-0 items-center gap-1 rounded-sm pr-1 text-[12px] font-medium text-ink hover:bg-hover"
						title={`${type} · ${description}`}
					>
						{child.link?.kind !== "herder-step" && <KindBullet family="agent" size={14} />}
						<span className="min-w-0 truncate">{type}</span>
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
				<span className="absolute top-full right-0 z-30 mt-1 flex max-h-[320px] w-[300px] flex-col overflow-y-auto rounded-sm border border-ink bg-page p-1 shadow-[0_8px_24px_rgba(0,0,0,0.14)]">
					{items.map((child) => {
						const { type, description } = childLabel(child);
						return (
							<Link
								key={child.id}
								to={`/s/${encodeURIComponent(child.id)}`}
								className="flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-[12.5px] hover:bg-hover"
								title={child.title}
							>
								{child.link?.kind !== "herder-step" && <KindBullet family="agent" size={14} />}
								<span className="shrink-0 font-medium">{type}</span>
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
export function KpiStrip({ session, trace, onOpenTree }: { session: SessionDetail; trace?: SessionTrace; onOpenTree?: () => void }) {
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
	const latest = contexts.length ? contexts[contexts.length - 1] : 0;
	const compactions = records.filter((record): record is TraceCompactionRecord => record.kind === "compaction");
	const turns = trace?.turns ?? [];
	const longest = largest(turns.map((turn) => turn.durationMs));
	const total = totalTokens(session.tokens);
	const children = session.children;
	return (
		<div
			className="mt-4 -mx-6 grid grid-cols-2 divide-line overflow-visible border-y border-line sm:grid-cols-4 sm:divide-x xl:grid-cols-7"
			data-kpi-strip=""
		>
			<Tile kpi="turns" label="Turns" value={trace ? formatCount(turns.length) : "—"} detail={turns.length > 1 && longest ? `longest ${formatSpan(longest)}` : undefined} />
			<Tile kpi="llm" label="Model calls" value={trace ? formatCount(llm.length) : "—"} sub={average !== undefined ? `avg ${formatSpan(average)}` : undefined} />
			<Tile
				kpi="tools"
				label="Tool calls"
				value={trace ? formatCount(tools.length) : "—"}
				sub={errors > 0 ? <span className="text-red" data-kpi-errors="">{plural(errors, "error")}</span> : undefined}
				detail={<FamilyCounts counts={families} />}
			/>
			<Tile kpi="tokens" label="Tokens" value={formatCount(total)} detail={<TokenDetail tokens={session.tokens} />} />
			<Tile kpi="cost" label="Cost" value={formatCost(session.cost)} sub={turns.length > 1 && session.cost > 0 ? `${formatCost(session.cost / turns.length)} / turn` : undefined} />
			<Tile
				kpi="subagents"
				label="Subagents"
				value={
					children.length > 0 && onOpenTree ? (
						<button
							type="button"
							onClick={onOpenTree}
							className="-mx-1 rounded-sm px-1 underline decoration-ink/30 underline-offset-4 hover:bg-hover hover:decoration-ink"
							title="Show the agent tree"
							data-open-agent-tree=""
						>
							{formatCount(children.length)}
						</button>
					) : (
						formatCount(children.length)
					)
				}
				visual={children.length > 0 ? <SubagentLinks items={children} /> : undefined}
			/>
			<Tile
				kpi="context"
				label="Peak context"
				value={peak ? formatCount(peak) : "—"}
				visual={peak ? <ContextBar latest={latest} peak={peak} compactions={compactions} /> : undefined}
				detail={
					(latest > 0 && latest < peak) || compactions.length > 0 ? (
						<>
							{latest > 0 && latest < peak && <span>now {formatCount(latest)}</span>}
							{compactions.length > 0 && (
								<span className="flex items-center gap-1">
									<KindBullet family="compaction" size={13} />
									{plural(compactions.length, "compaction")}
								</span>
							)}
						</>
					) : undefined
				}
				title="The most tokens one model call read (input, cache read, and cache write), and what the latest call read; the bar runs from 0 to that peak, and each compaction is a tick where the context stood when it was compacted"
			/>
		</div>
	);
}

/** The view choice; "Agents" is offered only for a session with a parent or children. */
export function ViewSwitch({ view, onChange, agents = false }: { view: SessionViewMode; onChange: (view: SessionViewMode) => void; agents?: boolean }) {
	const options: [SessionViewMode, string][] = [
		["trajectory", "Trajectory"],
		["transcript", "Transcript"],
		...(agents ? [["agents", "Agents"] as [SessionViewMode, string]] : []),
	];
	return (
		<div className="flex h-8 items-stretch overflow-hidden rounded-sm border border-ink" role="radiogroup" aria-label="View" data-view-switch={view}>
			{options.map(([value, label]) => (
				<button
					key={value}
					type="button"
					role="radio"
					aria-checked={view === value}
					onClick={() => onChange(value)}
					className={cx(
						// The group clips its corners, so the focus ring sits inside each segment, in the segment's own text colour.
						"px-3 text-[13px] font-medium transition-colors duration-150 not-first:border-l not-first:border-ink focus-visible:outline-current focus-visible:outline-offset-[-4px]",
						view === value ? "bg-ink text-page" : "text-ink hover:bg-hover",
					)}
					data-view={value}
				>
					{label}
				</button>
			))}
		</div>
	);
}
