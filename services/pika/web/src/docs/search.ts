import type { DocsData } from "./types";

export interface DocSearchResult {
	title: string;
	href: string;
	description: string;
	kind: "command" | "page" | "heading";
	context?: string;
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

function excerpt(text: string, terms: string[]): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return "";
	const lower = clean.toLowerCase();
	const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
	let start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 55);
	if (start > 0) {
		const nextSpace = clean.indexOf(" ", start);
		if (nextSpace >= 0 && nextSpace - start < 24) start = nextSpace + 1;
	}
	let end = Math.min(clean.length, start + 190);
	if (end < clean.length) {
		const lastSpace = clean.lastIndexOf(" ", end);
		if (lastSpace > start + 80) end = lastSpace;
	}
	return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}

/** Deterministic, entirely local search. Every query term must occur in a result's indexed text. */
export function searchDocs(data: DocsData, query: string): DocSearchResult[] {
	const normalized = normalize(query.slice(0, 256));
	if (!normalized) return [];
	const terms = normalized.split(" ");
	const matches = (text: string) => terms.every((term) => normalize(text).includes(term));
	const ranked: { result: DocSearchResult; score: number }[] = [];
	for (const command of data.commands) {
		const extensionSlug = command.slug.split("#")[0];
		const extensionTitle = data.pages.find((page) => page.slug === extensionSlug)?.title ?? command.extension;
		if (!matches(`${command.command} ${command.extension} ${extensionTitle} ${command.description}`)) continue;
		const title = normalize(command.command);
		ranked.push({ score: title === normalized ? 120 : title.startsWith(normalized) ? 100 : matches(title) ? 85 : 55,
			result: { title: command.command, href: `/docs/${command.slug}`, description: command.description, kind: "command", context: extensionTitle } });
	}
	for (const page of data.pages) {
		const title = normalize(page.title);
		if (matches(`${page.title} ${page.description} ${page.searchText}`)) {
			const bodyText = page.searchText.includes("\n") ? page.searchText.split("\n").slice(2).join(" ") : page.searchText;
			ranked.push({ score: title === normalized ? 115 : title.startsWith(normalized) ? 95 : matches(title) ? 80 : 20,
				result: { title: page.title, href: `/docs/${page.slug}`, description: matches(`${page.title} ${page.description}`) ? page.description : excerpt(bodyText || page.searchText, terms), kind: "page", context: page.section } });
		}
		for (const heading of page.headings) {
			const headingTitle = normalize(heading.title);
			if (!terms.some((term) => headingTitle.includes(term)) || !matches(`${page.title} ${heading.title}`)) continue;
			ranked.push({ score: headingTitle === normalized ? 90 : headingTitle.startsWith(normalized) ? 75 : 65,
				result: { title: heading.title, href: `/docs/${page.slug}#${encodeURIComponent(heading.id)}`, description: page.description, kind: "heading", context: page.title } });
		}
	}
	return ranked.sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title)).map(({ result }) => result);
}
