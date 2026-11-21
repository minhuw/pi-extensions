import { Callout } from "../../components/ui";
import { classifyImageContent } from "../../lib/safe-image";
import type { Entry, ToolCall, ToolResultMessage } from "../../lib/types";
import { contentImages, contentText } from "../timeline";

export interface ToolRenderProps {
	call: ToolCall;
	result?: ToolResultMessage;
	resultEntry?: Entry;
}

export function args(call: ToolCall): Record<string, unknown> {
	return call.arguments && typeof call.arguments === "object" ? call.arguments : {};
}

export function argString(call: ToolCall, ...names: string[]): string | undefined {
	const values = args(call);
	for (const name of names) {
		const value = values[name];
		if (typeof value === "string") return value;
	}
	return undefined;
}

export function argNumber(call: ToolCall, ...names: string[]): number | undefined {
	const values = args(call);
	for (const name of names) {
		const value = values[name];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export function resultText(result: ToolResultMessage | undefined): string {
	return result ? contentText(result.content) : "";
}

export function okResult(result: ToolResultMessage | undefined): ToolResultMessage | undefined {
	return result && !result.isError ? result : undefined;
}

export function ResultImages({ result }: { result: ToolResultMessage | undefined }) {
	const images = result ? contentImages(result.content) : [];
	if (images.length === 0) return null;
	return (
		<div className="mt-2 flex flex-wrap gap-2">
			{images.map((image, index) => {
				const classified = classifyImageContent(image);
				if (classified.kind === "allowed") {
					return (
						<img
							key={index}
							src={classified.src}
							alt={`Tool result image ${index + 1}`}
							referrerPolicy="no-referrer"
							className="max-h-80 max-w-full rounded-sm border border-line"
						/>
					);
				}
				if (classified.kind === "external") {
					return (
						<a
							key={index}
							href={classified.href}
							target="_blank"
							rel="noopener noreferrer"
							data-blocked-external-image=""
							className="inline-flex items-center rounded-sm border border-line bg-soft px-2.5 py-1.5 text-[12px] text-muted underline decoration-ink/30 underline-offset-[3px] hover:text-ink hover:decoration-ink"
						>
							[External image: Tool result image {index + 1}]
						</a>
					);
				}
				const mime = typeof image.mimeType === "string" && image.mimeType.trim() ? image.mimeType.trim() : "unsupported type";
				const detail = classified.reason === "disallowed-mime" ? ` (${mime})` : "";
				return (
					<div
						key={index}
						data-blocked-image=""
						className="inline-flex items-center rounded-sm border border-line bg-soft px-2.5 py-1.5 text-[12px] text-muted"
					>
						Blocked image{detail}
					</div>
				);
			})}
		</div>
	);
}

export function ToolErrorCallout({ result, title = "Tool error" }: { result: ToolResultMessage; title?: string }) {
	const text = resultText(result);
	return (
		<Callout tone="red" title={title}>
			{text && <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>}
		</Callout>
	);
}

export function PendingResult() {
	return <div className="mt-1 text-[13px] text-muted italic">No result recorded</div>;
}

export function Label({ children }: { children: string }) {
	return <div className="mt-3 mb-1 text-[12px] font-medium text-muted">{children}</div>;
}
