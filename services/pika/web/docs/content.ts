import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { extractDocHeadings, remarkDocHeadings } from "../src/docs/markdown";
import type { DocsData } from "../src/docs/types";
import { DOC_COMMANDS, DOC_SOURCES } from "./sources";

// Relative to this module, even when Vite is launched from another working directory.
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const sourcePaths = DOC_SOURCES.map(({ source }) => resolve(repositoryRoot, source));

function extractSearchText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const record = node as { type?: string; depth?: number; children?: unknown[] };
	if (record.type === "heading" && record.depth === 1) return "";
	if (Array.isArray(record.children) && ["root", "table", "tableRow", "list", "listItem", "blockquote"].includes(record.type ?? "")) {
		return record.children.map(extractSearchText).filter(Boolean).join(" ");
	}
	return toString(node).replace(/\s+/g, " ").trim();
}

export async function loadDocsData(): Promise<DocsData> {
	const root = await realpath(repositoryRoot);
	const processor = unified().use(remarkParse).use(remarkGfm).use(remarkDocHeadings);
	const pages = await Promise.all(DOC_SOURCES.map(async (source, index) => {
		const path = sourcePaths[index];
		// A whitelisted name must not redirect publication to a different file via a symlink.
		if (await realpath(path) !== resolve(root, source.source)) {
			throw new Error(`Documentation source must not be a symlink: ${source.source}`);
		}
		const markdown = await readFile(path, "utf8");
		const tree = processor.runSync(processor.parse(markdown));
		return {
			...source,
			markdown,
			headings: extractDocHeadings(tree),
			searchText: `${source.title}\n${source.description}\n${extractSearchText(tree)}`,
		};
	}));
	return {
		pages,
		commands: DOC_COMMANDS,
		groups: ["Getting started", "Reference", "Guides", "pika", "Development"].map((title) => ({
			title,
			items: pages.filter((page) => page.section === title).map(({ title, slug }) => ({ title, slug })),
		})),
	};
}
