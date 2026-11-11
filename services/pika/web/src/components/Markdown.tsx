import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code";
import { cx } from "./ui";

const MENTION_CHIP_CLASS =
	"rounded-sm border border-line bg-soft px-1 py-px font-mono text-[12.5px] font-medium text-ink";

const MENTION_TOKEN_RE = /(^|[\s([{"',:;])(@[A-Za-z0-9._-]{0,127}[A-Za-z0-9_-])/g;
const SKIP_TAGS = new Set(["a", "code", "pre", "script", "style"]);

interface HastNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
}

function splitMentions(value: string): HastNode[] | null {
	MENTION_TOKEN_RE.lastIndex = 0;
	let match = MENTION_TOKEN_RE.exec(value);
	if (!match) return null;

	const out: HastNode[] = [];
	let cursor = 0;
	while (match) {
		const prefix = value.slice(cursor, match.index) + match[1]!;
		const token = match[2]!;
		if (prefix) out.push({ type: "text", value: prefix });
		out.push({
			type: "element",
			tagName: "span",
			properties: { className: MENTION_CHIP_CLASS, "data-mention": "" },
			children: [{ type: "text", value: token }],
		});
		cursor = match.index + match[0].length;
		match = MENTION_TOKEN_RE.exec(value);
	}
	if (cursor < value.length) {
		out.push({ type: "text", value: value.slice(cursor) });
	}
	return out;
}

function walkMentions(node: HastNode): void {
	if (node.type === "element" && node.tagName && SKIP_TAGS.has(node.tagName)) return;
	if (!node.children) return;

	const next: HastNode[] = [];
	let changed = false;
	for (const child of node.children) {
		if (child.type === "text" && typeof child.value === "string") {
			const parts = splitMentions(child.value);
			if (parts) {
				next.push(...parts);
				changed = true;
				continue;
			}
		} else {
			walkMentions(child);
		}
		next.push(child);
	}
	if (changed) node.children = next;
}

function rehypeHighlightMentions() {
	return (tree: HastNode) => {
		walkMentions(tree);
	};
}

const REHYPE_MENTIONS = [rehypeHighlightMentions];

const components: Components = {
	pre: ({ children }) => <>{children}</>,
	code: ({ className, children }) => {
		const text = String(children ?? "");
		const match = /language-([\w+-]+)/.exec(className ?? "");
		if (match || text.includes("\n")) {
			return <CodeBlock code={text.replace(/\n$/, "")} language={match?.[1]} />;
		}
		return <code className="code-chip">{children}</code>;
	},
	a: ({ href, children }) => (
		<a href={href} target="_blank" rel="noreferrer noopener">
			{children}
		</a>
	),
	table: ({ children }) => (
		<div className="max-w-full overflow-x-auto" data-markdown-table="">
			<table>{children}</table>
		</div>
	),
	img: ({ src, alt }) => <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="max-w-full rounded-sm" />,
};

export const Markdown = memo(function Markdown({
	text,
	className,
	highlightMentions = false,
}: {
	text: string;
	className?: string;
	highlightMentions?: boolean;
}) {
	return (
		<div className={cx("prose-pika", className)}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={highlightMentions ? REHYPE_MENTIONS : undefined}
				components={components}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
