import { forwardRef, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CodeBlock, OutputBlock } from "../components/code";
import { Icon } from "../components/icons";
import { JsonTree } from "../components/JsonTree";
import { Markdown } from "../components/Markdown";
import { Callout, cx, ErrorState, SkeletonLines, Toggle } from "../components/ui";
import { ContextView } from "../context/ContextDrawer";
import { useApi } from "../lib/api";
import { formatCount, formatDateTime, plural } from "../lib/format";
import type { AssistantMessage, ContentBlock, Entry, SessionTrace, ToolResultMessage, TraceChild, TraceRecord, TraceTurn } from "../lib/types";
import { SessionSlotsContext, SessionViewContext, useSessionView } from "../session/context";
import { contentText } from "../session/timeline";
import { findToolRenderer } from "../session/tools/registry";
import { ResultImages, ToolErrorCallout } from "../session/tools/shared";
import { useEntry } from "./data";
import { formatClockTime, formatElapsed, formatFineCost, formatInstant, formatSpan, spanBetween } from "./format";
import {
	cacheHit,
	FAMILIES,
	FAMILY_CLASSES,
	FAMILY_LABELS,
	recordDuration,
	recordFamily,
	recordIsError,
	recordName,
	recordSpan,
	recordSummary,
	toolFamily,
	toolName,
	turnStart,
} from "./kinds";
import { callIn, Chip, DiffStat, diffStatOf, KindBadge, PathChip, Ring, RunningDot } from "./parts";

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

function Meta({ children }: { children: ReactNode }) {
	return <div className="tnum flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">{children}</div>;
}

function MetaItem({ icon, children, title }: { icon?: Parameters<typeof Icon>[0]["name"]; children: ReactNode; title?: string }) {
	return (
		<span className="inline-flex items-center gap-1" title={title}>
			{icon && <Icon name={icon} size={12} />}
			{children}
		</span>
	);
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
	return (
		<section className="mt-5 first:mt-0">
			<h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
				{title}
				{right && <span className="ml-auto font-normal tracking-normal normal-case">{right}</span>}
			</h3>
			{children}
		</section>
	);
}

function UsageTable({ record }: { record: Extract<TraceRecord, { kind: "llm" }> }) {
	const prompt = record.input + record.cacheRead + record.cacheWrite;
	const rows: [string, number, string][] = [
		["Cache read", record.cacheRead, "bg-k-read"],
		["Cache write", record.cacheWrite, "bg-k-compaction"],
		["Input", record.input, "bg-k-user"],
		["Output", record.output, "bg-k-llm"],
	];
	const total = prompt + record.output;
	return (
		<div data-usage="">
			<div className="flex h-2 overflow-hidden rounded-full bg-hover" aria-hidden="true">
				{rows.map(([label, value, color]) => (value > 0 ? <span key={label} className={cx(color, "opacity-80")} style={{ width: `${(value / Math.max(1, total)) * 100}%` }} /> : null))}
			</div>
			<dl className="tnum mt-2 grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 text-[12.5px]">
				{rows.map(([label, value, color]) => (
					<div key={label} className="contents">
						<dt className="flex items-center gap-1.5 text-muted">
							<span className={cx("size-2 rounded-[2px] opacity-80", color)} />
							{label}
						</dt>
						<dd className="mono text-right text-[12px]">{value.toLocaleString("en-US")}</dd>
						<dd className="mono text-right text-[12px] text-muted">{total ? `${Math.round((value / total) * 100)}%` : ""}</dd>
					</div>
				))}
				<div className="contents font-medium">
					<dt className="text-muted">Cost</dt>
					<dd className="mono text-right text-[12px]">{formatFineCost(record.cost) || "$0"}</dd>
					<dd />
				</div>
			</dl>
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
					<div className="space-y-1">
						{calls.map((call) =>
							call.type === "toolCall" ? (
								<button
									key={call.id}
									type="button"
									onClick={() => onSelectCall?.(call.id)}
									className="flex w-full min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-left text-[12.5px] hover:bg-hover"
								>
									<span className={cx("size-2 shrink-0 rounded-[2px]", FAMILY_CLASSES[toolFamily(call.name)].dot)} />
									<span className="shrink-0 font-medium">{call.name}</span>
									<span className="mono min-w-0 truncate text-[12px] text-muted">{findToolRenderer(call.name).summary?.(call) ?? ""}</span>
									<Icon name="external" size={12} className="ml-auto shrink-0 text-muted" />
								</button>
							) : null,
						)}
					</div>
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
		<div className="divide-y divide-line rounded-md border border-line" data-inspector-children="">
			{items.map((child) => (
				<Link
					key={child.sessionId}
					to={`/s/${encodeURIComponent(child.sessionId)}`}
					className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[12.5px] hover:bg-hover"
				>
					<KindBadge family="agent" label={child.kind === "herder-step" ? "STEP" : "AGENT"} />
					<span className="shrink-0 font-medium">{child.agentType ?? "subagent"}</span>
					<span className="min-w-0 truncate text-muted">{child.description ?? child.title}</span>
					<span className="mono tnum ml-auto shrink-0 text-[11.5px] text-muted">{formatSpan(spanBetween(child.startedAt, child.lastAt))}</span>
				</Link>
			))}
		</div>
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
							<a className="text-[12px] text-accent hover:underline" href={api.rawEntryUrl(sessionId, entry.seq)} target="_blank" rel="noreferrer">
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

function Header({ target, live, stat, onClose }: { target: InspectorTarget; live: boolean; stat?: ReturnType<typeof diffStatOf>; onClose?: () => void }) {
	let badge: ReactNode;
	let name: ReactNode;
	let summary: ReactNode = null;
	let meta: ReactNode = null;
	let rail = "bg-line";
	if (target.kind === "record") {
		const { record } = target;
		const family = recordFamily(record);
		const error = recordIsError(record);
		rail = error ? "bg-k-error" : FAMILY_CLASSES[family].bar;
		badge = <KindBadge record={record} className={cx(error && "!bg-red-soft !text-red")} />;
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
			name = recordName(record);
			summary = text ? (
				<div className={cx("line-clamp-3 text-[13px] [overflow-wrap:anywhere]", record.kind === "llm" && record.error ? "text-red" : "text-ink/80")}>{text}</div>
			) : null;
		}
		const { start } = recordSpan(record);
		const running = live && record.kind === "tool" && record.resultSeq === undefined && record.end === undefined;
		const hit = cacheHit(record);
		meta = (
			<Meta>
				{record.kind === "tool" && <span className="mono text-[11.5px] text-ink/70">{toolName(record)}</span>}
				<MetaItem icon="clock" title={formatInstant(start)}>
					{formatClockTime(start)}
					{start !== undefined && target.turn?.at !== undefined && <span className="mono text-[11px]">{formatElapsed(start - target.turn.at)}</span>}
				</MetaItem>
				{running ? (
					<MetaItem>
						<RunningDot /> running
					</MetaItem>
				) : (
					recordDuration(record) !== undefined && <MetaItem title="Duration">{formatSpan(recordDuration(record))}</MetaItem>
				)}
				{record.kind === "llm" && (
					<>
						<MetaItem icon="tokens" title="Prompt → output tokens">
							{formatCount(record.input + record.cacheRead + record.cacheWrite)} → {formatCount(record.output)}
						</MetaItem>
						{hit !== undefined && (
							<MetaItem title="Share of the prompt read from cache">
								<Ring value={hit} className="text-k-read" />
								{Math.round(hit * 100)}% cached
							</MetaItem>
						)}
						{record.cost > 0 && <MetaItem icon="cost">{formatFineCost(record.cost)}</MetaItem>}
						{record.stopReason && <MetaItem>{record.stopReason}</MetaItem>}
					</>
				)}
				{record.kind === "tool" && record.isError && <Chip tone="red">error</Chip>}
				{stat && <DiffStat value={stat} />}
				{record.kind === "compaction" && record.tokensBefore !== undefined && <MetaItem icon="compress">{formatCount(record.tokensBefore)} tokens before</MetaItem>}
				<span className="mono text-[11px]">#{record.seq}</span>
			</Meta>
		);
	} else if (target.kind === "child") {
		const { child } = target;
		rail = "bg-k-agent";
		badge = <KindBadge family="agent" label={child.kind === "herder-step" ? "STEP" : "AGENT"} />;
		name = child.agentType ?? "subagent";
		summary = <div className="text-[13px] text-ink/80">{child.description ?? child.title}</div>;
		meta = (
			<Meta>
				<MetaItem icon="clock" title={formatInstant(child.startedAt)}>
					{formatClockTime(child.startedAt)}
				</MetaItem>
				<MetaItem title="Duration">{formatSpan(spanBetween(child.startedAt, child.lastAt))}</MetaItem>
				<MetaItem icon="tokens">{formatCount(child.tokens.input + child.tokens.output + child.tokens.cacheRead + child.tokens.cacheWrite)}</MetaItem>
				{child.cost > 0 && <MetaItem icon="cost">{formatFineCost(child.cost)}</MetaItem>}
				<MetaItem>{plural(child.entryCount, "entry", "entries")}</MetaItem>
			</Meta>
		);
	} else {
		const { turn } = target;
		const start = turnStart(turn);
		rail = "bg-k-user";
		badge = <KindBadge family="user" label={`#${turn.index + 1}`} />;
		name = start.label;
		meta = (
			<Meta>
				<MetaItem icon="clock">{formatDateTime(turn.at)}</MetaItem>
				<MetaItem>{formatSpan(turn.durationMs)}</MetaItem>
				<MetaItem>
					{turn.modelCalls} LLM · {plural(turn.toolCalls, "tool")}
				</MetaItem>
				{turn.cost > 0 && <MetaItem icon="cost">{formatFineCost(turn.cost)}</MetaItem>}
				{turn.toolErrors > 0 && <Chip tone="red">{plural(turn.toolErrors, "error")}</Chip>}
			</Meta>
		);
	}
	return (
		<div className="relative shrink-0 border-b border-line px-4 pt-3 pb-3">
			<span aria-hidden="true" className={cx("absolute top-0 left-0 h-[2px] w-full", rail)} />
			<div className="flex min-w-0 items-center gap-2">
				{badge}
				<h2 className="flex min-w-0 items-center truncate text-[14px] font-semibold">{name}</h2>
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-[12px] text-muted hover:bg-hover min-[1200px]:hidden"
						aria-label="Close the inspector"
					>
						Close
					</button>
				)}
			</div>
			{summary && <div className="mt-1.5 min-w-0">{summary}</div>}
			<div className="mt-2">{meta}</div>
		</div>
	);
}

function EmptyInspector({ trace }: { trace?: SessionTrace }) {
	const keys: [string, string][] = [
		["↑ ↓", "move"],
		["← →", "fold a turn"],
		["[ ]", "previous / next turn"],
		["Enter", "focus here"],
		["/", "filter"],
		["Esc", "clear range, stop replay"],
	];
	return (
		<div className="px-5 py-6 text-[13px]" data-inspector-empty="">
			<div className="font-medium">Select a record</div>
			<p className="mt-1 text-muted">Click a row in the ledger or a bar in the timeline to see its input, output, and what the model saw.</p>
			<dl className="mt-5 grid grid-cols-[72px_1fr] gap-y-1.5 text-[12.5px]">
				{keys.map(([key, what]) => (
					<div key={key} className="contents">
						<dt>
							<kbd className="mono rounded-[3px] border border-line px-1.5 py-px text-[11px] text-muted">{key}</kbd>
						</dt>
						<dd className="text-muted">{what}</dd>
					</div>
				))}
			</dl>
			<div className="mt-6 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Legend</div>
			<div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
				{FAMILIES.map((family) => (
					<span key={family} className="flex items-center gap-2 text-muted">
						<span className={cx("h-2 w-3.5 rounded-[2px] opacity-80", FAMILY_CLASSES[family].bar)} />
						{FAMILY_LABELS[family]}
					</span>
				))}
				<span className="flex items-center gap-2 text-muted">
					<span className="h-2 w-3.5 rounded-[2px] bg-k-error" />
					Error
				</span>
			</div>
			{trace && trace.records.length === 0 && <p className="mt-6 text-muted italic">This session has no model calls yet.</p>}
		</div>
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
	const tabs = tabsFor(target);
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

	let body: ReactNode;
	if (!target) body = <EmptyInspector trace={trace} />;
	else if (target.kind === "child") {
		body = (
			<div className="space-y-4 px-4 py-4">
				<p className="text-[13px] text-muted">Expand the row in the ledger to read this subagent’s records here, or open its session as a page.</p>
				<ChildList items={[target.child]} />
			</div>
		);
	} else if (target.kind === "turn") {
		body = (
			<div className="px-4 py-4">
				<Markdown text={target.turn.userText || "(empty prompt)"} className="text-[14px]" />
				{target.turn.userText.length >= 200 && <p className="mt-2 text-[12px] text-muted italic">The prompt is shortened here; the transcript view shows it in full.</p>}
			</div>
		);
	} else if (preview) {
		body = (
			<div className="px-4 py-4 text-[13px]" data-inspector-preview="">
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
			<div className="px-4 py-4" aria-busy="true">
				<SkeletonLines lines={5} />
			</div>
		);
	} else if (entry.isError) {
		body = (
			<div className="px-4">
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
					<div className="space-y-3">
						<p className="text-[12.5px] text-muted">
							The model read {formatCount(record.input + record.cacheRead + record.cacheWrite)} tokens. The Context tab shows the full request.
						</p>
						<JsonTree value={{ model: message?.model, provider: message?.provider, api: message?.api, thinkingLevel: message?.thinkingLevel, usage: message?.usage }} />
					</div>
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
		body = <div className="px-4 py-4">{content}</div>;
	}

	return (
		<div ref={ref} tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none" data-inspector="" data-tab={target?.kind === "record" ? current : undefined}>
			{target && <Header target={target} live={live} stat={stat} onClose={onClose} />}
			{tabs.length > 0 && !preview && (
				<div role="tablist" aria-label="Record details" className="flex shrink-0 items-center gap-0.5 border-b border-line px-3">
					{tabs.map((name) => (
						<button
							key={name}
							type="button"
							role="tab"
							aria-selected={name === current}
							onClick={() => onTab(name)}
							className={cx(
								"relative h-9 px-2 text-[12.5px] transition-colors duration-150",
								name === current ? "font-medium text-ink" : "text-muted hover:text-ink",
							)}
							data-tab-button={name}
						>
							{TAB_LABELS[name]}
							{name === current && <span aria-hidden="true" className="absolute inset-x-2 bottom-[-1px] h-[2px] rounded-full bg-ink" />}
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
