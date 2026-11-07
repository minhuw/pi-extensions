import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import docsData from "virtual:pi-docs";
import { Icon } from "../components/icons";
import { useTheme } from "../lib/theme";
import { DocCode, DocMarkdown } from "../docs/DocMarkdown";
import { sourceHref } from "../docs/links";
import { searchDocs } from "../docs/search";
import type { DocCommand, DocHeading, DocPage } from "../docs/types";
import "../docs/docs.css";

const repository = "https://github.com/minhuw/pi-extensions";
const homeHeadings: DocHeading[] = [
	{ id: "commands", title: "Commands", depth: 2 },
	{ id: "performance", title: "Performance", depth: 2 },
	{ id: "related-guides", title: "Related guides", depth: 2 },
	{ id: "extensions", title: "Extensions", depth: 2 },
];
const noHeadings: DocHeading[] = [];
const featured = ["/commit", "/review", "/herder", "/benchmark", "/autoresearch", "/loop"];
const featuredDescriptions: Record<string, string> = {
	"/commit": "Commit changes as self-contained patches",
	"/review": "Find bugs without changing code",
	"/simplify": "Remove dead code and simplify complex paths",
	"/verify": "Run build and test checks before finishing",
	"/herder": "Run a task in isolated worktrees",
	"/benchmark": "Measure a performance claim",
	"/autoresearch": "Optimize through approved experiments",
	"/loop": "Schedule recurring prompts in the current session",
	"/recap": "Summarize session progress and next steps",
};

type CommandCategory = "featured" | "quality" | "delegation" | "performance" | "runtime" | "writing" | "design";
const commandCategories: { id: CommandCategory; label: string; match: (cmd: DocCommand) => boolean }[] = [
	{ id: "featured", label: "Essential", match: (cmd) => featured.includes(cmd.command) },
	{ id: "quality", label: "Quality & Git", match: (cmd) => ["commit", "quality"].includes(cmd.extension) },
	{ id: "delegation", label: "Delegation", match: (cmd) => ["herder", "subagents"].includes(cmd.extension) },
	{ id: "performance", label: "Performance", match: (cmd) => ["benchmark", "autoresearch"].includes(cmd.extension) },
	{ id: "runtime", label: "Runtime & Pika", match: (cmd) => ["loop", "molt", "language", "recap", "pika", "orca-bridge", "statusline-footer", "magpie-provider"].includes(cmd.extension) },
	{ id: "writing", label: "Writing", match: (cmd) => cmd.extension === "writer" },
	{ id: "design", label: "Design", match: (cmd) => cmd.extension === "impeccable" },
];

const guides = docsData.pages.filter((page) => page.section === "Guides");
const extensions = docsData.pages.filter((page) => page.section === "Reference");
const pageHref = (slug: string) => `/docs/${slug}`;

function PageList({ pages }: { pages: DocPage[] }) {
	return <ul className="docs-page-list">{pages.map((page) => <li key={page.slug}>
		<Link to={pageHref(page.slug)}>{page.title}</Link><p>{page.description}</p>
	</li>)}</ul>;
}

function CommandTable({ commands, preview = false }: { commands: DocCommand[]; preview?: boolean }) {
	return <div className="docs-table-scroll" role="region" aria-label="Command index" tabIndex={0}>
		<table className="docs-command-table"><thead><tr><th scope="col">Command</th><th scope="col">Extension</th><th scope="col">Purpose</th></tr></thead>
			<tbody>{commands.map((command) => {
				const extensionSlug = command.slug.split("#")[0];
				const extensionTitle = docsData.pages.find((page) => page.slug === extensionSlug)?.title ?? command.extension;
				return <tr key={command.command}>
					<td><Link to={pageHref(command.slug)}><code>{command.command}</code></Link><span className="docs-command-owner"><Link to={pageHref(extensionSlug)}>{extensionTitle}</Link></span></td>
					<td><Link to={pageHref(extensionSlug)}>{extensionTitle}</Link></td>
					<td>{preview ? featuredDescriptions[command.command] ?? command.description : command.description}</td>
				</tr>;
			})}</tbody>
		</table>
	</div>;
}

function ReferenceHome() {
	const [category, setCategory] = useState<CommandCategory>("featured");
	const visibleCommands = useMemo(() => {
		if (category === "featured") {
			return featured.flatMap((name) => docsData.commands.filter((command) => command.command === name));
		}
		const active = commandCategories.find((item) => item.id === category);
		return active ? docsData.commands.filter(active.match) : docsData.commands;
	}, [category]);

	return <>
		<div className="docs-page-head">
			<h1>Reference</h1>
			<p className="docs-intro">Commands, configuration, and guides for your Pi workspace.</p>
		</div>
		<section id="commands">
			<div className="docs-section-head">
				<h2>Commands</h2>
				<div className="docs-section-links">
					<Link to="/docs/configuration">Configuration reference</Link>
					<Link to="/docs/commands">All commands ({docsData.commands.length})</Link>
				</div>
			</div>
			<div className="docs-filter-strip" role="toolbar" aria-label="Filter commands by category">
				{commandCategories.map((item) => <button
					key={item.id}
					type="button"
					className="docs-filter-chip"
					aria-pressed={category === item.id}
					onClick={() => setCategory(item.id)}
				>{item.label}</button>)}
			</div>
			<CommandTable commands={visibleCommands} preview={category === "featured"} />
		</section>
		<section className="docs-performance" id="performance">
			<div className="docs-section-head">
				<h2>Performance</h2>
				<Link to="/docs/extensions/benchmark">Read the Benchmark reference</Link>
			</div>
			<p>Compare two implementations with alternating runs. Get medians, ranges, and a verdict on the measured difference.</p>
			<DocCode code="/benchmark the new parser against main on the large fixture" />
			<div className="docs-example-footer"><span>Benchmark · Example usage</span><Link to="/docs/guides/performance">Performance workflow guide</Link></div>
		</section>
		<section className="docs-related-guides" id="related-guides">
			<div className="docs-section-head">
				<h2>Related guides</h2>
				<Link to="/docs/guides">All guides</Link>
			</div>
			<div className="docs-guide-strip">
				{guides.map((page) => <div key={page.slug} className="docs-guide-item">
					<Link to={pageHref(page.slug)}>{page.title}</Link>
					<p>{page.description}</p>
				</div>)}
			</div>
		</section>
		<section className="docs-extensions" id="extensions">
			<div className="docs-section-head">
				<h2>Extensions</h2>
				<Link to="/docs/overview">About the collection</Link>
			</div>
			<PageList pages={extensions} />
		</section>
	</>;
}

function SearchPage() {
	const [params, setParams] = useSearchParams();
	const query = (params.get("q") ?? "").slice(0, 256);
	const results = useMemo(() => searchDocs(docsData, query), [query]);
	return <>
		<div className="docs-page-head">
			<h1>Search documentation</h1>
			<p className="docs-intro">Find commands, reference pages, and sections across the collection.</p>
		</div>
		<label className="docs-search-label" htmlFor="docs-content-search">Search documentation content</label>
		<input className="docs-content-search" id="docs-content-search" type="search" maxLength={256} value={query} placeholder="Try /benchmark or configuration" onChange={(event) => {
			const next = new URLSearchParams(params);
			if (event.target.value) next.set("q", event.target.value.slice(0, 256)); else next.delete("q");
			setParams(next, { replace: true });
		}} />
		<p className="docs-search-count" aria-live="polite" aria-atomic="true">{query.trim() ? `${results.length} ${results.length === 1 ? "result" : "results"} for “${query}”` : "Search the published documentation in your browser."}</p>
		{!query.trim() ? <><h2>Browse documentation</h2><BrowseLinks /><PageList pages={guides} /></> : results.length ? <ul className="docs-search-results">{results.map((result) => {
			const kindLabel = result.kind === "command" ? "Command" : result.kind === "heading" ? "Section" : "Reference";
			const contextLabel = result.context && result.context !== kindLabel ? `${kindLabel} · ${result.context}` : kindLabel;
			return <li key={`${result.kind}:${result.href}`}>
				<Link to={result.href}><span className="docs-result-title">{result.title}</span><span className="docs-result-context">{contextLabel}</span><span className="docs-result-description">{result.description}</span></Link>
			</li>;
		})}</ul> : <div className="docs-empty"><h2>No results</h2><p>Try a shorter phrase, an extension name, or a command such as <code>/review</code>.</p><BrowseLinks /></div>}
	</>;
}

function BrowseLinks() {
	return <ul className="docs-browse-links"><li><Link to="/docs">Reference overview</Link></li><li><Link to="/docs/commands">All commands</Link></li><li><Link to="/docs/guides">Guides</Link></li><li><Link to="/docs/configuration">Configuration</Link></li></ul>;
}

function Contents({ headings, active, label }: { headings: DocHeading[]; active: string; label: string }) {
	return <nav aria-label={label} className="docs-contents-links">{headings.map((heading) => <Link key={heading.id} to={`#${encodeURIComponent(heading.id)}`} className={heading.depth === 3 ? "docs-contents-nested" : undefined} aria-current={active === heading.id ? "location" : undefined}>{heading.title}</Link>)}</nav>;
}

function ArticleFooter({ page }: { page: DocPage }) {
	const group = docsData.pages.filter((candidate) => candidate.section === page.section);
	const index = group.findIndex((candidate) => candidate.slug === page.slug);
	const previous = group[index - 1];
	const next = group[index + 1];
	return <footer className="docs-article-footer">
		<a href={sourceHref(page.source)} rel="noreferrer">View source on GitHub <Icon name="external" size={14} /></a>
		<nav aria-label="Adjacent documentation">{previous && <Link to={pageHref(previous.slug)}><span>Previous</span>{previous.title}</Link>}{next && <Link className="docs-next" to={pageHref(next.slug)}><span>Next</span>{next.title}</Link>}</nav>
	</footer>;
}

const marginReferenceLinks = [
	{ slug: "commands", to: "/docs/commands", label: "All commands" },
	{ slug: "installation", to: "/docs/installation", label: "Installation" },
	{ slug: "configuration", to: "/docs/configuration", label: "Configuration" },
	{ slug: "guides/performance", to: "/docs/guides/performance", label: "Performance guide" },
	{ slug: "guides/delegation", to: "/docs/guides/delegation", label: "Delegation guide" },
];

export function DocsPage() {
	const slug = (useParams()["*"] ?? "").replace(/\/+$/, "");
	const location = useLocation();
	const navigate = useNavigate();
	const { theme, toggle } = useTheme();
	const [menuOpen, setMenuOpen] = useState(false);
	const [headerQuery, setHeaderQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const articleRef = useRef<HTMLElement>(null);
	const page = docsData.pages.find((candidate) => candidate.slug === slug);
	const title = page?.title ?? ({ "": "Reference", search: "Search documentation", commands: "All commands", guides: "Guides" }[slug] ?? "Page not found");
	const headings = page?.headings ?? (slug === "" ? homeHeadings : noHeadings);
	const [active, setActive] = useState("");
	const titleBeforeDocs = useRef<string | undefined>(undefined);

	useEffect(() => {
		titleBeforeDocs.current = document.title;
		return () => { if (titleBeforeDocs.current !== undefined) document.title = titleBeforeDocs.current; };
	}, []);
	useEffect(() => { document.title = `${title} · Pi extensions`; }, [title]);
	useEffect(() => {
		setHeaderQuery(new URLSearchParams(location.search).get("q")?.slice(0, 256) ?? "");
	}, [location.search]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target instanceof HTMLElement ? event.target : null;
			if (event.defaultPrevented || event.isComposing || target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
			if ((event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) || (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey) && !event.altKey)) {
				event.preventDefault();
				if (searchRef.current && getComputedStyle(searchRef.current).display !== "none" && getComputedStyle(searchRef.current.parentElement!).display !== "none") searchRef.current.focus();
				else if (slug === "search") document.getElementById("docs-content-search")?.focus();
				else navigate("/docs/search");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [navigate, slug]);
	useEffect(() => {
		setMenuOpen(false);
		let fragment = location.hash.slice(1);
		try { fragment = decodeURIComponent(fragment); } catch { /* Malformed fragments remain literal. */ }
		const target = fragment ? document.getElementById(fragment) : null;
		if (target && articleRef.current?.contains(target)) {
			target.setAttribute("tabindex", "-1");
			target.focus({ preventScroll: true });
			target.scrollIntoView?.({ block: "start" });
		} else {
			articleRef.current?.focus({ preventScroll: true });
			(document.scrollingElement ?? document.documentElement).scrollTop = 0;
			if (slug === "search") document.getElementById("docs-content-search")?.focus({ preventScroll: true });
		}
	}, [location.pathname, location.hash, slug]);
	useEffect(() => {
		const update = () => {
			let current = headings[0]?.id ?? "";
			for (const heading of headings) {
				const element = document.getElementById(heading.id);
				if (element && element.getBoundingClientRect().top <= 140) current = heading.id;
			}
			setActive(current);
		};
		update();
		window.addEventListener("scroll", update, { passive: true });
		window.addEventListener("resize", update);
		return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
	}, [headings]);

	return <div className="docs-app">
		<a className="docs-skip" href="#docs-main">Skip to documentation</a>
		<header className="docs-masthead">
			<Link className="docs-wordmark" to="/docs">Pi <span>extensions</span></Link>
			<nav className="docs-tabs" aria-label="Documentation sections">
				<Link to="/docs" aria-current={slug !== "pika" && slug !== "commands" && !slug.startsWith("guides") ? "page" : undefined}>Reference</Link>
				<Link to="/docs/guides" aria-current={slug.startsWith("guides") ? "page" : undefined}>Guides</Link>
				<Link to="/docs/commands" aria-current={slug === "commands" ? "page" : undefined}>Commands</Link>
				<Link to="/docs/pika" aria-current={slug === "pika" ? "page" : undefined}>Deploy</Link>
			</nav>
			<form className={`docs-header-search${slug === "search" ? " docs-header-search-hidden" : ""}`} role="search" onSubmit={(event) => { event.preventDefault(); navigate(`/docs/search${headerQuery.trim() ? `?q=${encodeURIComponent(headerQuery.trim().slice(0, 256))}` : ""}`); }}>
				<input ref={searchRef} type="search" aria-label="Search documentation" placeholder="Search documentation (/)" maxLength={256} value={headerQuery} onChange={(event) => setHeaderQuery(event.target.value)} />
			</form>
			<Link className="docs-search-toggle docs-icon-button" to="/docs/search" aria-label="Search documentation"><Icon name="search" size={18} /></Link>
			<a className="docs-github" href={repository} rel="noreferrer">GitHub</a>
			<button className="docs-icon-button docs-theme" type="button" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}><Icon name={theme === "dark" ? "sun" : "moon"} size={17} /></button>
			<button className="docs-menu-toggle docs-icon-button" type="button" aria-label="Browse documentation" aria-expanded={menuOpen} aria-controls="docs-directory" onClick={() => setMenuOpen(!menuOpen)}><Icon name="sidebar" size={18} /></button>
		</header>
		<div className="docs-layout">
			<aside id="docs-directory" className={`docs-directory${menuOpen ? " docs-directory-open" : ""}`} aria-label="Documentation navigation">
				<nav>{docsData.groups.map((group) => <section key={group.title}><h2>{group.title}</h2>
					{group.title === "Reference" && <><NavLink to="/docs" end>Overview</NavLink><NavLink to="/docs/commands">All commands</NavLink></>}
					{group.items.map((item) => <NavLink key={item.slug} to={pageHref(item.slug)} end>{item.slug === "overview" ? "About the collection" : item.title}</NavLink>)}
				</section>)}</nav>
			</aside>
			<div className="docs-sheet">
				<main className="docs-main" id="docs-main" tabIndex={-1} ref={articleRef}>
					{headings.length > 0 && <details className="docs-mobile-contents" key={slug}><summary>On this page</summary><Contents headings={headings} active={active} label="On this page, compact view" /></details>}
					{page ? <><DocMarkdown key={page.slug} page={page} pages={docsData.pages} /><ArticleFooter page={page} /></> : slug === "" ? <ReferenceHome /> : slug === "search" ? <SearchPage /> : slug === "commands" ? <><div className="docs-page-head"><h1>All commands</h1><p className="docs-intro">Browse commands and open their extension references for usage and options.</p></div><p className="docs-command-search"><Link to="/docs/search">Search commands and documentation</Link></p><CommandTable commands={docsData.commands} /></> : slug === "guides" ? <><div className="docs-page-head"><h1>Guides</h1><p className="docs-intro">Choose the right tools for performance work, delegation, and code review.</p></div><PageList pages={guides} /></> : <><div className="docs-page-head"><h1>Page not found</h1><p className="docs-intro">This documentation page could not be found. Browse the reference or search for a command or topic.</p></div><p><Link to={`/docs/search?q=${encodeURIComponent(slug.slice(0, 256))}`}>Search documentation</Link></p><BrowseLinks /></>}
				</main>
				<aside className="docs-margin" aria-label="Page reference">
					{headings.length > 0 && <><h2>On this page</h2><Contents headings={headings} active={active} label="On this page" /></>}
					<section>
						<h2>Quick reference</h2>
						{marginReferenceLinks.filter((item) => item.slug !== slug).slice(0, 4).map((item) => <Link key={item.slug} to={item.to}>{item.label}</Link>)}
					</section>
				</aside>
			</div>
		</div>
	</div>;
}
