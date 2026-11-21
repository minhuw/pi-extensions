import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { formatDateTime, plural } from "../../lib/format";
import { formatBytes, messageShape, reasonMessage, senderLabel, sessionLabel } from "../../lib/relay";
import { Icon } from "../icons";
import { Markdown } from "../Markdown";
import { Segmented } from "../ui";
import { names, senderName } from "./helpers";
import type { ChatMessage } from "./types";

export function MessageReader({
	message,
	onClose,
	onJumpToMessage,
	hasParentInStream,
}: {
	message: ChatMessage;
	onClose: () => void;
	onJumpToMessage: (id: string) => void;
	hasParentInStream: boolean;
}) {
	const [view, setView] = useState<"rendered" | "raw">("rendered");
	const [copied, setCopied] = useState<boolean | null>(null);
	const [headings, setHeadings] = useState<string[]>([]);
	const bodyRef = useRef<HTMLDivElement>(null);
	const shape = useMemo(() => messageShape(message.text), [message.text]);

	useEffect(() => {
		setCopied(null);
		bodyRef.current?.scrollTo({ top: 0 });
	}, [message.id]);

	useLayoutEffect(() => {
		const nodes = bodyRef.current?.querySelectorAll("h1, h2, h3") ?? [];
		setHeadings(view === "rendered" ? Array.from(nodes, (node) => node.textContent ?? "") : []);
	}, [message.text, view]);

	const jump = (index: number) => {
		const body = bodyRef.current;
		const target = body?.querySelectorAll<HTMLElement>("h1, h2, h3")[index];
		if (!body || !target) return;
		body.scrollTo({ top: target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 8 });
	};

	return (
		<aside
			aria-label="Message reader"
			data-imessage-reader={message.id}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
			className="flex h-full min-h-0 flex-col bg-page max-xl:fixed max-xl:inset-y-12 max-xl:right-0 max-xl:z-30 max-xl:w-full max-xl:max-w-[420px] max-xl:border-l max-xl:border-ink xl:w-[420px] xl:shrink-0 xl:border-l xl:border-ink"
		>
			<div className="flex items-start gap-2 border-b border-ink px-4 py-2.5">
				<div className="min-w-0 flex-1">
					<div className="text-[14px] leading-5 font-semibold break-words">
						{senderName(message.from)}
						{message.to && (
							<>
								<span className="text-muted"> → </span>
								{sessionLabel(message.to)}
							</>
						)}
					</div>
					<div className="tnum text-[12px] text-muted">
						{formatDateTime(message.at)} · {plural(shape.lines, "line")} · {formatBytes(shape.bytes)}
					</div>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close reader"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line bg-page text-muted hover:border-ink hover:bg-hover hover:text-ink"
				>
					<Icon name="close" size={14} className="shrink-0" />
				</button>
			</div>
			<div className="flex items-center gap-2 border-b border-line px-4 py-2">
				<Segmented
					size="sm"
					label="Show the message"
					value={view}
					options={[
						["rendered", "Rendered"],
						["raw", "Raw"],
					]}
					onChange={setView}
				/>
				<button
					type="button"
					onClick={() => void copyText(message.text).then(setCopied, () => setCopied(false))}
					data-imessage-copy=""
					className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-sm border border-ink bg-page px-2.5 text-[12.5px] font-medium whitespace-nowrap text-ink hover:bg-hover"
				>
					<Icon name={copied ? "check" : "copy"} size={14} />
					{copied ? "Copied" : copied === false ? "Copy failed" : "Copy text"}
				</button>
			</div>
			{headings.length > 1 && (
				<nav aria-label="Sections" className="max-h-28 overflow-y-auto border-b border-line bg-soft px-4 py-2">
					<ol className="flex flex-wrap gap-1.5">
						{headings.map((heading, index) => (
							<li key={index}>
								<button
									type="button"
									onClick={() => jump(index)}
									className="rounded-sm border border-line bg-page px-2 py-0.5 text-[12px] font-medium text-ink hover:border-ink hover:bg-hover"
								>
									{heading}
								</button>
							</li>
						))}
					</ol>
				</nav>
			)}
			<div
				ref={bodyRef}
				tabIndex={0}
				aria-label="Message text"
				data-imessage-reader-body=""
				className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3 text-[14.5px] leading-[1.6]"
			>
				{view === "rendered" ? <Markdown text={message.text} highlightMentions /> : <pre className="code-block wrap">{message.text}</pre>}
			</div>
			<dl className="divide-y divide-line border-t border-ink bg-soft/50 text-[12.5px]">
				<div className="flex items-baseline gap-3 px-4 py-2">
					<dt className="w-24 shrink-0 text-muted">From</dt>
					<dd className="min-w-0 flex-1 truncate text-ink">{senderLabel(message.from)}</dd>
				</div>
				<div className="flex items-baseline gap-3 px-4 py-2">
					<dt className="w-24 shrink-0 text-muted">Sent</dt>
					<dd className="tnum min-w-0 flex-1 text-ink">{formatDateTime(message.at)}</dd>
				</div>
				{message.status && (
					<div className="flex items-baseline gap-3 px-4 py-2">
						<dt className="w-24 shrink-0 text-muted">Status</dt>
						<dd className="min-w-0 flex-1 text-ink">
							{message.status === "rejected" ? reasonMessage(message.reason ?? "") : message.status}
							{message.deliveredAt && message.status === "delivered" && ` (${formatDateTime(message.deliveredAt)})`}
						</dd>
					</div>
				)}
				{message.notified && (
					<div className="flex items-baseline gap-3 px-4 py-2">
						<dt className="w-24 shrink-0 text-muted">Woke</dt>
						<dd className="min-w-0 flex-1 break-words text-ink">{message.notified.length > 0 ? names(message.notified) : "No one"}</dd>
					</div>
				)}
				{message.replyTo && (
					<div className="flex items-baseline gap-3 px-4 py-2">
						<dt className="w-24 shrink-0 text-muted">Replying to</dt>
						<dd className="min-w-0 flex-1 truncate text-ink">
							{hasParentInStream ? (
								<button
									type="button"
									onClick={() => onJumpToMessage(message.replyTo!)}
									className="mono !text-[12px] text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink"
								>
									{message.replyTo}
								</button>
							) : (
								<span className="mono !text-[12px]">{message.replyTo}</span>
							)}
						</dd>
					</div>
				)}
				<div className="flex items-baseline gap-3 px-4 py-2">
					<dt className="w-24 shrink-0 text-muted">Hops</dt>
					<dd className="tnum min-w-0 flex-1 text-ink">{message.hops}</dd>
				</div>
				<div className="flex items-baseline gap-3 px-4 py-2">
					<dt className="w-24 shrink-0 text-muted">Id</dt>
					<dd className="mono min-w-0 flex-1 truncate !text-[12px] text-ink">{message.id}</dd>
				</div>
			</dl>
		</aside>
	);
}
