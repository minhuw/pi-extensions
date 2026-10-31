import { OutputBlock } from "../../components/code";
import { Icon } from "../../components/icons";
import { Toggle } from "../../components/ui";
import { args, argString, okResult, PendingResult, resultText, type ToolRenderProps } from "./shared";

export interface WebLink {
	url: string;
	title?: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/g;
const MARKDOWN_LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g;
const TITLE_LINE = /^\s*(?:#+\s*|\d+[.)]\s*|[-*]\s*)?(?:title:\s*)?(.+?)\s*$/i;
const MAX_LINKS = 20;

function cleanUrl(url: string): string {
	return url.replace(/[.,;:!?]+$/, "");
}

function collectArgUrls(value: unknown, out: string[]): void {
	if (typeof value === "string") {
		if (/^https?:\/\//.test(value)) out.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) collectArgUrls(item, out);
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectArgUrls(item, out);
	}
}

/** Links from the arguments, markdown links, "Title / URL" pairs, and bare URLs in the result. */
export function extractLinks(argValues: Record<string, unknown>, text: string): WebLink[] {
	const links = new Map<string, WebLink>();
	const add = (url: string, title?: string) => {
		const clean = cleanUrl(url);
		const existing = links.get(clean);
		if (existing) {
			if (!existing.title && title) existing.title = title;
			return;
		}
		if (links.size < MAX_LINKS) links.set(clean, { url: clean, title });
	};

	const argUrls: string[] = [];
	collectArgUrls(argValues, argUrls);
	for (const url of argUrls) add(url);

	for (const match of text.matchAll(MARKDOWN_LINK)) add(match[2], match[1].trim());

	const lines = text.split("\n");
	lines.forEach((line, index) => {
		for (const match of line.matchAll(URL_PATTERN)) {
			let title: string | undefined;
			const trimmed = line.trim();
			const urlOnly = trimmed === match[0] || /^(?:url|link|source):\s*\S+$/i.test(trimmed);
			if (urlOnly && index > 0) {
				const previous = TITLE_LINE.exec(lines[index - 1] ?? "")?.[1];
				if (previous && !/https?:\/\//.test(previous) && previous.length <= 200) title = previous;
			}
			add(match[0], title);
		}
	});
	return [...links.values()];
}

function displayUrl(url: string): { host: string; rest: string } {
	try {
		const parsed = new URL(url);
		const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
		return { host: parsed.host.replace(/^www\./, ""), rest };
	} catch {
		return { host: url, rest: "" };
	}
}

export function LinkCard({ link }: { link: WebLink }) {
	const { host, rest } = displayUrl(link.url);
	return (
		<a
			href={link.url}
			target="_blank"
			rel="noreferrer noopener"
			className="flex min-w-0 items-start gap-3 border-b border-line px-1 py-1.5 hover:bg-hover"
			data-link-card=""
		>
			<Icon name="globe" className="mt-1 shrink-0 text-muted" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13.5px] font-medium underline decoration-ink/30 underline-offset-[3px]">{link.title ?? host}</span>
				<span className="block truncate text-[12px] text-muted">
					{host}
					{rest}
				</span>
			</span>
		</a>
	);
}

export function WebTool({ call, result }: ToolRenderProps) {
	const query = argString(call, "query", "q", "search", "prompt");
	const ok = okResult(result);
	const text = resultText(ok);
	const links = extractLinks(args(call), text);
	return (
		<div>
			{query && (
				<div className="text-[14px]">
					<span className="text-muted">Query </span>
					<span className="font-medium">{query}</span>
				</div>
			)}
			{links.length > 0 && <div className="mt-2 grid gap-x-6 border-t border-line sm:grid-cols-2">{links.map((link) => <LinkCard key={link.url} link={link} />)}</div>}
			{ok && text && (
				<Toggle className="mt-2 text-[14px]" label={<span className="text-muted">Result text</span>}>
					<OutputBlock text={text} />
				</Toggle>
			)}
			{!result && <PendingResult />}
		</div>
	);
}
