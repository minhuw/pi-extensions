import GithubSlugger from "github-slugger";
import type { Heading, Root, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import type { DocHeading } from "./types";

/** Visible inline text, including code and image alt text, without Markdown delimiters. */
export function headingText(heading: Heading): string {
	return toString(heading);
}

function visitHeadings(node: Root | RootContent, visit: (heading: Heading) => void): void {
	if (node.type === "heading") visit(node);
	if ("children" in node) {
		for (const child of node.children) visitHeadings(child, visit);
	}
}

/** Shared by ReactMarkdown and the build-time index. Each document gets a fresh slugger. */
export function remarkDocHeadings() {
	return (tree: Root): Root => {
		const slugger = new GithubSlugger();
		visitHeadings(tree, (heading) => {
			heading.data ??= {};
			heading.data.hProperties = {
				...heading.data.hProperties,
				id: slugger.slug(headingText(heading)),
			};
		});
		return tree;
	};
}

/** Run remarkDocHeadings first; the table of contents includes only h2/h3. */
export function extractDocHeadings(tree: Root): DocHeading[] {
	const headings: DocHeading[] = [];
	visitHeadings(tree, (heading) => {
		if (heading.depth === 2 || heading.depth === 3) {
			headings.push({
				id: String(heading.data?.hProperties?.id ?? ""),
				title: headingText(heading),
				depth: heading.depth,
			});
		}
	});
	return headings;
}
