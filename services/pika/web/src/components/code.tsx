import { useEffect, useState } from "react";
import { loadHighlighter, normalizeLanguage } from "../lib/highlight";
import { cx } from "./ui";

const HIGHLIGHT_LIMIT = 200_000;
const DISPLAY_LIMIT = 50_000;

/** Monospace code with lazily loaded syntax highlighting. */
export function CodeBlock({
	code,
	language,
	wrap = false,
	className,
	maxHeight = "28rem",
}: {
	code: string;
	language?: string;
	wrap?: boolean;
	className?: string;
	maxHeight?: string;
}) {
	const lang = normalizeLanguage(language);
	const [html, setHtml] = useState<{ code: string; lang: string; value: string } | null>(null);

	useEffect(() => {
		if (!lang || code.length > HIGHLIGHT_LIMIT) return;
		let cancelled = false;
		loadHighlighter()
			.then((highlight) => {
				const value = highlight(code, lang);
				if (!cancelled && value !== null) setHtml({ code, lang, value });
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [code, lang]);

	const highlighted = html && html.code === code && html.lang === lang ? html.value : null;
	return (
		<pre
			className={cx("code-block", wrap && "wrap", className)}
			style={{ maxHeight }}
			data-language={lang}
		>
			{highlighted !== null ? (
				<code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
			) : (
				<code>{code}</code>
			)}
		</pre>
	);
}

/** Tool output text: wrapped monospace, capped for very large outputs. */
export function OutputBlock({ text, className, empty = "(no output)" }: { text: string; className?: string; empty?: string }) {
	const [showAll, setShowAll] = useState(false);
	const tooLong = text.length > DISPLAY_LIMIT;
	const shown = tooLong && !showAll ? text.slice(0, DISPLAY_LIMIT) : text;
	return (
		<div className={className}>
			<pre className="code-block wrap" style={{ maxHeight: "24rem" }} data-output="">
				{shown === "" ? <span className="text-muted italic">{empty}</span> : <code>{shown}</code>}
			</pre>
			{tooLong && (
				<button
					type="button"
					className="mt-1 rounded-sm px-1 text-[13px] text-muted hover:bg-hover"
					onClick={() => setShowAll(!showAll)}
				>
					{showAll ? "Show less" : `Show all ${text.length.toLocaleString("en-US")} characters`}
				</button>
			)}
		</div>
	);
}
