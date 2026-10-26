import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/icons";
import { JsonTree } from "../components/JsonTree";
import { Callout, cx, ErrorState, Pill, SkeletonLines, Toggle } from "../components/ui";
import { useApi, type PikaApi } from "../lib/api";
import { formatCount, formatDateTime, plural } from "../lib/format";
import type { Entry, ModelRequest } from "../lib/types";
import { useScrollMargin } from "../lib/virtual";
import {
	newMessageStart,
	normalizeRequest,
	SHAPE_LABELS,
	systemSections,
	type Block,
	type NormalMessage,
	type NormalRequest,
	type ToolDeclaration,
} from "./payload";

const LONG_TEXT = 1500;
const LONG_LINES = 24;
const PREVIEW_CHARS = 600;
const RAW_LIMIT = 200_000;
const PREVIOUS_WINDOWS = 10;
const WINDOW = 200;

export interface ContextTarget {
	requestId: string;
	sessionId: string;
	seq: number;
}

const ContextDrawerContext = createContext<((target: ContextTarget) => void) | null>(null);

/** Hosts the drawer for a session page; nested inline sessions open the same drawer. */
export function ContextDrawerProvider({ children }: { children: ReactNode }) {
	const [target, setTarget] = useState<ContextTarget | null>(null);
	return (
		<ContextDrawerContext.Provider value={setTarget}>
			{children}
			{target && <ContextDrawer key={target.requestId} target={target} onClose={() => setTarget(null)} />}
		</ContextDrawerContext.Provider>
	);
}

/** The `ModelCallExtra` slot: a "Context" button on model calls with a captured request. */
export function ContextButton({ sessionId, entry }: { sessionId: string; entry: Entry }) {
	const open = useContext(ContextDrawerContext);
	if (!entry.requestId || !open) return null;
	const requestId = entry.requestId;
	return (
		<button
			type="button"
			onClick={() => open({ requestId, sessionId, seq: entry.seq })}
			className="flex shrink-0 items-center gap-1 rounded-sm px-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
			aria-label="Show what the model saw"
			title="What the model saw"
			data-context-button={requestId}
		>
			<Icon name="eye" size={13} />
			Context
		</button>
	);
}

/** The nearest earlier entry in the session with a captured request, from the cache or by paging back. */
async function previousRequestId(api: PikaApi, queryClient: QueryClient, sessionId: string, seq: number): Promise<string | null> {
	const known = new Map<number, Entry | null>();
	for (const [, data] of queryClient.getQueriesData<{ items: Entry[] }>({ queryKey: ["entries", sessionId] })) {
		for (const item of data?.items ?? []) known.set(item.seq, item);
	}
	let windows = 0;
	for (let s = seq - 1; s >= 0; ) {
		if (!known.has(s)) {
			if (windows++ >= PREVIOUS_WINDOWS) return null;
			const from = Math.max(0, s - WINDOW + 1);
			const page = await api.entries(sessionId, { from, to: s, limit: WINDOW });
			for (let k = from; k <= s; k++) known.set(k, null);
			for (const item of page.items) known.set(item.seq, item);
			continue;
		}
		const item = known.get(s);
		if (item?.requestId) return item.requestId;
		s--;
	}
	return null;
}

function fidelityTone(fidelity: string) {
	return fidelity === "payload" ? "green" : "yellow";
}

function roleTone(role: string): "neutral" | "accent" | "green" | "yellow" | "red" {
	if (role === "assistant" || role === "model") return "accent";
	if (role === "tool" || role === "toolResult" || role === "function") return "green";
	if (role === "system" || role === "developer") return "yellow";
	if (role === "missing") return "red";
	return "neutral";
}

function json(value: unknown): string {
	try {
		return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
	} catch {
		return String(value);
	}
}

/** Text that renders a preview until asked for the rest. */
function LongText({ text, mono = false }: { text: string; mono?: boolean }) {
	const [full, setFull] = useState(false);
	const long = text.length > LONG_TEXT || text.split("\n", LONG_LINES + 1).length > LONG_LINES;
	const shown = long && !full ? `${text.slice(0, PREVIEW_CHARS).split("\n").slice(0, 10).join("\n")}…` : text;
	return (
		<div>
			<div
				className={cx(
					"whitespace-pre-wrap [overflow-wrap:anywhere]",
					mono ? "mono max-h-[32rem] overflow-auto rounded-md border border-line bg-soft px-3 py-2" : "text-[14px]",
				)}
			>
				{shown || <span className="text-muted italic">(empty)</span>}
			</div>
			{long && (
				<button type="button" onClick={() => setFull(!full)} className="mt-0.5 rounded-sm px-1 text-[12px] text-muted hover:bg-hover">
					{full ? "Show less" : `Show all ${text.length.toLocaleString("en-US")} characters`}
				</button>
			)}
		</div>
	);
}

function BlockView({ block }: { block: Block }) {
	switch (block.kind) {
		case "text":
			return <LongText text={block.text} />;
		case "thinking":
			return (
				<Toggle className="text-[13px] text-muted" label={<span className="italic">{block.redacted ? "Thinking (redacted)" : "Thinking"}</span>}>
					{block.text ? <LongText text={block.text} /> : <span className="italic">No visible text</span>}
				</Toggle>
			);
		case "tool-call":
			return (
				<div data-block="tool-call">
					<div className="flex items-center gap-1.5 text-[13px]">
						<Icon name="tool" size={13} className="text-muted" />
						<span className="mono font-medium">{block.name}</span>
						{block.id && <span className="mono truncate text-[12px] text-muted">{block.id}</span>}
					</div>
					<div className="mt-1">
						<LongText text={json(block.args)} mono />
					</div>
				</div>
			);
		case "tool-result":
			return (
				<div data-block="tool-result">
					<div className="flex items-center gap-1.5 text-[13px] text-muted">
						<Icon name="terminal" size={13} />
						<span>Result{block.name ? ` of ${block.name}` : ""}</span>
						{block.id && <span className="mono truncate text-[12px]">{block.id}</span>}
						{block.isError && <Pill tone="red">error</Pill>}
					</div>
					<div className="mt-1">
						<LongText text={block.text} mono />
					</div>
				</div>
			);
		case "image":
			return (
				<div className="inline-flex items-center gap-1.5 rounded-sm bg-soft px-2 py-0.5 text-[13px] text-muted">
					<Icon name="file" size={13} />
					{block.label}
				</div>
			);
		case "missing":
			return (
				<div className="text-[13px] text-yellow" data-block="missing">
					Block not uploaded yet · <span className="mono">{block.hash.slice(0, 12)}</span>
				</div>
			);
		case "json":
			return (
				<Toggle className="text-[13px]" label={<span className="text-muted">{block.label}</span>}>
					<JsonTree value={block.value} />
				</Toggle>
			);
	}
}

const MessageRow = memo(function MessageRow({ message, index, isNew }: { message: NormalMessage; index: number; isNew: boolean }) {
	return (
		<div
			className={cx("mb-2 rounded-md border px-3 py-2", isNew ? "border-accent/30 bg-accent-soft" : "border-line")}
			data-context-message={index}
			data-new={isNew || undefined}
		>
			<div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
				<Pill tone={roleTone(message.role)}>{message.role}</Pill>
				<span>#{index + 1}</span>
				{isNew && <span className="ml-auto text-accent">new</span>}
			</div>
			<div className="space-y-2">
				{message.blocks.length === 0 ? (
					<div className="text-[13px] text-muted italic">(no content)</div>
				) : (
					message.blocks.map((block, i) => <BlockView key={i} block={block} />)
				)}
			</div>
		</div>
	);
});

function MessageList({
	messages,
	newFrom,
	scrollPane,
}: {
	messages: NormalMessage[];
	newFrom: number | undefined;
	scrollPane: HTMLElement | null;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const scrollMargin = useScrollMargin(listRef, scrollPane);
	const virtualizer = useVirtualizer({
		count: messages.length,
		getScrollElement: () => scrollPane,
		estimateSize: () => 110,
		overscan: 6,
		scrollMargin,
	});
	return (
		<div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }} data-context-list="" data-virtual-list="">
			{virtualizer.getVirtualItems().map((virtual) => (
				<div
					key={virtual.key}
					ref={virtualizer.measureElement}
					data-index={virtual.index}
					className="absolute top-0 left-0 w-full"
					style={{ transform: `translateY(${virtual.start - scrollMargin}px)` }}
				>
					<MessageRow message={messages[virtual.index]} index={virtual.index} isNew={newFrom !== undefined && virtual.index >= newFrom} />
				</div>
			))}
		</div>
	);
}

function SystemPrompt({ text }: { text: string }) {
	const sections = useMemo(() => systemSections(text), [text]);
	if (sections.length <= 1) return <LongText text={text} />;
	return (
		<div className="space-y-1" data-system-sections={sections.length}>
			{sections.map((section, index) =>
				section.title ? (
					<Toggle
						key={index}
						className="text-[14px]"
						label={
							<span>
								{section.title} <span className="text-[12px] text-muted">· {formatCount(section.text.length)} chars</span>
							</span>
						}
					>
						<LongText text={section.text} />
					</Toggle>
				) : (
					<LongText key={index} text={section.text} />
				),
			)}
		</div>
	);
}

function ToolList({ tools }: { tools: ToolDeclaration[] }) {
	return (
		<div className="space-y-1">
			{tools.map((tool, index) => (
				<div key={`${tool.name}:${index}`} data-tool-decl={tool.name}>
					<Toggle
						className="text-[14px]"
						label={
							<span className="flex min-w-0 items-center gap-2">
								<span className="mono shrink-0">{tool.name}</span>
								{tool.description && <span className="truncate text-[13px] text-muted">{tool.description.split("\n")[0]}</span>}
							</span>
						}
					>
						{tool.description && <LongText text={tool.description} />}
						{tool.parameters !== undefined && <JsonTree value={tool.parameters} className="mt-2" />}
					</Toggle>
				</div>
			))}
		</div>
	);
}

function RawJson({ payload }: { payload: unknown }) {
	const text = useMemo(() => JSON.stringify(payload, null, 2) ?? "", [payload]);
	const [all, setAll] = useState(false);
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};
	const shown = text.length > RAW_LIMIT && !all ? text.slice(0, RAW_LIMIT) : text;
	return (
		<div data-raw-json="">
			<div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
				<span>{formatCount(text.length)} characters</span>
				<button type="button" onClick={() => void copy()} className="ml-auto rounded-sm border border-line px-2 py-0.5 hover:bg-hover">
					{copied ? "Copied" : "Copy JSON"}
				</button>
			</div>
			<pre className="code-block" style={{ maxHeight: "32rem" }}>
				<code>{shown}</code>
			</pre>
			{shown.length < text.length && (
				<button type="button" onClick={() => setAll(true)} className="mt-1 rounded-sm px-1 text-[12px] text-muted hover:bg-hover">
					Show all {text.length.toLocaleString("en-US")} characters
				</button>
			)}
		</div>
	);
}

function Section({ title, children, meta }: { title: string; children: ReactNode; meta?: ReactNode }) {
	return (
		<section className="mt-6">
			<h3 className="mb-2 flex items-center gap-2 text-[13px] font-medium text-muted">
				{title}
				{meta}
			</h3>
			{children}
		</section>
	);
}

function RequestBody({
	request,
	normal,
	newFrom,
	previousKnown,
	scrollPane,
}: {
	request: ModelRequest;
	normal: NormalRequest;
	newFrom: number | undefined;
	previousKnown: boolean;
	scrollPane: HTMLElement | null;
}) {
	const newCount = newFrom === undefined ? 0 : normal.messages.length - newFrom;
	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<Pill tone={fidelityTone(request.fidelity)} title="Capture fidelity">
					{request.fidelity}
				</Pill>
				<Pill>{SHAPE_LABELS[normal.shape]}</Pill>
				{!request.complete && <Pill tone="red">incomplete</Pill>}
			</div>
			<dl className="mt-3 grid grid-cols-[96px_1fr] gap-y-1 text-[14px]">
				{(
					[
						["Provider", request.provider],
						["API", request.api],
						["Model", request.model],
						["Captured", formatDateTime(request.at)],
					] as const
				).map(([label, value]) => (
					<div key={label} className="contents">
						<dt className="text-muted">{label}</dt>
						<dd className="min-w-0 truncate">{value || <span className="text-muted">—</span>}</dd>
					</div>
				))}
			</dl>
			{!request.complete && (
				<div className="mt-4">
					<Callout tone="yellow" title="Incomplete request">
						<div className="text-[14px]">Some blocks of this request have not been uploaded yet, so parts are missing below.</div>
					</Callout>
				</div>
			)}
			{request.fidelity === "context" && (
				<div className="mt-4">
					<Callout title="pi context, not the provider payload">
						<div className="text-[14px]">The provider payload was not exposed for this call; this is the context pi built for it.</div>
					</Callout>
				</div>
			)}
			{normal.shape === "generic" ? (
				<Section title="Payload">
					<JsonTree value={request.payload} />
				</Section>
			) : (
				<>
					<Section title="System prompt" meta={normal.system ? <span className="font-normal">· {formatCount(normal.system.length)} chars</span> : undefined}>
						{normal.system ? <SystemPrompt text={normal.system} /> : <div className="text-[14px] text-muted italic">None</div>}
					</Section>
					<Section title="Tools">
						{normal.tools.length ? (
							<Toggle label={<span className="text-[14px]">{plural(normal.tools.length, "tool declaration")}</span>}>
								<ToolList tools={normal.tools} />
							</Toggle>
						) : (
							<div className="text-[14px] text-muted italic">None</div>
						)}
					</Section>
					{Object.keys(normal.settings).length > 0 && (
						<Section title="Parameters">
							<JsonTree value={normal.settings} />
						</Section>
					)}
					<Section
						title={`Messages · ${formatCount(normal.messages.length)}`}
						meta={
							<span className="font-normal" data-new-count={newCount}>
								{newFrom !== undefined ? `· ${plural(newCount, "new message")} since the previous request` : previousKnown ? "· first request in this session" : ""}
							</span>
						}
					>
						<MessageList messages={normal.messages} newFrom={newFrom} scrollPane={scrollPane} />
					</Section>
				</>
			)}
			<Section title="Raw JSON">
				<Toggle label={<span className="text-[14px] text-muted">Show the reconstructed request</span>}>
					<RawJson payload={request.payload} />
				</Toggle>
			</Section>
		</>
	);
}

export function ContextDrawer({ target, onClose }: { target: ContextTarget; onClose: () => void }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [scrollPane, setScrollPane] = useState<HTMLElement | null>(null);
	const request = useQuery({ queryKey: ["request", target.requestId], queryFn: () => api.modelRequest(target.requestId), staleTime: Infinity });
	const previousId = useQuery({
		queryKey: ["previous-request", target.sessionId, target.seq],
		queryFn: () => previousRequestId(api, queryClient, target.sessionId, target.seq),
		staleTime: Infinity,
	});
	const previous = useQuery({
		queryKey: ["request", previousId.data],
		queryFn: () => api.modelRequest(previousId.data!),
		enabled: Boolean(previousId.data),
		staleTime: Infinity,
	});

	const normal = useMemo(
		() => (request.data ? normalizeRequest(request.data.payload, { fidelity: request.data.fidelity, api: request.data.api }) : undefined),
		[request.data],
	);
	const previousNormal = useMemo(
		() => (previous.data ? normalizeRequest(previous.data.payload, { fidelity: previous.data.fidelity, api: previous.data.api }) : undefined),
		[previous.data],
	);
	const newFrom = normal && previousNormal ? newMessageStart(normal.messages, previousNormal.messages) : undefined;

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<aside
			className="fixed inset-y-0 right-0 z-30 flex w-[min(680px,100vw)] flex-col border-l border-line bg-page shadow-[-8px_0_24px_rgba(15,15,15,0.06)]"
			aria-label="What the model saw"
			role="dialog"
			data-context-drawer={target.requestId}
		>
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-5">
				<Icon name="eye" className="text-muted" />
				<h2 className="font-medium">What the model saw</h2>
				<button type="button" onClick={onClose} className="ml-auto rounded-sm px-2 py-0.5 text-[13px] text-muted hover:bg-hover" aria-label="Close">
					Close
				</button>
			</div>
			<div ref={setScrollPane} className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-16" data-scroll-pane="">
				{request.isPending ? (
					<SkeletonLines lines={6} />
				) : request.isError ? (
					<ErrorState error={request.error} onRetry={() => void request.refetch()} />
				) : (
					normal && (
						<RequestBody
							request={request.data}
							normal={normal}
							newFrom={newFrom}
							previousKnown={previousId.isSuccess && previousId.data === null}
							scrollPane={scrollPane}
						/>
					)
				)}
			</div>
		</aside>
	);
}
