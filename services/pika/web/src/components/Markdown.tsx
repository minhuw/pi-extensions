import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code";
import { cx } from "./ui";

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
	img: ({ src, alt }) => <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="max-w-full rounded-md" />,
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
	return (
		<div className={cx("prose-pika", className)}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
});
