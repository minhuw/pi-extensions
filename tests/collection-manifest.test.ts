import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const extensionsRoot = path.join(repoRoot, "extensions");
const docSourcesPath = path.join(repoRoot, "services/pika/web/docs/sources.ts");

interface RootManifest {
	scripts: Record<string, string>;
	pi: {
		extensions: string[];
		prompts: string[];
		skills: string[];
		themes: string[];
	};
}

function readManifest(): RootManifest {
	return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as RootManifest;
}

function listExtensionDirs(): string[] {
	return readdirSync(extensionsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort();
}

function normalizeRepoRelative(entry: string): string {
	return path.relative(repoRoot, path.resolve(repoRoot, entry)).replaceAll("\\", "/");
}

function collectTestedExtensions(
	command: string,
	scripts: Record<string, string>,
	missingScripts: string[],
	visited = new Set<string>(),
): Set<string> {
	const covered = new Set<string>();

	for (const rawStep of command.split("&&")) {
		const step = rawStep.trim();
		if (!step) continue;

		const npmRunMatch = step.match(/^npm\s+run\s+([^\s]+)$/);
		if (npmRunMatch) {
			const scriptName = npmRunMatch[1]!;
			const targetScript = scripts[scriptName];
			if (!targetScript) {
				missingScripts.push(scriptName);
				continue;
			}
			if (visited.has(scriptName)) continue;
			visited.add(scriptName);
			for (const ext of collectTestedExtensions(targetScript, scripts, missingScripts, visited)) {
				covered.add(ext);
			}
			continue;
		}

		for (const token of step.split(/\s+/)) {
			const stripped = token.replace(/^['"]|['"]$/g, "");
			const match = stripped.match(/(?:^|=)(?:\.\/)?extensions\/([^/\s]+)(?:\/|$)/);
			if (match) {
				covered.add(match[1]!);
			}
		}
	}

	return covered;
}

function extractReadmeLinkedExtensions(markdown: string): Set<string> {
	const linked = new Set<string>();
	const linkPattern = /\]\((?:\.\/)?extensions\/([^/#?)\s]+)(?:\/README\.md|\/)?(?:#[^)\s]*)?\)/g;
	for (const match of markdown.matchAll(linkPattern)) {
		linked.add(match[1]!);
	}
	return linked;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
	while (
		ts.isAsExpression(expr) ||
		ts.isSatisfiesExpression(expr) ||
		ts.isParenthesizedExpression(expr)
	) {
		expr = expr.expression;
	}
	return expr;
}

function getStringLiteralValue(node: ts.Node | undefined): string | null {
	if (!node) return null;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return node.text;
	}
	return null;
}

function extractPublishedDocExtensions(filePath: string): Set<string> {
	const sourceText = readFileSync(filePath, "utf8");
	const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

	const tupleArrays = new Map<string, string[]>();
	let docSourcesInit: ts.ArrayLiteralExpression | undefined;

	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const decl of statement.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
			const init = unwrapExpression(decl.initializer);
			if (!ts.isArrayLiteralExpression(init)) continue;

			if (decl.name.text === "DOC_SOURCES") {
				docSourcesInit = init;
			} else {
				const firstElements: string[] = [];
				for (const elem of init.elements) {
					const unwrapped = unwrapExpression(elem);
					if (!ts.isArrayLiteralExpression(unwrapped) || unwrapped.elements.length === 0) continue;
					const first = getStringLiteralValue(unwrapped.elements[0]);
					if (first !== null) firstElements.push(first);
				}
				if (firstElements.length > 0) {
					tupleArrays.set(decl.name.text, firstElements);
				}
			}
		}
	}

	if (!docSourcesInit) {
		throw new Error(`Could not find DOC_SOURCES array literal in ${filePath}`);
	}

	const published = new Set<string>();
	const extensionSourcePattern = /^(?:\.\/)?extensions\/([^/]+)(?:\/|$)/;

	for (const elem of docSourcesInit.elements) {
		if (ts.isObjectLiteralExpression(elem)) {
			for (const prop of elem.properties) {
				if (!ts.isPropertyAssignment(prop)) continue;
				const propName = ts.isIdentifier(prop.name)
					? prop.name.text
					: getStringLiteralValue(prop.name);
				if (propName !== "source") continue;
				const sourceValue = getStringLiteralValue(unwrapExpression(prop.initializer));
				const match = sourceValue?.match(extensionSourcePattern);
				if (match) published.add(match[1]!);
			}
		} else if (ts.isSpreadElement(elem)) {
			const spreadExpr = unwrapExpression(elem.expression);
			if (
				ts.isCallExpression(spreadExpr) &&
				ts.isPropertyAccessExpression(spreadExpr.expression) &&
				spreadExpr.expression.name.text === "map" &&
				ts.isIdentifier(spreadExpr.expression.expression) &&
				spreadExpr.arguments[0]?.getText(sourceFile).includes("extensions/")
			) {
				const entries = tupleArrays.get(spreadExpr.expression.expression.text);
				if (entries) {
					for (const dir of entries) {
						published.add(dir);
					}
				}
			}
		}
	}

	return published;
}

function extractAgentsLayoutSection(markdown: string): string {
	const normalized = markdown.replaceAll("\r\n", "\n");
	const headingMatch = /^## Layout[ \t]*$/m.exec(normalized);
	if (!headingMatch) {
		throw new Error("Could not find '## Layout' section in AGENTS.md");
	}
	const bodyStart = headingMatch.index + headingMatch[0].length;
	const rest = normalized.slice(bodyStart);
	const nextHeadingMatch = /^## /m.exec(rest);
	return nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
}

function extractAgentsLayoutExtensions(layoutSection: string): Set<string> {
	const listed = new Set<string>();
	const itemPattern = /^\s*-\s+`(?:\.\/)?extensions\/([^/`\s]+)\/?`/gm;
	for (const match of layoutSection.matchAll(itemPattern)) {
		listed.add(match[1]!);
	}
	return listed;
}

describe("collection manifest contracts", () => {
	it("points every package.json pi.{extensions,prompts,skills,themes} entry at an existing path", () => {
		const manifest = readManifest();
		const fields = ["extensions", "prompts", "skills", "themes"] as const;
		const missing: string[] = [];

		for (const field of fields) {
			const entries = manifest.pi[field];
			expect(Array.isArray(entries), `package.json pi.${field} must be an array`).toBe(true);
			expect(entries.length, `package.json pi.${field} must not be empty`).toBeGreaterThan(0);

			for (const entry of entries) {
				if (entry.trim().length === 0 || !existsSync(path.resolve(repoRoot, entry))) {
					missing.push(`pi.${field}: ${entry}`);
				}
			}
		}

		expect(missing, `Missing paths declared in package.json pi manifest:\n${missing.join("\n")}`).toEqual([]);
	});

	it("keeps extensions/pika/index.ts last in package.json pi.extensions", () => {
		const { extensions } = readManifest().pi;
		expect(extensions.length, "package.json pi.extensions must not be empty").toBeGreaterThan(0);

		const normalized = extensions.map(normalizeRepoRelative);
		const pikaOccurrences = normalized.filter((entry) => entry === "extensions/pika/index.ts");
		expect(
			pikaOccurrences,
			"extensions/pika/index.ts must appear exactly once in package.json pi.extensions",
		).toHaveLength(1);
		expect(
			normalized.at(-1),
			`Expected extensions/pika/index.ts to be the last entry in package.json pi.extensions, got ${extensions.at(-1)}`,
		).toBe("extensions/pika/index.ts");
	});

	it("covers every extension directory under extensions/ in package.json scripts.test", () => {
		const manifest = readManifest();
		const extensionDirs = listExtensionDirs();
		expect(extensionDirs.length, "Expected at least one extension directory under extensions/").toBeGreaterThan(0);

		const missingScripts: string[] = [];
		const covered = collectTestedExtensions(manifest.scripts.test, manifest.scripts, missingScripts);

		expect(
			missingScripts,
			`package.json scripts.test references undefined npm scripts: ${missingScripts.join(", ")}`,
		).toEqual([]);

		const uncovered = extensionDirs.filter((dir) => !covered.has(dir));
		expect(
			uncovered,
			`Extension directories missing from package.json scripts.test: ${uncovered.join(", ")}`,
		).toEqual([]);
	});

	it("links every extension directory in root README.md and publishes it in services/pika/web/docs/sources.ts", () => {
		const extensionDirs = listExtensionDirs();

		const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
		const linkedInReadme = extractReadmeLinkedExtensions(readme);
		const missingFromReadme = extensionDirs.filter((dir) => !linkedInReadme.has(dir));
		expect(
			missingFromReadme,
			`Extension directories not linked in README.md: ${missingFromReadme.join(", ")}`,
		).toEqual([]);

		const publishedInDocs = extractPublishedDocExtensions(docSourcesPath);
		const missingFromDocs = extensionDirs.filter((dir) => !publishedInDocs.has(dir));
		expect(
			missingFromDocs,
			`Extension directories not published in services/pika/web/docs/sources.ts: ${missingFromDocs.join(", ")}`,
		).toEqual([]);
	});

	it("lists every extension directory under extensions/ in the AGENTS.md Layout section", () => {
		const extensionDirs = listExtensionDirs();
		const agentsMd = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
		const layoutSection = extractAgentsLayoutSection(agentsMd);
		const listedInLayout = extractAgentsLayoutExtensions(layoutSection);

		const missingFromLayout = extensionDirs.filter((dir) => !listedInLayout.has(dir));
		expect(
			missingFromLayout,
			`Extension directories missing from AGENTS.md ## Layout: ${missingFromLayout.join(", ")}`,
		).toEqual([]);
	});
});
