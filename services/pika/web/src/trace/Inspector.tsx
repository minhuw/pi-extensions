import { forwardRef, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { PikaLink as Link } from "../components/PikaLink";
import { CodeBlock, OutputBlock } from "../components/code";
import { Icon } from "../components/icons";
import { JsonTree } from "../components/JsonTree";
import { Markdown } from "../components/Markdown";
import { modelTextClass } from "../components/ModelName";
import { ReportList, TicketBadge } from "../components/Ticket";
import { Callout, cx, ErrorState, SkeletonLines, Toggle } from "../components/ui";
import { traceTicket, turnReports } from "../lib/tickets";
import { ContextView } from "../context/ContextDrawer";
import { useApi } from "../lib/api";
import { formatCount, formatDateTime, plural } from "../lib/format";
import { bareModelOf } from "../lib/model";
import type { AssistantMessage, ContentBlock, Entry, SessionTrace, ToolResultMessage, TraceChild, TraceRecord, TraceTurn } from "../lib/types";
import { SessionSlotsContext, SessionViewContext, useSessionView } from "../session/context";
import { contentText } from "../session/timeline";
import { findToolRenderer } from "../session/tools/registry";
import { ResultImages, ToolErrorCallout } from "../session/tools/shared";
import { useEntry } from "./data";
import { formatClockTime, formatElapsed, formatFineCost, formatInstant, formatSpan, spanBetween } from "./format";
import {
	cacheHit,
	FAMILY_LABELS,
	firstStringArg,
	familyColor,
	familyTint,
	recordDuration,
	recordFamily,
	recordGlyph,
	recordIsError,
	recordName,
	recordSpan,
	recordSummary,
	toolFamily,
	toolGlyph,
	toolName,
	turnStart,
	type Family,
} from "./kinds";
import { useLoadedEntry } from "./data";
import { Ladder } from "./Ladder";
import { callIn, Chip, CostDot, DiffStat, diffStatOf, Gauge, KindBullet, PathChip, RunningDot, Tag } from "./parts";

export type InspectorTab = "rendered" | "input" | "output" | "context" | "raw";

export type InspectorTarget =
	| { kind: "record"; record: TraceRecord; sessionId: string; children: TraceChild[]; turn?: TraceTurn }
	| { kind: "child"; child: TraceChild }
	| { kind: "turn"; turn: TraceTurn; records: TraceRecord[] };

const TAB_LABELS: Record<InspectorTab, string> = { rendered: "Rendered", input: "Input", output: "Output", context: "Context", raw: "Raw" };

export function tabsFor(target: InspectorTarget | undefined): InspectorTab[] {
	if (target?.kind !== "record") return [];
	if (target.record.kind === "llm") return ["rendered", "input", "output", "context", "raw"];
	if (target.record.kind === "tool") return ["rendered", "input", "output", "raw"];
	return ["rendered", "raw"];
}

/** The facts under the inspector's title, as a row of tags. */
function Tags({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-1.5" data-inspector-tags="">
			{children}
		</div>
	);
}

/** The line colour the inspector is drawn in: the inspected record's kind, or red when it failed. */
function accentOf(target: InspectorTarget): Family | "error" {
	if (target.kind === "record") return recordIsError(target.record) ? "error" : recordFamily(target.record);
	return target.kind === "child" ? "agent" : "user";
}

/** A tint that a capsule's hover reads from its `--tint`; Tailwind cannot name a colour that changes per row. */
function tinted(family: Family | "error"): CSSProperties {
	return { borderColor: familyColor(family), "--tint": familyTint(family, 14) } as CSSProperties;
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
	return (
		<section className="mt-5 first:mt-0">
			<h3 className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted">
				{title}
				{right && <span className="ml-auto font-normal">{right}</span>}
			</h3>
			{children}
		</section>
	);
}

/** Shades of the model-call line: lightest for tokens read from cache, full for the output. */
const USAGE: { label: string; key: "cacheRead" | "cacheWrite" | "input" | "output"; shade: number }[] = [
	{ label: "Cache read", key: "cacheRead", shade: 30 },
	{ label: "Cache write", key: "cacheWrite", shade: 52 },
	{ label: "Input", key: "input", shade: 76 },
	{ label: "Output", key: "output", shade: 100 },
];

function UsageTable({ record }: { record: Extract<TraceRecord, { kind: "llm" }> }) {
	const total = record.input + record.cacheRead + record.cacheWrite + record.output;
	return (
		<div data-usage="">
			<div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-hover" aria-hidden="true">
				{USAGE.map(({ label, key, shade }) =>
					record[key] > 0 ? <span key={label} style={{ flexGrow: record[key], flexBasis: 0, background: familyTint("llm", shade) }} /> : null,
				)}
			</div>
			<ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Tokens and cost">
				{USAGE.map(({ label, key, shade }) => (
					<li key={label}>
						<Tag lead={<span className="size-2.5 rounded-full" style={{ background: familyTint("llm", shade) }} />} data-usage-part={key}>
							{label}
							<span className="font-semibold text-ink">{record[key].toLocaleString("en-US")}</span>
							<span className="text-muted">{total ? `${Math.round((record[key] / total) * 100)}%` : ""}</span>
						</Tag>
					</li>
				))}
				<li>
					<Tag lead={<CostDot cost={record.cost} scale="record" />}>
						Cost
						<span className="font-semibold text-ink">{formatFineCost(record.cost) || "$0"}</span>
					</Tag>
				</li>
			</ul>
		</div>
	);
}

function blocksOf(entry: Entry | null | undefined): ContentBlock[] {
	const message = entry?.raw.message as AssistantMessage | undefined;
	return Array.isArray(message?.content) ? message.content : [];
}

function LlmRendered({ record, entry, onSelectCall }: { record: Extract<TraceRecord, { kind: "llm" }>; entry: Entry | null | undefined; onSelectCall?: (callId: string) => void }) {
	const blocks = blocksOf(entry);
	const message = entry?.raw.message as AssistantMessage | undefined;
	const calls = blocks.filter((block) => block.type === "toolCall");
	return (
		<div className="space-y-4">
			{record.error && (
				<Callout tone="red" title={record.stopReason === "aborted" ? "Response aborted" : "Model error"}>
					<div className="text-[13px] [overflow-wrap:anywhere]">{record.error}</div>
				</Callout>
			)}
			{blocks.map((block, index) =>
				block.type === "thinking" ? (
					<Toggle key={index} className="text-[13px] text-muted" label={<span className="italic">{block.redacted ? "Thinking (redacted)" : "Thinking"}</span>}>
						{block.thinking ? <Markdown text={block.thinking} className="text-[13px] text-muted" /> : <span className="italic">No visible text</span>}
					</Toggle>
				) : block.type === "text" && block.text.trim() ? (
					<Markdown key={index} text={block.text} className="text-[14px]" />
				) : null,
			)}
			{calls.length > 0 && (
				<Section title={plural(calls.length, "tool call")}>
					{/* The calls branch off the model call: stations on a line in its colour, through their bullets. */}
					<ul className="relative space-y-1.5" data-inspector-calls="">
						{calls.length > 1 && (
							<span aria-hidden="true" className="absolute top-3.5 bottom-3.5 left-[12.5px] w-[2px]" style={{ background: familyColor("llm") }} />
						)}
						{calls.map((call) =>
							call.type === "toolCall" ? (
								<li key={call.id} className="relative">
									<button
										type="button"
										onClick={() => onSelectCall?.(call.id)}
										className="group flex h-7 w-full min-w-0 items-center gap-2 rounded-full border-[1.5px] bg-page pr-3 pl-[3px] text-left text-[12.5px] hover:bg-(--tint)"
										style={tinted(toolFamily(call.name))}
										title="Inspect this call"
									>
										<KindBullet family={toolFamily(call.name)} glyph={toolGlyph(call.name)} size={18} />
										<span className="shrink-0 font-medium">{call.name}</span>
										<span className="mono min-w-0 truncate text-[12px] text-muted">{findToolRenderer(call.name).summary?.(call) ?? firstStringArg(call.arguments) ?? ""}</span>
										<Icon name="external" size={12} className="ml-auto shrink-0 text-muted group-hover:text-ink" />
									</button>
								</li>
							) : null,
						)}
					</ul>
				</Section>
			)}
			<Section title="Usage" right={message?.thinkingLevel && message.thinkingLevel !== "off" ? <span className="text-[12px]">thinking {message.thinkingLevel}</span> : undefined}>
				<UsageTable record={record} />
			</Section>
		</div>
	);
}

function ToolRendered({
	call,
	result,
	resultEntry,
	spawned,
}: {
	call: ReturnType<typeof callIn>;
	result?: ToolResultMessage;
	resultEntry?: Entry;
	spawned: TraceChild[];
}) {
	const view = useSessionView();
	// Nested sessions open in the ledger here, not inline in the inspector.
	const quiet = useMemo(() => ({ ...view, childGroups: new Map() }), [view]);
	if (!call) return <div className="text-[13px] text-muted italic">The call’s arguments are not in this entry.</div>;
	const renderer = findToolRenderer(call.name);
	const Component = renderer.Component;
	return (
		<div data-tool={renderer.id} data-tool-name={call.name}>
			<SessionSlotsContext.Provider value={{}}>
				<SessionViewContext.Provider value={quiet}>
					<Component call={call} result={result} resultEntry={resultEntry} />
				</SessionViewContext.Provider>
			</SessionSlotsContext.Provider>
			{result?.isError && !renderer.handlesErrors && (
				<div className="mt-2">
					<ToolErrorCallout result={result} />
				</div>
			)}
			{spawned.length > 0 && (
				<Section title={plural(spawned.length, "subagent session")}>
					<ChildList items={spawned} />
				</Section>
			)}
		</div>
	);
}

function ChildList({ items }: { items: TraceChild[] }) {
	return (
		<ul className="space-y-1.5" data-inspector-children="">
			{items.map((child) => (
				<li key={child.sessionId}>
					<Link
						to={`/s/${encodeURIComponent(child.sessionId)}`}
						className="group flex h-8 min-w-0 items-center gap-2 rounded-full border-[1.5px] bg-page pr-3 pl-1 text-[13px] hover:bg-(--tint)"
						style={tinted("agent")}
					>
						<KindBullet family="agent" size={20} />
						<span className="shrink-0 font-medium">{child.agentType ?? "subagent"}</span>
						{child.kind === "herder-step" && <span className="shrink-0 text-[12px] text-muted">Herder step</span>}
						<span className="min-w-0 truncate text-muted">{child.description ?? child.title}</span>
						<span className="tnum ml-auto shrink-0 text-[12px] text-muted">{formatSpan(spanBetween(child.startedAt, child.lastAt))}</span>
						<Icon name="external" size={12} className="shrink-0 text-muted group-hover:text-ink" />
					</Link>
				</li>
			))}
		</ul>
	);
}

function looksJson(text: string): unknown {
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed) || trimmed.length > 500_000) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function OutputTab({ result }: { result: ToolResultMessage | undefined }) {
	if (!result) return <div className="text-[13px] text-muted italic">No result recorded.</div>;
	const text = contentText(result.content);
	const parsed = looksJson(text);
	return (
		<div className="space-y-3">
			{result.isError && <Chip tone="red">error result</Chip>}
			{parsed !== undefined ? <JsonTree value={parsed} /> : <OutputBlock text={text} />}
			<ResultImages result={result} />
			{result.details !== undefined && result.details !== null && (
				<Section title="Details">
					<JsonTree value={result.details} />
				</Section>
			)}
		</div>
	);
}

function RawTab({ sessionId, entries }: { sessionId: string; entries: (Entry | null | undefined)[] }) {
	const api = useApi();
	return (
		<div className="space-y-4">
			{entries.map((entry, i) =>
				entry ? (
					<Section
						key={entry.seq}
						title={i === 0 ? `Entry #${entry.seq}` : `Result entry #${entry.seq}`}
						right={
							<a className="text-[12px] text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink" href={api.rawEntryUrl(sessionId, entry.seq)} target="_blank" rel="noreferrer">
								{entry.truncated ? "View the verbatim entry" : "Open raw"}
							</a>
						}
					>
						<CodeBlock code={JSON.stringify(entry.raw, null, 2)} language="json" maxHeight="none" />
					</Section>
				) : null,
			)}
		</div>
	);
}

/** A failed shell command's exit status, once its result entry is loaded. */
function useExitLabel(target: InspectorTarget): string | undefined {
	const record = target.kind === "record" ? target.record : undefined;
	const shell = record?.kind === "tool" && record.isError && toolFamily(toolName(record)) === "shell";
	const result = useLoadedEntry(target.kind === "record" ? target.sessionId : "", shell && record?.kind === "tool" ? record.resultSeq : undefined);
	if (!shell) return undefined;
	const code = /Command exited with code (-?\d+)/.exec(JSON.stringify(result?.raw.message ?? ""))?.[1];
	return code !== undefined ? `exit ${code}` : "failed";
}

function Header({ target, live, stat, onClose }: { target: InspectorTarget; live: boolean; stat?: ReturnType<typeof diffStatOf>; onClose?: () => void }) {
	const exitLabel = useExitLabel(target);
	let bullet: ReactNode;
	let name: ReactNode;
	let summary: ReactNode = null;
	let tags: ReactNode = null;
	let status: ReactNode = null;
	if (target.kind === "record") {
		const { record } = target;
		const family = recordFamily(record);
		const error = recordIsError(record);
		bullet = <KindBullet family={family} glyph={recordGlyph(record)} model={record.kind === "llm" ? record.model : undefined} error={error} size={20} />;
		const text = recordSummary(record);
		if (record.kind === "tool" && text) {
			// A tool's title is what it worked on: the path, command, pattern, or URL.
			name = /^(read|write|edit|ls)$/i.test(toolName(record)) ? (
				<PathChip path={text} className="text-[13px]" />
			) : (
				<span className={cx("truncate font-medium", family === "agent" ? "text-[14px]" : "mono text-[13px]")} title={text}>
					{text}
				</span>
			);
		} else {
			// A model call is titled by its model, in its maker's colour.
			name = record.kind === "llm" && record.model ? <span className={cx("truncate", modelTextClass(record.model))}>{record.model}</span> : recordName(record);
			summary = text ? (
				<div className={cx("line-clamp-3 text-[13px] [overflow-wrap:anywhere]", record.kind === "llm" && record.error ? "text-red" : "text-ink/80")}>{text}</div>
			) : null;
		}
		const { start } = recordSpan(record);
		const running = live && record.kind === "tool" && record.resultSeq === undefined && record.end === undefined;
		const hit = cacheHit(record);
		const duration = recordDuration(record);
		status = running ? (
			<span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-muted">
				<RunningDot /> running
			</span>
		) : (
			duration !== undefined && (
				<span className="tnum shrink-0 text-[13px] font-medium text-muted" title="Duration">
					{formatSpan(duration)}
				</span>
			)
		);
		tags = (
			<Tags>
				{/* The kind, in its line colour; a tool's name beside it. */}
				<Tag tone={family} data-kind-tag={family}>
					{FAMILY_LABELS[family]}
					{record.kind === "tool" && <span className="mono min-w-0 truncate text-[11.5px] font-normal">{recordName(record)}</span>}
				</Tag>
				{error && <Tag tone="error">{exitLabel ?? "error"}</Tag>}
				<Tag lead={<Icon name="clock" size={12} />} title={formatInstant(start)}>
					{formatClockTime(start)}
					{start !== undefined && target.turn?.at !== undefined && <span className="mono text-[11px] text-muted">{formatElapsed(start - target.turn.at)}</span>}
				</Tag>
				{record.kind === "llm" && (
					<>
						<Tag lead={<Icon name="tokens" size={12} />} title="Prompt → output tokens">
							{formatCount(record.input + record.cacheRead + record.cacheWrite)} → {formatCount(record.output)}
						</Tag>
						{hit !== undefined && (
							<Tag lead={<Gauge share={hit} family="llm" />} title="Share of the prompt read from cache">
								{Math.round(hit * 100)}% cached
							</Tag>
						)}
						{record.cost > 0 && (
							<Tag lead={<CostDot cost={record.cost} scale="record" />} title="Cost">
								{formatFineCost(record.cost)}
							</Tag>
						)}
						{record.stopReason && <Tag title="Stop reason">{record.stopReason}</Tag>}
					</>
				)}
				{stat && (
					<Tag>
						<DiffStat value={stat} />
					</Tag>
				)}
				{record.kind === "compaction" && record.tokensBefore !== undefined && (
					<Tag lead={<Icon name="compress" size={12} />}>{formatCount(record.tokensBefore)} tokens before</Tag>
				)}
				<span className="mono px-1 text-[11px] text-muted" title="Entry">
					#{record.seq}
				</span>
			</Tags>
		);
	} else if (target.kind === "child") {
		const { child } = target;
		const ticket = traceTicket(child);
		bullet = <KindBullet family="agent" size={20} />;
		name = ticket ? (
			<>
				<TicketBadge ticket={ticket} className="mr-1.5" />
				{child.agentType ?? "ticket"}
			</>
		) : (
			(child.agentType ?? "subagent")
		);
		summary = <div className="text-[13px] text-ink/80">{ticket?.title ?? child.description ?? child.title}</div>;
		status = (
			<span className="tnum shrink-0 text-[13px] font-medium text-muted" title="Duration">
				{formatSpan(spanBetween(child.startedAt, child.lastAt))}
			</span>
		);
		tags = (
			<Tags>
				<Tag tone="agent" data-kind-tag="agent">
					{child.kind === "herder-step" ? "Herder step" : FAMILY_LABELS.agent}
				</Tag>
				<Tag lead={<Icon name="clock" size={12} />} title={formatInstant(child.startedAt)}>
					{formatClockTime(child.startedAt)}
				</Tag>
				<Tag lead={<Icon name="tokens" size={12} />} title="Tokens">
					{formatCount(child.tokens.input + child.tokens.output + child.tokens.cacheRead + child.tokens.cacheWrite)}
				</Tag>
				{child.cost > 0 && (
					<Tag lead={<CostDot cost={child.cost} scale="session" />} title="Cost">
						{formatFineCost(child.cost)}
					</Tag>
				)}
				<Tag>{plural(child.entryCount, "entry", "entries")}</Tag>
			</Tags>
		);
	} else {
		const { turn } = target;
		const start = turnStart(turn);
		const reports = turnReports(turn);
		bullet = <KindBullet family="user" glyph={start.glyph} size={20} />;
		name = start.label;
		if (reports.length) summary = <ReportList reports={reports} />;
		status = (
			<span className="tnum shrink-0 text-[13px] font-medium text-muted" title="Duration">
				{formatSpan(turn.durationMs)}
			</span>
		);
		tags = (
			<Tags>
				<Tag tone="user" data-kind-tag="user">
					Turn {turn.index + 1}
				</Tag>
				<Tag lead={<Icon name="clock" size={12} />}>{formatDateTime(turn.at)}</Tag>
				<Tag>
					{plural(turn.modelCalls, "model call")} · {plural(turn.toolCalls, "tool call")}
				</Tag>
				{turn.cost > 0 && (
					<Tag lead={<CostDot cost={turn.cost} scale="session" />} title="Cost">
						{formatFineCost(turn.cost)}
					</Tag>
				)}
				{turn.toolErrors > 0 && <Tag tone="error">{plural(turn.toolErrors, "error")}</Tag>}
			</Tags>
		);
	}
	return (
		<div className="relative shrink-0 px-5 pt-3.5 pb-1">
			<div className="flex min-w-0 items-center gap-2">
				{bullet}
				<h2 className="flex min-w-0 items-center truncate text-[15px] font-semibold">{name}</h2>
				{status}
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						className="ml-auto inline-flex h-7 shrink-0 items-center rounded-sm px-2 text-[13px] font-medium text-muted hover:bg-hover hover:text-ink min-[1200px]:hidden"
						aria-label="Close the inspector"
					>
						Close
					</button>
				)}
			</div>
			{summary && <div className="mt-1.5 min-w-0">{summary}</div>}
			<div className="mt-2.5">{tags}</div>
		</div>
	);
}

/** Shown only in the narrow slide-over, and only for a moment; on wide screens the pane is hidden while empty. */
function EmptyInspector({ trace }: { trace?: SessionTrace }) {
	return (
		<p className="px-5 py-6 text-[13px] text-muted" data-inspector-empty="">
			{trace && trace.records.length === 0 ? "This session has no model calls yet." : "Select a record to inspect it."}
		</p>
	);
}

export interface InspectorProps {
	target?: InspectorTarget;
	trace?: SessionTrace;
	tab: InspectorTab;
	onTab: (tab: InspectorTab) => void;
	/** During replay the inspector previews the record without loading its entries. */
	preview: boolean;
	live: boolean;
	onClose?: () => void;
	onSelectCall?: (callId: string) => void;
}

export const Inspector = forwardRef<HTMLDivElement, InspectorProps>(function Inspector({ target, trace, tab, onTab, preview, live, onClose, onSelectCall }, ref) {
	const [pane, setPane] = useState<HTMLDivElement | null>(null);
	const api = useApi();
	const tabs = tabsFor(target).filter((tab) => !api.publicView || tab !== "context");
	const current: InspectorTab = tabs.includes(tab) ? tab : (tabs[0] ?? "rendered");
	const record = target?.kind === "record" ? target.record : undefined;
	const sessionId = target?.kind === "record" ? target.sessionId : "";
	const load = !preview && record !== undefined;
	const entry = useEntry(sessionId, record?.seq, load && record !== undefined);
	const resultSeq = record?.kind === "tool" ? record.resultSeq : undefined;
	const resultEntry = useEntry(sessionId, resultSeq, load && resultSeq !== undefined);
	const call = record?.kind === "tool" ? callIn(entry.data, record.callId) : undefined;
	const result = resultEntry.data?.raw.message as ToolResultMessage | undefined;
	const stat = call ? diffStatOf(call) : undefined;
	const accent = target ? accentOf(target) : undefined;

	let body: ReactNode;
	if (!target) body = <EmptyInspector trace={trace} />;
	else if (target.kind === "child") {
		body = (
			<div className="space-y-4 px-5 py-4">
				<ChildList items={[target.child]} />
			</div>
		);
	} else if (target.kind === "turn") {
		body = (
			<div className="px-5 py-4">
				{/* The trace cuts prompts to 200 characters. */}
				<Markdown text={target.turn.userText ? `${target.turn.userText}${target.turn.userText.length >= 200 ? "…" : ""}` : "(empty prompt)"} className="text-[14px]" />
			</div>
		);
	} else if (preview) {
		body = (
			<div className="px-5 py-4 text-[13px]" data-inspector-preview="">
				<div className="mb-2 inline-flex items-center gap-1.5 text-[12px] text-muted">
					<RunningDot /> Replaying
				</div>
				{record?.kind === "llm" && record.text ? (
					<p className="text-[14px] leading-relaxed">{record.text}</p>
				) : record ? (
					<p className={cx("text-ink/80 [overflow-wrap:anywhere]", recordFamily(record) === "agent" ? "text-[14px]" : "mono text-[12.5px]")}>
						{recordSummary(record) || recordName(record)}
					</p>
				) : null}
			</div>
		);
	} else if (entry.isPending && current !== "context") {
		body = (
			<div className="px-5 py-4" aria-busy="true">
				<SkeletonLines lines={5} />
			</div>
		);
	} else if (entry.isError) {
		body = (
			<div className="px-5">
				<ErrorState error={entry.error} onRetry={() => void entry.refetch()} />
			</div>
		);
	} else if (record) {
		let content: ReactNode = null;
		if (current === "raw") content = <RawTab sessionId={sessionId} entries={record.kind === "tool" ? [entry.data, resultEntry.data] : [entry.data]} />;
		else if (current === "context" && record.kind === "llm") {
			content = record.requestId ? (
				<div data-context-panel={record.requestId}>
					<ContextView target={{ requestId: record.requestId, sessionId, seq: record.seq }} scrollPane={pane} />
				</div>
			) : (
				<div className="text-[13px] text-muted">
					No request was captured for this call. pika records it when the device uploads the provider payload or pi’s context.
				</div>
			);
		} else if (record.kind === "llm") {
			if (current === "rendered") content = <LlmRendered record={record} entry={entry.data} onSelectCall={onSelectCall} />;
			else if (current === "input") {
				const message = entry.data?.raw.message as AssistantMessage | undefined;
				content = (
					<JsonTree value={{ model: bareModelOf(message?.model), api: message?.api, thinkingLevel: message?.thinkingLevel, usage: message?.usage }} />
				);
			} else content = <JsonTree value={blocksOf(entry.data)} />;
		} else if (record.kind === "tool") {
			if (current === "rendered") {
				content = (
					<ToolRendered call={call} result={result} resultEntry={resultEntry.data ?? undefined} spawned={target.children} />
				);
			} else if (current === "input") content = call ? <JsonTree value={call.arguments} /> : null;
			else content = resultEntry.isPending && resultSeq !== undefined ? <SkeletonLines lines={4} /> : <OutputTab result={result} />;
		} else {
			const raw = entry.data?.raw;
			content = (
				<div className="space-y-3">
					{record.kind === "compaction" && record.tokensBefore !== undefined && (
						<div className="text-[13px] text-muted">{formatCount(record.tokensBefore)} tokens summarized</div>
					)}
					<Markdown text={typeof raw?.summary === "string" ? raw.summary : ""} className="text-[14px]" />
				</div>
			);
		}
		body = <div className="px-5 py-4">{content}</div>;
	}

	return (
		<div ref={ref} tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none" data-inspector="" data-tab={target?.kind === "record" ? current : undefined}>
			{/* The inspected record's line colour across the top, as a route sign carries its line's. */}
			{accent && <div aria-hidden="true" className="h-[3px] shrink-0" style={{ background: familyColor(accent) }} data-inspector-accent={accent} />}
			{target && <Header target={target} live={live} stat={stat} onClose={onClose} />}
			{record?.kind === "llm" && <Ladder record={record} />}
			{target && (tabs.length === 0 || preview) && <div aria-hidden="true" className="mt-2 shrink-0 border-b border-line" />}
			{tabs.length > 0 && !preview && (
				<div role="tablist" aria-label="Record details" className="mt-2 flex shrink-0 items-center gap-5 border-b border-line px-5">
					{tabs.map((name) => (
						<button
							key={name}
							type="button"
							role="tab"
							aria-selected={name === current}
							onClick={() => onTab(name)}
							className={cx(
								"relative h-9 text-[13px] font-medium transition-colors duration-150",
								name === current ? "text-ink" : "text-muted hover:text-ink",
							)}
							data-tab-button={name}
						>
							{TAB_LABELS[name]}
							{name === current && (
								<span aria-hidden="true" className="absolute inset-x-0 bottom-[-1px] h-[3px] rounded-t-[1px]" style={{ background: accent ? familyColor(accent) : undefined }} />
							)}
						</button>
					))}
				</div>
			)}
			<div ref={setPane} role={tabs.length ? "tabpanel" : undefined} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-scroll-pane="">
				{body}
			</div>
		</div>
	);
});
