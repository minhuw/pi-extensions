import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DOC_COMMANDS, DOC_SOURCES } from "../services/pika/web/docs/sources.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const extensionsRoot = path.join(repoRoot, "extensions");

interface RootManifest {
	scripts: Record<string, string>;
	pi: {
		extensions: string[];
		prompts: string[];
		skills: string[];
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
		ts.isParenthesizedExpression(expr) ||
		ts.isNonNullExpression(expr) ||
		ts.isTypeAssertionExpression(expr)
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

interface DiscoveredCommand {
	command: string;
	filePath: string;
	extension: string | null;
}

interface CommandParityDiff {
	missingFromDocs: string[];
	staleInDocs: string[];
}

const EXCLUDED_SOURCE_DIRS = new Set([
	"tests",
	"test",
	"fixtures",
	"vendor",
	"examples",
	"scripts",
	"node_modules",
	"dist",
	"build",
]);

const SOURCE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

function scriptKindForPath(filePath: string): ts.ScriptKind {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

function combineStringParts(left: string[], right: string[]): string[] {
	const result: string[] = [];
	for (const a of left) {
		for (const b of right) {
			result.push(`${a}${b}`);
		}
	}
	return result;
}

function evaluateStringValues(expr: ts.Expression, env: Map<string, string[]>): string[] | null {
	const node = unwrapExpression(expr);

	const literal = getStringLiteralValue(node);
	if (literal !== null) {
		return [literal];
	}

	if (ts.isIdentifier(node)) {
		return env.get(node.text) ?? null;
	}

	if (ts.isArrayLiteralExpression(node)) {
		const values: string[] = [];
		for (const elem of node.elements) {
			if (ts.isOmittedExpression(elem)) return null;
			const targetExpr = ts.isSpreadElement(elem) ? elem.expression : elem;
			const val = evaluateStringValues(targetExpr, env);
			if (!val) return null;
			values.push(...val);
		}
		return values;
	}

	if (ts.isTemplateExpression(node)) {
		let current = [node.head.text];
		for (const span of node.templateSpans) {
			const spanValues = evaluateStringValues(span.expression, env);
			if (!spanValues) return null;
			current = combineStringParts(current, spanValues);
			if (span.literal.text.length > 0) {
				current = combineStringParts(current, [span.literal.text]);
			}
		}
		return current;
	}

	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = evaluateStringValues(node.left, env);
		const right = evaluateStringValues(node.right, env);
		if (left && right) {
			return combineStringParts(left, right);
		}
		return null;
	}

	return null;
}

function clearBindingNames(name: ts.BindingName, env: Map<string, string[]>): void {
	if (ts.isIdentifier(name)) {
		env.delete(name.text);
		return;
	}
	for (const elem of name.elements) {
		if (ts.isBindingElement(elem)) {
			clearBindingNames(elem.name, env);
		}
	}
}

function extensionNameFromFilePath(filePath: string): string | null {
	const normalized = filePath.replaceAll("\\", "/");
	const match = normalized.match(/(?:^|\/)extensions\/([^/]+)\//);
	return match ? match[1]! : null;
}

function normalizeSlashCommand(raw: string): string {
	return raw.startsWith("/") ? raw : `/${raw}`;
}

function lineNumberAt(sourceFile: ts.SourceFile, pos: number): number {
	return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function collectProductionExtensionSourceFiles(rootDir: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_SOURCE_DIRS.has(entry.name)) continue;
				walk(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (!SOURCE_FILE_EXTENSIONS.has(ext)) continue;
				if (
					entry.name.endsWith(".d.ts") ||
					/\.test\.[^.]+$/.test(entry.name) ||
					/\.spec\.[^.]+$/.test(entry.name) ||
					/^vitest(?:\.[^.]+)?\.config\.[^.]+$/.test(entry.name)
				) {
					continue;
				}
				files.push(fullPath);
			}
		}
	};
	walk(rootDir);
	return files.sort();
}

function discoverRegisteredCommandsFromFile(filePath: string, sourceText: string): DiscoveredCommand[] {
	const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath));
	const topLevelEnv = new Map<string, string[]>();

	for (const stmt of sourceFile.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
		for (const decl of stmt.declarationList.declarations) {
			if (isConst && ts.isIdentifier(decl.name) && decl.initializer) {
				const values = evaluateStringValues(decl.initializer, topLevelEnv);
				if (values) topLevelEnv.set(decl.name.text, values);
				else topLevelEnv.delete(decl.name.text);
			} else {
				clearBindingNames(decl.name, topLevelEnv);
			}
		}
	}

	const discovered: DiscoveredCommand[] = [];
	const extension = extensionNameFromFilePath(filePath);

	const visitStatementList = (
		statements: readonly ts.Statement[],
		env: Map<string, string[]>,
		isTopLevel: boolean,
	): void => {
		const blockEnv = new Map(env);
		for (const stmt of statements) {
			if (ts.isVariableStatement(stmt)) {
				const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
				for (const decl of stmt.declarationList.declarations) {
					if (!isTopLevel) {
						if (isConst && ts.isIdentifier(decl.name) && decl.initializer) {
							const values = evaluateStringValues(decl.initializer, blockEnv);
							if (values) blockEnv.set(decl.name.text, values);
							else blockEnv.delete(decl.name.text);
						} else {
							clearBindingNames(decl.name, blockEnv);
						}
					}
					if (decl.initializer) {
						visitNode(decl.initializer, blockEnv);
					}
				}
				continue;
			}
			visitNode(stmt, blockEnv);
		}
	};

	const visitNode = (node: ts.Node, env: Map<string, string[]>): void => {
		if (ts.isBlock(node)) {
			visitStatementList(node.statements, env, false);
			return;
		}

		if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
			visitStatementList(node.statements, env, false);
			return;
		}

		if (ts.isForOfStatement(node)) {
			const loopEnv = new Map(env);
			const iterValues = evaluateStringValues(node.expression, env);
			if (ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations.length > 0) {
				const decl = node.initializer.declarations[0]!;
				if (ts.isIdentifier(decl.name) && iterValues && iterValues.length > 0) {
					loopEnv.set(decl.name.text, iterValues);
				} else {
					clearBindingNames(decl.name, loopEnv);
				}
			}
			visitNode(node.expression, env);
			visitNode(node.statement, loopEnv);
			return;
		}

		if (
			ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)
		) {
			const fnEnv = new Map(env);
			for (const param of node.parameters) {
				if (param.initializer) visitNode(param.initializer, fnEnv);
				clearBindingNames(param.name, fnEnv);
			}
			if (node.body) {
				visitNode(node.body, fnEnv);
			}
			return;
		}

		if (ts.isCallExpression(node)) {
			const callee = unwrapExpression(node.expression);
			if (ts.isPropertyAccessExpression(callee) && callee.name.text === "registerCommand") {
				const line = lineNumberAt(sourceFile, node.getStart(sourceFile));
				if (node.arguments.length === 0) {
					throw new Error(`registerCommand() called without a command name at ${filePath}:${line}`);
				}
				const firstArg = node.arguments[0]!;
				const resolved = evaluateStringValues(firstArg, env);
				if (resolved && resolved.length > 0) {
					for (const rawName of resolved) {
						discovered.push({
							command: normalizeSlashCommand(rawName),
							filePath,
							extension,
						});
					}
				} else {
					throw new Error(
						`Could not statically resolve registerCommand(...) at ${filePath}:${line}: ${firstArg.getText(sourceFile)}`,
					);
				}
			}
		}

		ts.forEachChild(node, (child) => visitNode(child, env));
	};

	visitStatementList(sourceFile.statements, topLevelEnv, true);
	return discovered;
}

function discoverRegisteredCommandsFromSources(files: Map<string, string>): DiscoveredCommand[] {
	const discovered: DiscoveredCommand[] = [];
	for (const [filePath, sourceText] of files) {
		discovered.push(...discoverRegisteredCommandsFromFile(filePath, sourceText));
	}
	return discovered;
}

function discoverRegisteredExtensionCommands(rootDir = extensionsRoot): DiscoveredCommand[] {
	const files = new Map<string, string>();
	for (const filePath of collectProductionExtensionSourceFiles(rootDir)) {
		files.set(filePath, readFileSync(filePath, "utf8"));
	}
	return discoverRegisteredCommandsFromSources(files);
}

function extractManifestPromptCommands(manifest: RootManifest, rootDir = repoRoot): DiscoveredCommand[] {
	const prompts: DiscoveredCommand[] = [];
	const collectMarkdownFiles = (targetPath: string): void => {
		const stat = statSync(targetPath);
		if (stat.isDirectory()) {
			for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				collectMarkdownFiles(path.join(targetPath, entry.name));
			}
			return;
		}
		if (stat.isFile() && targetPath.endsWith(".md")) {
			prompts.push({
				command: `/${path.basename(targetPath, ".md")}`,
				filePath: targetPath,
				extension: extensionNameFromFilePath(targetPath),
			});
		}
	};

	for (const entry of manifest.pi.prompts) {
		const resolved = path.resolve(rootDir, entry);
		collectMarkdownFiles(resolved);
	}
	return prompts;
}

function diffCommandParity(actualCommands: Iterable<string>, documentedCommands: Iterable<string>): CommandParityDiff {
	const actual = new Set(actualCommands);
	const documented = new Set(documentedCommands);
	const missingFromDocs = [...actual].filter((cmd) => !documented.has(cmd)).sort();
	const staleInDocs = [...documented].filter((cmd) => !actual.has(cmd)).sort();
	return { missingFromDocs, staleInDocs };
}

describe("collection manifest contracts", () => {
	it("points every package.json pi.{extensions,prompts,skills} entry at an existing path", () => {
		const manifest = readManifest();
		const fields = ["extensions", "prompts", "skills"] as const;
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

		const publishedInDocs = new Set<string>();
		const extensionSourcePattern = /^(?:\.\/)?extensions\/([^/]+)(?:\/|$)/;
		for (const entry of DOC_SOURCES) {
			const match = entry.source.match(extensionSourcePattern);
			if (match) publishedInDocs.add(match[1]!);
		}
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

	it("enforces bidirectional parity between registered slash commands/prompts and DOC_COMMANDS in services/pika/web/docs/sources.ts", () => {
		const manifest = readManifest();
		const registeredCommands = discoverRegisteredExtensionCommands();
		const promptCommands = extractManifestPromptCommands(manifest);
		const allDiscovered = [...registeredCommands, ...promptCommands];

		expect(registeredCommands.length, "Expected registered slash commands under extensions/").toBeGreaterThan(0);
		expect(promptCommands.length, "Expected prompt templates in package.json pi.prompts").toBeGreaterThan(0);

		const seenDocCommands = new Set<string>();
		const docDuplicates: string[] = [];
		for (const entry of DOC_COMMANDS) {
			if (seenDocCommands.has(entry.command)) docDuplicates.push(entry.command);
			seenDocCommands.add(entry.command);
		}
		expect(
			docDuplicates,
			`Duplicate commands in DOC_COMMANDS (services/pika/web/docs/sources.ts): ${docDuplicates.join(", ")}`,
		).toEqual([]);

		const discoveredNames = [...new Set(allDiscovered.map((item) => item.command))].sort();
		const documentedNames = DOC_COMMANDS.map((item) => item.command).sort();
		const { missingFromDocs, staleInDocs } = diffCommandParity(discoveredNames, documentedNames);

		expect(
			missingFromDocs,
			`Registered slash commands or prompt templates missing from DOC_COMMANDS in services/pika/web/docs/sources.ts: ${missingFromDocs.join(", ")}`,
		).toEqual([]);
		expect(
			staleInDocs,
			`Stale or removed commands still listed in DOC_COMMANDS in services/pika/web/docs/sources.ts: ${staleInDocs.join(", ")}`,
		).toEqual([]);
		expect(documentedNames).toEqual(discoveredNames);

		const documentedByCommand = new Map(DOC_COMMANDS.map((entry) => [entry.command, entry.extension]));
		const extensionMismatches: string[] = [];
		for (const item of allDiscovered) {
			if (!item.extension) continue;
			const docExtension = documentedByCommand.get(item.command);
			if (docExtension !== item.extension) {
				extensionMismatches.push(`${item.command}: discovered in extensions/${item.extension}, documented under ${docExtension ?? "<none>"}`);
			}
		}
		expect(
			extensionMismatches,
			`DOC_COMMANDS extension mismatches:\n${extensionMismatches.join("\n")}`,
		).toEqual([]);
	});
});

describe("command parity helpers", () => {
	it("detects both missing and stale commands (including renames) in diffCommandParity", () => {
		expect(diffCommandParity(["/alpha", "/beta"], ["/alpha", "/beta"])).toEqual({
			missingFromDocs: [],
			staleInDocs: [],
		});

		// Added command missing from DOC_COMMANDS
		expect(diffCommandParity(["/alpha", "/beta", "/gamma"], ["/alpha", "/beta"])).toEqual({
			missingFromDocs: ["/gamma"],
			staleInDocs: [],
		});

		// Removed command left stale in DOC_COMMANDS
		expect(diffCommandParity(["/alpha"], ["/alpha", "/beta"])).toEqual({
			missingFromDocs: [],
			staleInDocs: ["/beta"],
		});

		// Renamed command triggers both directions simultaneously
		expect(diffCommandParity(["/alpha", "/beta-v2"], ["/alpha", "/beta"])).toEqual({
			missingFromDocs: ["/beta-v2"],
			staleInDocs: ["/beta"],
		});
	});

	it("discovers direct literal, local const, concatenation, and single-file for..of template registerCommand calls", () => {
		const files = new Map<string, string>([
			[
				"/repo/extensions/alpha/index.ts",
				`
				const CONST_CMD = "alpha-const";
				const PREFIX = "alpha-";
				const KINDS = ["one", "two"] as const;
				export default function alpha(pi: any) {
					pi.registerCommand("alpha-direct", { handler: async () => {} });
					pi.registerCommand(CONST_CMD, { handler: async () => {} });
					pi.registerCommand(PREFIX + "concat", { handler: async () => {} });
					for (const kind of KINDS) {
						pi.registerCommand(\`alpha-\${kind}\`, { handler: async () => {} });
					}
					for (const suffix of ["three", "four"] as const) {
						pi.registerCommand(\`alpha-\${suffix}\`, { handler: async () => {} });
					}
				}
				`,
			],
		]);

		const discovered = discoverRegisteredCommandsFromSources(files);
		expect(discovered.map((d) => `${d.command}:${d.extension}`).sort()).toEqual([
			"/alpha-concat:alpha",
			"/alpha-const:alpha",
			"/alpha-direct:alpha",
			"/alpha-four:alpha",
			"/alpha-one:alpha",
			"/alpha-three:alpha",
			"/alpha-two:alpha",
		]);
	});

	it("fails loudly when a production registerCommand call cannot be statically resolved", () => {
		const files = new Map<string, string>([
			[
				"/repo/extensions/dynamic/index.ts",
				`
				export default function dyn(pi: any, getName: () => string) {
					pi.registerCommand(getName(), { handler: async () => {} });
				}
				`,
			],
		]);

		expect(() => discoverRegisteredCommandsFromSources(files)).toThrow(
			/Could not statically resolve registerCommand/,
		);
	});
});
