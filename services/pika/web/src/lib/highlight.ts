// highlight.js core and a few grammars, loaded on first use in a separate chunk.

type Highlighter = (code: string, language: string) => string | null;

let loader: Promise<Highlighter> | null = null;

export function loadHighlighter(): Promise<Highlighter> {
	loader ??= import("./highlight-languages").then(({ default: hljs }) => (code: string, language: string) => {
		if (!hljs.getLanguage(language)) return null;
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	});
	return loader;
}

const EXTENSIONS: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonl: "json",
	py: "python",
	rs: "rust",
	go: "go",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	fish: "bash",
	css: "css",
	html: "xml",
	xml: "xml",
	svg: "xml",
	md: "markdown",
	markdown: "markdown",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	sql: "sql",
	diff: "diff",
	patch: "diff",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	java: "java",
	rb: "ruby",
	dockerfile: "dockerfile",
};

const ALIASES: Record<string, string> = {
	js: "javascript",
	ts: "typescript",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	console: "bash",
	py: "python",
	rs: "rust",
	yml: "yaml",
	html: "xml",
	toml: "ini",
	jsonc: "json",
	md: "markdown",
};

export function languageForPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	if (name === "dockerfile") return "dockerfile";
	const ext = name.includes(".") ? name.split(".").pop() : undefined;
	return ext ? EXTENSIONS[ext] : undefined;
}

export function normalizeLanguage(language: string | undefined): string | undefined {
	if (!language) return undefined;
	const lower = language.toLowerCase();
	return ALIASES[lower] ?? lower;
}
