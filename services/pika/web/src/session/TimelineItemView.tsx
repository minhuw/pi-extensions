import { useEffect, type ReactNode } from "react";
import { CodeBlock } from "../components/code";
import { Icon, type IconName } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Callout, cx, Pill, Toggle } from "../components/ui";
import { useApi } from "../lib/api";
import { formatCount, formatTime } from "../lib/format";
import { useViewState } from "../lib/viewState";
import { formatFineCost, formatSpan } from "../trace/format";
import { FAMILY_CLASSES, firstStringArg, recordBadge, recordIcon, showsToolName, toolFamily } from "../trace/kinds";
import { KindBadge, Ring } from "../trace/parts";
import type { Entry, ToolCall, ToolResultMessage } from "../lib/types";
import { useSessionSlots, useSessionView } from "./context";
import { contentImages, contentText, type TimelineItem } from "./timeline";
import { BashOutput, parseBashOutput } from "./tools/bash";
import { findToolRenderer } from "./tools/registry";
import { ToolErrorCallout } from "./tools/shared";

function toolDuration(result?: ToolResultMessage, resultEntry?: Entry, callEntry?: Entry): number | undefined {
	const explicit = (result as { durationMs?: unknown } | undefined)?.durationMs;
	if (typeof explicit === "number") return explicit;
	const end = result?.timestamp ?? (resultEntry?.timestamp ? Date.parse(resultEntry.timestamp) : undefined);
	const start = callEntry?.timestamp ? Date.parse(callEntry.timestamp) : undefined;
	return end !== undefined && start !== undefined && end >= start ? end - start : undefined;
}

/**
 * A tool call as one dense row, the ledger's, that expands to its full renderer. `defaultOpen`
 * defaults to open for standalone use; the transcript opens only failed calls, and a call a deep
 * link highlights (`reveal`), so the highlighted row shows the output the link points at.
 */
export function ToolView({
	call,
	result,
	resultEntry,
	callEntry,
	defaultOpen = true,
	reveal = false,
}: {
	call: ToolCall;
	result?: ToolResultMessage;
	resultEntry?: Entry;
	callEntry?: Entry;
	defaultOpen?: boolean;
	reveal?: boolean;
}) {
	const renderer = findToolRenderer(call.name);
	const { sessionId } = useSessionView();
	const [open, setOpen] = useViewState(`tool-open:${sessionId}:${call.id}`, defaultOpen);
	useEffect(() => {
		if (reveal) setOpen(true);
	}, [reveal, setOpen]);
	const Component = renderer.Component;
	const family = toolFamily(call.name);
	const error = result?.isError === true;
	const duration = toolDuration(result, resultEntry, callEntry);
	const record = { kind: "tool" as const, seq: 0, callId: call.id, name: call.name, isError: error };
	const badge = recordBadge(record);
	const summary = renderer.summary?.(call) ?? firstStringArg(call.arguments);
	return (
		<div data-tool={renderer.id} data-tool-name={call.name}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-[13px] hover:bg-hover"
			>
				<KindBadge family={family} label={badge} className={cx(error && "!bg-red-soft !text-red")} />
				<Icon name={recordIcon(record)} size={14} className={cx("shrink-0", error ? "text-red" : FAMILY_CLASSES[family].text)} />
				{showsToolName(record) && <span className="shrink-0 font-medium">{call.name}</span>}
				{summary && <span className="mono min-w-0 flex-1 truncate text-[12px] text-ink/75">{summary}</span>}
				<span className="ml-auto flex shrink-0 items-center gap-2">
					{duration !== undefined && <span className="mono tnum text-[11.5px] text-muted">{formatSpan(duration)}</span>}
					{error && <Pill tone="red">error</Pill>}
					{!result && <Pill>no result</Pill>}
					<span aria-hidden="true" className={cx("w-3 text-center text-[10px] text-muted transition-transform duration-150", open && "rotate-90")}>
						▸
					</span>
				</span>
			</button>
			{open && (
				<div className="mt-1 mb-2 pl-[52px]">
					<Component call={call} result={result} resultEntry={resultEntry} />
					{result?.isError && !renderer.handlesErrors && (
						<div className="mt-2">
							<ToolErrorCallout result={result} />
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function Note({ icon, children }: { icon: IconName; children: ReactNode }) {
	return (
		<div className="flex items-center gap-2 text-[13px] text-muted">
			<Icon name={icon} className="shrink-0" />
			<span className="min-w-0">{children}</span>
		</div>
	);
}

function ModelCall({ item }: { item: Extract<TimelineItem, { kind: "model-call" }> }) {
	const { sessionId } = useSessionView();
	const { ModelCallExtra } = useSessionSlots();
	const { message } = item;
	const usage = message.usage;
	const prompt = usage ? usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
	const hit = usage && prompt > 0 ? (usage.cacheRead ?? 0) / prompt : undefined;
	const error = message.stopReason === "error" || message.stopReason === "aborted" || Boolean(message.errorMessage);
	return (
		<div className="flex h-7 items-center gap-2 text-[12px] text-muted" data-model-call="">
			<KindBadge family="llm" label="LLM" className={cx(error && "!bg-red-soft !text-red")} />
			<span className="min-w-0 truncate text-ink/80">{message.model}</span>
			{message.thinkingLevel && message.thinkingLevel !== "off" && <span className="shrink-0">thinking {message.thinkingLevel}</span>}
			<span className="ml-auto flex shrink-0 items-center gap-2.5">
				{usage && (
					<span className="mono tnum text-[11.5px]" title={`${formatCount(usage.input)} input · ${formatCount(usage.cacheRead ?? 0)} cache read · ${formatCount(usage.output)} output`}>
						{formatCount(prompt)}→{formatCount(usage.output)}
					</span>
				)}
				{hit !== undefined && <Ring value={hit} className="text-k-read" title={`Cache hit ${Math.round(hit * 100)}%`} />}
				{usage?.cost?.total ? <span className="mono tnum text-[11.5px]">{formatFineCost(usage.cost.total)}</span> : null}
				<span className="mono tnum text-[11.5px]">{formatTime(message.timestamp ?? item.entry.timestamp)}</span>
				{ModelCallExtra && <ModelCallExtra sessionId={sessionId} entry={item.entry} />}
			</span>
		</div>
	);
}

function RawEntry({ item }: { item: Extract<TimelineItem, { kind: "raw" }> }) {
	const api = useApi();
	const { sessionId } = useSessionView();
	return (
		<Toggle
			className="text-[13px]"
			label={
				<span className="text-muted">
					{item.label} <span className="opacity-70">#{item.seq}</span>
				</span>
			}
		>
			<CodeBlock code={JSON.stringify(item.entry.raw, null, 2)} language="json" />
			{item.entry.truncated && (
				<a className="text-[13px] text-accent hover:underline" href={api.rawEntryUrl(sessionId, item.seq)}>
					View the full entry
				</a>
			)}
		</Toggle>
	);
}

function TruncatedNote({ entry }: { entry: Entry }) {
	const api = useApi();
	const { sessionId } = useSessionView();
	if (!entry.truncated) return null;
	return (
		<div className="mt-1 text-[12px] text-muted">
			Long strings were shortened.{" "}
			<a className="text-accent hover:underline" href={api.rawEntryUrl(sessionId, entry.seq)} target="_blank" rel="noreferrer">
				View the verbatim entry
			</a>
		</div>
	);
}

function Images({ content }: { content: unknown }) {
	const images = contentImages(content);
	if (images.length === 0) return null;
	return (
		<div className="mt-2 flex flex-wrap gap-2">
			{images.map((image, index) => (
				<img
					key={index}
					src={image.src ?? (image.data ? `data:${image.mimeType};base64,${image.data}` : undefined)}
					alt={`Image ${index + 1}`}
					className="max-h-80 max-w-full rounded-md border border-line"
				/>
			))}
		</div>
	);
}

/** One row of an expanded turn's timeline. */
export function TimelineItemView({ item, highlighted = false }: { item: TimelineItem; highlighted?: boolean }) {
	switch (item.kind) {
		case "model-call":
			return <ModelCall item={item} />;
		case "text":
			return (
				<>
					<Markdown text={item.text} />
					<TruncatedNote entry={item.entry} />
				</>
			);
		case "thinking":
			return (
				<Toggle className="text-[14px] text-muted" label={<span className="italic">{item.redacted ? "Thinking (redacted)" : "Thinking"}</span>}>
					{item.text ? <Markdown text={item.text} className="text-[14px] text-muted" /> : <span className="italic">No visible text</span>}
				</Toggle>
			);
		case "tool":
			return <ToolView call={item.call} result={item.result} resultEntry={item.resultEntry} callEntry={item.entry} defaultOpen={item.result?.isError === true} reveal={highlighted} />;
		case "tool-result":
			return (
				<div>
					<Note icon="tool">Result of {item.message.toolName}</Note>
					<div className="mt-1 pl-6">
						{item.message.isError ? (
							<ToolErrorCallout result={item.message} />
						) : (
							<pre className="code-block wrap" style={{ maxHeight: "24rem" }}>
								{contentText(item.message.content)}
							</pre>
						)}
					</div>
				</div>
			);
		case "assistant-error":
			return (
				<Callout tone="red" title={item.message.stopReason === "aborted" ? "Response aborted" : "Model error"}>
					{item.message.errorMessage && <div className="text-[14px] [overflow-wrap:anywhere]">{item.message.errorMessage}</div>}
				</Callout>
			);
		case "user":
			return (
				<div className="rounded-md bg-soft px-3 py-2">
					<div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted">
						<Icon name="user" size={13} /> User
					</div>
					<Markdown text={contentText(item.content)} />
					<Images content={item.content} />
				</div>
			);
		case "bash-execution": {
			const { message } = item;
			const parsed = parseBashOutput(message.output ?? "", false);
			const exitCode = message.exitCode ?? null;
			return (
				<div data-tool="bash-execution">
					<Note icon="terminal">User ran a shell command{message.cancelled ? " (cancelled)" : ""}</Note>
					<div className="mt-1.5 pl-6">
						<CodeBlock code={message.command} language="bash" wrap />
						<BashOutput
							output={parsed.output}
							exitCode={exitCode}
							isError={exitCode !== null && exitCode !== 0}
							note={message.truncated ? `Output truncated${message.fullOutputPath ? `; full output in ${message.fullOutputPath}` : ""}` : null}
						/>
					</div>
				</div>
			);
		}
		case "note":
			return <Note icon={item.icon}>{item.text}</Note>;
		case "compaction":
			return (
				<Callout icon="compress" title="Context compacted">
					{item.tokensBefore !== undefined && (
						<div className="text-[13px] text-muted">{formatCount(item.tokensBefore)} tokens summarized</div>
					)}
					<Toggle className="mt-1 text-[14px]" label={<span className="text-muted">Summary</span>}>
						<Markdown text={item.summary} className="text-[14px]" />
					</Toggle>
				</Callout>
			);
		case "branch-summary":
			return (
				<Callout icon="branch" title="Branch summary">
					<Toggle className="text-[14px]" label={<span className="text-muted">Summary</span>}>
						<Markdown text={item.summary} className="text-[14px]" />
					</Toggle>
				</Callout>
			);
		case "custom-message":
			return (
				<div className={cx("rounded-md border border-line px-3 py-2", item.hidden && "opacity-80")}>
					<div className="mb-1 text-[12px] text-muted">
						Extension message · <span className="mono">{item.customType}</span>
					</div>
					<Markdown text={contentText(item.content)} className="text-[14px]" />
				</div>
			);
		case "raw":
			return <RawEntry item={item} />;
	}
}
