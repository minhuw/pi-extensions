import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { createServer } from "vite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadDocsData, repositoryRoot, sourcePaths } from "../docs/content";
import { docsContent, DOCS_MODULE_ID } from "../docs/plugin";
import { DOC_SOURCES } from "../docs/sources";
import { resolveDocHref, resolveDocImage, sourceHref } from "../src/docs/links";
import { extractDocHeadings, remarkDocHeadings } from "../src/docs/markdown";
import type { DocPage, DocsData } from "../src/docs/types";

const destinations: DocPage[] = DOC_SOURCES.map((source) => ({ ...source, markdown: "", searchText: "", headings: [] }));

function parse(markdown: string) {
	const processor = unified().use(remarkParse).use(remarkGfm).use(remarkDocHeadings);
	return processor.runSync(processor.parse(markdown));
}

describe("shared Markdown heading anchors", () => {
	it("counts h1 and all heading depths for stable duplicate IDs, retaining only h2/h3 in the index", () => {
		const markdown = "# Repeat\n\n## Repeat\n\n### Repeat\n\n#### Repeat\n\n## Repeat\n\n```md\n## Not a heading\n```\n";
		expect(extractDocHeadings(parse(markdown))).toEqual([
			{ id: "repeat-1", title: "Repeat", depth: 2 },
			{ id: "repeat-2", title: "Repeat", depth: 3 },
			{ id: "repeat-4", title: "Repeat", depth: 2 },
		]);
		expect(extractDocHeadings(parse(markdown))[0].id).toBe("repeat-1");
		const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkDocHeadings], children: markdown }));
		expect(html).toContain('<h1 id="repeat">Repeat</h1>');
		for (const heading of extractDocHeadings(parse(markdown))) expect(html).toContain(`id="${heading.id}"`);
		expect(html).not.toContain('id="not-a-heading"');
	});

	it("uses visible Unicode, inline code, links, emphasis, and escaped punctuation", () => {
		const markdown = "## Café `CLI` & *中文* [link](https://example.com)\n\n## Use \\*stars\\*\n\nSetext `code`\n--------------\n";
		expect(extractDocHeadings(parse(markdown))).toEqual([
			{ id: "café-cli--中文-link", title: "Café CLI & 中文 link", depth: 2 },
			{ id: "use-stars", title: "Use *stars*", depth: 2 },
			{ id: "setext-code", title: "Setext code", depth: 2 },
		]);
	});
});

describe("documentation links", () => {
	const source = "extensions/pika/README.md";
	it.each([
		["../../services/pika/README.md?view=full#configuration", "/docs/pika?view=full#configuration"],
		["../../README.md#install", "/docs/overview#install"],
		["../herder/README.md#audits", "/docs/extensions/herder#audits"],
		["../herder/", "/docs/extensions/herder"],
		["../herder", "/docs/extensions/herder"],
		["/docs/guides/code-review.md", "/docs/guides/code-review"],
		["../../docs/%69nstallation.md#install", "/docs/installation#install"],
		["#log-in", "#log-in"],
		["?view=full#log-in", "/docs/extensions/pika?view=full#log-in"],
		["https://example.com/README.md?q=1#x", "https://example.com/README.md?q=1#x"],
		["http://example.com", "http://example.com"],
		["mailto:hello@example.com", "mailto:hello@example.com"],
		["../../services/pika/docs/SPEC.md#api", "https://github.com/minhuw/pi-extensions/blob/master/services/pika/docs/SPEC.md#api"],
		["../../themes/", "https://github.com/minhuw/pi-extensions/tree/master/themes"],
		["./a%20file.md", "https://github.com/minhuw/pi-extensions/blob/master/extensions/pika/a%20file.md"],
	])("resolves %s", (href, expected) => {
		expect(resolveDocHref(href, source, destinations)).toBe(expected);
	});

	it.each(["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "custom:open", "//evil.example/path", "java\nscript:alert(1)", "..\\secret", "../../../secret", "../../%2e%2e/secret", "%ZZ"])("rejects unsafe or escaping targets: %s", (href) => {
		expect(resolveDocHref(href, source, destinations)).toBe("");
		expect(resolveDocImage(href, source)).toBe("");
	});

	it("leaves basename application to React Router", async () => {
		const { MemoryRouter, Link } = await import("react-router");
		const destination = resolveDocHref("../herder/README.md", source, destinations);
		expect(destination).toBe("/docs/extensions/herder");
		const html = renderToStaticMarkup(createElement(MemoryRouter, { basename: "/research/pika", initialEntries: ["/research/pika/docs"] }, createElement(Link, { to: destination }, "Herder")));
		expect(html).toContain('href="/research/pika/docs/extensions/herder"');
	});

	it("links sources and relative images to the public repository", () => {
		expect(sourceHref(source)).toBe("https://github.com/minhuw/pi-extensions/blob/master/extensions/pika/README.md");
		expect(resolveDocImage("../../images/pi%20logo.png?raw=1#x", source)).toBe("https://raw.githubusercontent.com/minhuw/pi-extensions/master/images/pi%20logo.png?raw=1#x");
		expect(resolveDocImage("https://example.com/pi.png", source)).toBe("https://example.com/pi.png");
		expect(resolveDocImage("mailto:hello@example.com", source)).toBe("");
	});
});

describe("published documentation content", () => {
	let data: DocsData;
	beforeAll(async () => { data = await loadDocsData(); });

	it("includes exactly the 17 extension READMEs and eight other approved sources", () => {
		const names = ["commit", "recap", "quality", "writer", "impeccable", "subagents", "herder", "orca-bridge", "autoresearch", "benchmark", "loop", "molt", "language", "workspace", "statusline-footer", "pika", "magpie-provider"];
		expect(data.pages.map((page) => page.source).sort()).toEqual([
			"README.md", ...names.map((name) => `extensions/${name}/README.md`),
			"services/pika/README.md", "docs/installation.md", "docs/configuration.md", "docs/development.md",
			"docs/guides/performance.md", "docs/guides/delegation.md", "docs/guides/code-review.md",
		].sort());
		expect(new Set(data.pages.map((page) => page.slug)).size).toBe(25);
		for (const page of data.pages) {
			expect(page.slug).not.toBe("");
			expect(page.title).toBeTruthy();
			expect(page.description).toBeTruthy();
			expect(page.searchText).toContain(page.title);
		}
	});

	it("retains canonical source bytes and derives headings from the same parser as the UI", async () => {
		for (const [index, page] of data.pages.entries()) {
			expect(page.markdown).toBe(await readFile(sourcePaths[index], "utf8"));
			expect(page.headings).toEqual(extractDocHeadings(parse(page.markdown)));
			expect(new Set(page.headings.map((heading) => heading.id)).size).toBe(page.headings.length);
		}
	});

	it("links every navigation item and real command to a published destination", async () => {
		const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as { pi: { prompts: string[] } };
		const registeredPrompts = new Map(manifest.pi.prompts.map((path) => [`/${basename(path, ".md")}`, path]));
		expect(data.commands.map((command) => command.command)).toEqual(expect.arrayContaining([...registeredPrompts.keys()]));
		expect(data.groups.map((group) => group.title)).toEqual(["Getting started", "Reference", "Guides", "pika", "Development"]);
		expect(data.groups.find((group) => group.title === "Reference")?.items).toHaveLength(17);
		expect(data.groups.find((group) => group.title === "Guides")?.items).toHaveLength(3);
		expect(data.groups.flatMap((group) => group.items.map((item) => item.slug)).sort()).toEqual(data.pages.map((page) => page.slug).sort());
		expect(data.commands.map((command) => command.command)).toEqual(expect.arrayContaining(["/commit", "/review", "/herder", "/benchmark", "/autoresearch"]));
		for (const command of data.commands) {
			const [slug, hash] = command.slug.split("#");
			const page = data.pages.find((page) => page.slug === slug);
			expect(page, command.command).toBeDefined();
			const promptPath = registeredPrompts.get(command.command);
			if (promptPath) {
				expect(promptPath).toContain(`extensions/${command.extension}/prompts/`);
				expect(await readFile(resolve(repositoryRoot, promptPath), "utf8")).toContain("description:");
			} else {
				expect(page!.markdown, command.command).toContain(command.command);
			}
			expect(slug).toBe(`extensions/${command.extension}`);
			if (hash) expect(page!.headings.some((heading) => heading.id === hash)).toBe(true);
		}
	});

	it("serves only serialized data and reloads for changes to explicit sources", async () => {
		const server = await createServer({ configFile: false, plugins: [docsContent()], server: { middlewareMode: true, watch: null } });
		try {
			const result = await server.transformRequest(DOCS_MODULE_ID);
			expect(result?.code).toContain('"slug":"overview"');
			expect(result?.code).not.toContain('from "node:fs');
			const send = vi.spyOn(server.ws, "send");
			for (const event of ["change", "add", "unlink"]) server.watcher.emit("all", event, sourcePaths[0]);
			expect(send).toHaveBeenCalledTimes(3);
			expect(send).toHaveBeenLastCalledWith({ type: "full-reload", path: "*" });
			server.watcher.emit("all", "change", sourcePaths[0].replace("README.md", ".env"));
			expect(send).toHaveBeenCalledTimes(3);
		} finally {
			await server.close();
		}
	});
});
