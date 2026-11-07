import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { CodeBlock } from "../components/code";
import { Icon } from "../components/icons";
import { resolveDocHref, resolveDocImage } from "./links";
import { remarkDocHeadings } from "./markdown";
import type { DocPage } from "./types";

const CLI_LANGS = new Set(["", "text", "plaintext", "txt", "bash", "sh", "shell", "zsh", "console", "nginx", "caddy"]);

const TOKEN_RX = new RegExp(
	[
		"(?<comment>(?:^|(?<=\\s))#[^\\n]*)",
		"(?<string>\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')",
		"(?<placeholder><[a-zA-Z0-9_.:/|+-]+>)",
		"(?<slash>(?:^|(?<=\\s))\\/[a-z][a-z0-9-]*(?=\\s|$))",
		"(?<env>\\b[A-Z_][A-Z0-9_]*=|\\$[a-zA-Z_][a-zA-Z0-9_]*|\\$\\{[^}]+\\})",
		"(?<key>\\b[a-z_][a-z0-9_]*(?==))",
		"(?<url>https?:\\/\\/[^\\s'\")]+|(?:git:github\\.com|npm:|ghcr\\.io)\\/[^\\s'\"]+)",
		"(?<flag>(?:^|(?<=[\\s\\[|]))--?[a-zA-Z0-9][a-zA-Z0-9_-]*)",
		"(?<cmd>(?<![a-zA-Z0-9_./:-])(?:METRIC|pi|pika|npm|npx|cargo|docker|git|curl|sqlite3|rsync|sudo|bash|node|GET|POST|PUT|DELETE|location|return|proxy_pass|proxy_set_header|proxy_http_version|proxy_send_timeout|proxy_read_timeout|client_max_body_size|client_body_timeout|redir|handle|request_body|max_size|reverse_proxy)(?![a-zA-Z0-9_./:-]))",
		"(?<subcmd>(?<![a-zA-Z0-9_./:-])(?:install|run|test|build|ci|clone|tag|push|pull|exec|serve|password|token|create|list|revoke|rename|read-access|reindex|export|delete|session|project|approve|revise|status|pause|resume|stop|reset|hooks|doctor|login|logout|pin|unpin|set|clear|within noise|outside noise|noise unknown|inconclusive|no measurable difference)(?![a-zA-Z0-9_./:-]))",
		"(?<ref>(?<![a-zA-Z0-9_./:-])(?:main\\.\\.\\.HEAD|HEAD|main|master)(?![a-zA-Z0-9_./:-])|(?:\\.\\.?\\/|\\/)[a-zA-Z0-9_./*-]+|[a-zA-Z0-9_.-]+\\.(?:md|ts|tsx|js|mjs|json|toml|yaml|yml|rs|tex|db|zst|sh|conf)\\b)",
		"(?<number>(?:^|(?<=[\\s=(+\\-–:]))\\d+(?:\\.\\d+){2,3}(?::\\d+)*|(?:^|(?<=[\\s=(+\\-–:]))[+-]?\\d+(?:\\.\\d+)?(?:%|ms|s|m|h|d|KiB|MiB|GiB)?\\b)",
	].join("|"),
	"gm",
);

function renderCliTokens(code: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	let lastIndex = 0;
	let keyIndex = 0;
	for (const match of code.matchAll(TOKEN_RX)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			nodes.push(code.slice(lastIndex, index));
		}
		const text = match[0];
		const groups = match.groups ?? {};
		const cls = groups.comment
			? "hljs-comment"
			: groups.slash || text === "METRIC"
				? "hljs-keyword"
				: groups.cmd
					? "hljs-built_in"
					: groups.subcmd
						? "hljs-title"
						: groups.flag || groups.key
							? "hljs-attr"
							: groups.env || groups.ref
								? "hljs-variable"
								: groups.placeholder
									? "hljs-type"
									: groups.string || groups.url
										? "hljs-string"
										: groups.number
											? "hljs-number"
											: "";
		nodes.push(cls ? <span key={keyIndex++} className={cls}>{text}</span> : text);
		lastIndex = index + text.length;
	}
	if (lastIndex < code.length) {
		nodes.push(code.slice(lastIndex));
	}
	return nodes;
}

export function DocCode({ code, language }: { code: string; language?: string }) {
	const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; clearTimeout(timer.current); };
	}, []);
	async function copy() {
		clearTimeout(timer.current);
		try {
			if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(code);
			if (!mounted.current) return;
			setStatus("copied");
			timer.current = setTimeout(() => setStatus("idle"), 2500);
		} catch {
			if (mounted.current) setStatus("failed");
		}
	}
	const normLang = (language ?? "").toLowerCase();
	const displayLang = language && !["text", "plaintext", "txt"].includes(normLang) ? language : undefined;
	const useCliHighlighter = CLI_LANGS.has(normLang);
	return <div className="docs-code">
		<div className="docs-code-tools">
			{displayLang ? <span className="docs-code-lang">{displayLang}</span> : null}
			<span className="docs-code-status" role="status">{status === "failed" ? "Select and copy the code below" : status === "copied" ? "Code copied" : ""}</span>
			<button type="button" onClick={copy} aria-label="Copy code"><Icon name={status === "copied" ? "check" : "copy"} size={13} /><span>{status === "copied" ? "Copied" : "Copy"}</span></button>
		</div>
		<div className="docs-code-scroll" role="region" aria-label="Code example" tabIndex={0}>
			{useCliHighlighter ? (
				<pre className="code-block" data-language={normLang || "cli"}><code className="hljs">{renderCliTokens(code)}</code></pre>
			) : (
				<CodeBlock code={code} language={language} maxHeight="none" />
			)}
		</div>
	</div>;
}

function Heading({ as: Tag, id, children }: { as: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"; id?: string; children?: ReactNode }) {
	return <Tag id={id}>{id ? <Link className="docs-heading-link" to={`#${encodeURIComponent(id)}`}>{children}</Link> : children}</Tag>;
}

export function DocMarkdown({ page, pages }: { page: DocPage; pages: DocPage[] }) {
	return <div className="docs-prose"><ReactMarkdown remarkPlugins={[remarkGfm, remarkDocHeadings]} skipHtml components={{
		a: ({ href, children, title }) => {
			const destination = resolveDocHref(href ?? "", page.source, pages);
			if (!destination) return <span>{children}</span>;
			return destination.startsWith("/docs/") || destination.startsWith("#")
				? <Link to={destination} title={title}>{children}</Link>
				: <a href={destination} title={title} rel="noreferrer">{children}</a>;
		},
		img: ({ src, alt, title }) => {
			const destination = resolveDocImage(typeof src === "string" ? src : "", page.source);
			return destination ? <img src={destination} alt={alt ?? ""} title={title} loading="lazy" /> : <span>{alt}</span>;
		},
		h1: ({ id, children }) => <Heading as="h1" id={id}>{children}</Heading>,
		h2: ({ id, children }) => <Heading as="h2" id={id}>{children}</Heading>,
		h3: ({ id, children }) => <Heading as="h3" id={id}>{children}</Heading>,
		h4: ({ id, children }) => <Heading as="h4" id={id}>{children}</Heading>,
		h5: ({ id, children }) => <Heading as="h5" id={id}>{children}</Heading>,
		h6: ({ id, children }) => <Heading as="h6" id={id}>{children}</Heading>,
		pre: ({ children }) => {
			const child = Children.toArray(children)[0];
			if (isValidElement<{ children?: ReactNode; className?: string }>(child)) {
				const code = String(child.props.children ?? "").replace(/\n$/, "");
				return <DocCode code={code} language={/language-([^\s]+)/.exec(child.props.className ?? "")?.[1]} />;
			}
			return <DocCode code={String(children ?? "")} />;
		},
		table: ({ children }) => <div className="docs-table-scroll" role="region" aria-label="Reference table" tabIndex={0}><table>{children}</table></div>,
	}}>{page.markdown}</ReactMarkdown></div>;
}
