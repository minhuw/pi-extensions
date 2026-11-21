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

type EvalValue =
	| { kind: "strings"; values: string[] }
	| { kind: "object"; props: Map<string, EvalValue> }
	| { kind: "param"; fnId: string; paramIndex: number; propPath: string[]; prefix: string; suffix: string };

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

function getPropertyKeyName(name: ts.PropertyName): string | null {
	if (ts.isIdentifier(name) || ts.isNumericLiteral(name)) return name.text;
	return getStringLiteralValue(name);
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

function evaluateExpression(expr: ts.Expression, env: Map<string, EvalValue>): EvalValue | null {
	const node = unwrapExpression(expr);

	const literal = getStringLiteralValue(node);
	if (literal !== null) {
		return { kind: "strings", values: [literal] };
	}

	if (ts.isIdentifier(node)) {
		return env.get(node.text) ?? null;
	}

	if (ts.isPropertyAccessExpression(node)) {
		const target = evaluateExpression(node.expression, env);
		if (!target) return null;
		if (target.kind === "object") {
			return target.props.get(node.name.text) ?? null;
		}
		if (target.kind === "param" && target.prefix === "" && target.suffix === "") {
			return {
				kind: "param",
				fnId: target.fnId,
				paramIndex: target.paramIndex,
				propPath: [...target.propPath, node.name.text],
				prefix: "",
				suffix: "",
			};
		}
		return null;
	}

	if (ts.isElementAccessExpression(node)) {
		const target = evaluateExpression(node.expression, env);
		const key = getStringLiteralValue(unwrapExpression(node.argumentExpression));
		if (!target || key === null) return null;
		if (target.kind === "object") {
			return target.props.get(key) ?? null;
		}
		if (target.kind === "param" && target.prefix === "" && target.suffix === "") {
			return {
				kind: "param",
				fnId: target.fnId,
				paramIndex: target.paramIndex,
				propPath: [...target.propPath, key],
				prefix: "",
				suffix: "",
			};
		}
		return null;
	}

	if (ts.isObjectLiteralExpression(node)) {
		const props = new Map<string, EvalValue>();
		for (const prop of node.properties) {
			if (ts.isPropertyAssignment(prop)) {
				const key = getPropertyKeyName(prop.name);
				if (key === null) continue;
				const value = evaluateExpression(prop.initializer, env);
				if (value) props.set(key, value);
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				const value = env.get(prop.name.text);
				if (value) props.set(prop.name.text, value);
			} else if (ts.isSpreadAssignment(prop)) {
				const spreadVal = evaluateExpression(prop.expression, env);
				if (spreadVal?.kind === "object") {
					for (const [k, v] of spreadVal.props) {
						props.set(k, v);
					}
				}
			}
		}
		return { kind: "object", props };
	}

	if (ts.isArrayLiteralExpression(node)) {
		const values: string[] = [];
		for (const elem of node.elements) {
			if (ts.isOmittedExpression(elem)) return null;
			const targetExpr = ts.isSpreadElement(elem) ? elem.expression : elem;
			const val = evaluateExpression(targetExpr, env);
			if (!val || val.kind !== "strings") return null;
			values.push(...val.values);
		}
		return { kind: "strings", values };
	}

	if (ts.isTemplateExpression(node)) {
		if (node.templateSpans.length === 1) {
			const span = node.templateSpans[0]!;
			const spanVal = evaluateExpression(span.expression, env);
			if (spanVal?.kind === "param") {
				return {
					kind: "param",
					fnId: spanVal.fnId,
					paramIndex: spanVal.paramIndex,
					propPath: spanVal.propPath,
					prefix: `${node.head.text}${spanVal.prefix}`,
					suffix: `${spanVal.suffix}${span.literal.text}`,
				};
			}
		}
		let current = [node.head.text];
		for (const span of node.templateSpans) {
			const spanVal = evaluateExpression(span.expression, env);
			if (!spanVal || spanVal.kind !== "strings") return null;
			current = combineStringParts(current, spanVal.values);
			if (span.literal.text.length > 0) {
				current = combineStringParts(current, [span.literal.text]);
			}
		}
		return { kind: "strings", values: current };
	}

	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = evaluateExpression(node.left, env);
		const right = evaluateExpression(node.right, env);
		if (left?.kind === "strings" && right?.kind === "strings") {
			return { kind: "strings", values: combineStringParts(left.values, right.values) };
		}
		return null;
	}

	return null;
}

function bindBindingName(name: ts.BindingName, value: EvalValue | null, env: Map<string, EvalValue>): void {
	if (ts.isIdentifier(name)) {
		if (value) env.set(name.text, value);
		else env.delete(name.text);
		return;
	}
	if (ts.isObjectBindingPattern(name)) {
		for (const elem of name.elements) {
			if (elem.dotDotDotToken) continue;
			const propName = elem.propertyName
				? getPropertyKeyName(elem.propertyName)
				: ts.isIdentifier(elem.name)
					? elem.name.text
					: null;
			let propVal: EvalValue | null = null;
			if (propName !== null && value) {
				if (value.kind === "object") {
					propVal = value.props.get(propName) ?? null;
				} else if (value.kind === "param" && value.prefix === "" && value.suffix === "") {
					propVal = {
						kind: "param",
						fnId: value.fnId,
						paramIndex: value.paramIndex,
						propPath: [...value.propPath, propName],
						prefix: "",
						suffix: "",
					};
				}
			}
			bindBindingName(elem.name, propVal, env);
		}
		return;
	}
	if (ts.isArrayBindingPattern(name)) {
		for (const elem of name.elements) {
			if (ts.isBindingElement(elem)) {
				bindBindingName(elem.name, null, env);
			}
		}
	}
}

function resolvePropPath(value: EvalValue | null, propPath: readonly string[], prefix: string, suffix: string): EvalValue | null {
	let current = value;
	for (const key of propPath) {
		if (!current) return null;
		if (current.kind === "object") {
			current = current.props.get(key) ?? null;
		} else if (current.kind === "param" && current.prefix === "" && current.suffix === "") {
			current = {
				kind: "param",
				fnId: current.fnId,
				paramIndex: current.paramIndex,
				propPath: [...current.propPath, key],
				prefix: "",
				suffix: "",
			};
		} else {
			return null;
		}
	}
	if (!current) return null;
	if (current.kind === "strings") {
		return { kind: "strings", values: current.values.map((v) => `${prefix}${v}${suffix}`) };
	}
	if (current.kind === "param") {
		return {
			kind: "param",
			fnId: current.fnId,
			paramIndex: current.paramIndex,
			propPath: current.propPath,
			prefix: `${prefix}${current.prefix}`,
			suffix: `${current.suffix}${suffix}`,
		};
	}
	return null;
}

function resolveRelativeImport(fromFile: string, specifier: string, knownFiles: Set<string>): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [base];
	const ext = path.extname(base);
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
		const stem = base.slice(0, -ext.length);
		candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
	}
	candidates.push(
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.mts`,
		`${base}.js`,
		`${base}.mjs`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.js"),
	);
	for (const candidate of candidates) {
		if (knownFiles.has(candidate)) return candidate;
	}
	return null;
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

interface ParsedModuleInfo {
	filePath: string;
	sourceFile: ts.SourceFile;
	namedImports: Map<string, { targetFile: string; exportName: string }>;
	namespaceImports: Map<string, string>;
	reExports: Map<string, { targetFile: string; exportName: string }>;
	exportedConsts: Map<string, EvalValue>;
	topLevelEnv: Map<string, EvalValue>;
}

interface HelperRequirement {
	fnId: string;
	paramIndex: number;
	propPath: string[];
	prefix: string;
	suffix: string;
	definedAt: string;
}

interface RecordedCall {
	targetFnId: string;
	args: (EvalValue | null)[];
	filePath: string;
	line: number;
}

function isExportedStatement(node: ts.Node): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	const modifiers = ts.getModifiers(node);
	return Boolean(modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));
}

function isDefaultExported(node: ts.Node): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	const modifiers = ts.getModifiers(node);
	return Boolean(modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword));
}

function discoverRegisteredCommandsFromSources(files: Map<string, string>): DiscoveredCommand[] {
	const knownFiles = new Set(files.keys());
	const modules = new Map<string, ParsedModuleInfo>();

	for (const [filePath, sourceText] of files) {
		const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath));
		const namedImports = new Map<string, { targetFile: string; exportName: string }>();
		const namespaceImports = new Map<string, string>();
		const reExports = new Map<string, { targetFile: string; exportName: string }>();
		const exportedConsts = new Map<string, EvalValue>();
		const topLevelEnv = new Map<string, EvalValue>();

		for (const stmt of sourceFile.statements) {
			if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
				const targetFile = resolveRelativeImport(filePath, stmt.moduleSpecifier.text, knownFiles);
				if (!targetFile || !stmt.importClause) continue;
				if (stmt.importClause.name) {
					namedImports.set(stmt.importClause.name.text, { targetFile, exportName: "default" });
				}
				const bindings = stmt.importClause.namedBindings;
				if (bindings) {
					if (ts.isNamespaceImport(bindings)) {
						namespaceImports.set(bindings.name.text, targetFile);
					} else if (ts.isNamedImports(bindings)) {
						for (const spec of bindings.elements) {
							const exportName = spec.propertyName ? spec.propertyName.text : spec.name.text;
							namedImports.set(spec.name.text, { targetFile, exportName });
						}
					}
				}
			} else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
				const targetFile = resolveRelativeImport(filePath, stmt.moduleSpecifier.text, knownFiles);
				if (!targetFile || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
				for (const spec of stmt.exportClause.elements) {
					const origName = spec.propertyName ? spec.propertyName.text : spec.name.text;
					reExports.set(spec.name.text, { targetFile, exportName: origName });
				}
			}
		}

		for (const stmt of sourceFile.statements) {
			if (!ts.isVariableStatement(stmt)) continue;
			const exported = isExportedStatement(stmt);
			for (const decl of stmt.declarationList.declarations) {
				if (!decl.initializer) continue;
				const val = evaluateExpression(decl.initializer, topLevelEnv);
				bindBindingName(decl.name, val, topLevelEnv);
				if (exported && ts.isIdentifier(decl.name) && val) {
					exportedConsts.set(decl.name.text, val);
				}
			}
		}

		modules.set(filePath, {
			filePath,
			sourceFile,
			namedImports,
			namespaceImports,
			reExports,
			exportedConsts,
			topLevelEnv,
		});
	}

	const resolveExportTarget = (
		filePath: string,
		exportName: string,
		visited = new Set<string>(),
	): { targetFile: string; exportName: string } => {
		const key = `${filePath}::${exportName}`;
		if (visited.has(key)) return { targetFile: filePath, exportName };
		visited.add(key);
		const mod = modules.get(filePath);
		const reExport = mod?.reExports.get(exportName);
		if (reExport) {
			return resolveExportTarget(reExport.targetFile, reExport.exportName, visited);
		}
		return { targetFile: filePath, exportName };
	};

	// Populate imported top-level constants across modules.
	for (const mod of modules.values()) {
		for (const [localName, imp] of mod.namedImports) {
			const resolved = resolveExportTarget(imp.targetFile, imp.exportName);
			const exportedVal = modules.get(resolved.targetFile)?.exportedConsts.get(resolved.exportName);
			if (exportedVal && !mod.topLevelEnv.has(localName)) {
				mod.topLevelEnv.set(localName, exportedVal);
			}
		}
	}

	const discovered: DiscoveredCommand[] = [];
	const helperRequirements: HelperRequirement[] = [];
	const callsByTarget = new Map<string, RecordedCall[]>();

	const recordCall = (call: RecordedCall): void => {
		const list = callsByTarget.get(call.targetFnId);
		if (list) list.push(call);
		else callsByTarget.set(call.targetFnId, [call]);
	};

	for (const mod of modules.values()) {
		const { filePath, sourceFile } = mod;
		const localFnIds = new Map<string, string>();
		for (const stmt of sourceFile.statements) {
			if (ts.isFunctionDeclaration(stmt) && stmt.name) {
				const fnId = `${filePath}::${stmt.name.text}`;
				localFnIds.set(stmt.name.text, fnId);
				if (isDefaultExported(stmt)) {
					localFnIds.set("default", `${filePath}::default`);
				}
			} else if (ts.isVariableStatement(stmt)) {
				for (const decl of stmt.declarationList.declarations) {
					if (ts.isIdentifier(decl.name) && decl.initializer) {
						const init = unwrapExpression(decl.initializer);
						if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
							localFnIds.set(decl.name.text, `${filePath}::${decl.name.text}`);
						}
					}
				}
			}
		}

		const visitFunctionLike = (
			fnNode: ts.FunctionLikeDeclarationBase,
			fnId: string | null,
			env: Map<string, EvalValue>,
			forEachItemVal: EvalValue | null,
			scopedFns: Map<string, string>,
		): void => {
			const fnEnv = new Map(env);
			fnNode.parameters.forEach((param, index) => {
				if (index === 0 && forEachItemVal) {
					bindBindingName(param.name, forEachItemVal, fnEnv);
					return;
				}
				const paramVal: EvalValue | null = fnId
					? { kind: "param", fnId, paramIndex: index, propPath: [], prefix: "", suffix: "" }
					: null;
				bindBindingName(param.name, paramVal, fnEnv);
			});
			if (fnNode.body) {
				visitNode(fnNode.body, fnEnv, scopedFns);
			}
		};

		const visitStatementList = (
			statements: readonly ts.Statement[],
			env: Map<string, EvalValue>,
			parentScopedFns: Map<string, string>,
			isTopLevel: boolean,
		): void => {
			const blockEnv = new Map(env);
			const scopedFns = new Map(parentScopedFns);
			if (!isTopLevel) {
				for (const stmt of statements) {
					if (ts.isFunctionDeclaration(stmt) && stmt.name) {
						scopedFns.set(stmt.name.text, `${filePath}::local@${stmt.pos}:${stmt.name.text}`);
					} else if (ts.isVariableStatement(stmt)) {
						for (const decl of stmt.declarationList.declarations) {
							if (ts.isIdentifier(decl.name) && decl.initializer) {
								const init = unwrapExpression(decl.initializer);
								if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
									scopedFns.set(decl.name.text, `${filePath}::local@${decl.pos}:${decl.name.text}`);
								}
							}
						}
					}
				}
			}

			for (const stmt of statements) {
				if (ts.isVariableStatement(stmt)) {
					for (const decl of stmt.declarationList.declarations) {
						if (!decl.initializer) continue;
						const init = unwrapExpression(decl.initializer);
						const val = evaluateExpression(decl.initializer, blockEnv);
						bindBindingName(decl.name, val, blockEnv);
						if (ts.isIdentifier(decl.name) && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
							const fnId = scopedFns.get(decl.name.text) ?? null;
							visitFunctionLike(init, fnId, blockEnv, null, scopedFns);
						} else {
							visitNode(decl.initializer, blockEnv, scopedFns);
						}
					}
					continue;
				}
				if (ts.isFunctionDeclaration(stmt)) {
					const fnId = stmt.name
						? scopedFns.get(stmt.name.text) ?? `${filePath}::${stmt.name.text}`
						: isDefaultExported(stmt)
							? `${filePath}::default`
							: null;
					visitFunctionLike(stmt, fnId, blockEnv, null, scopedFns);
					continue;
				}
				visitNode(stmt, blockEnv, scopedFns);
			}
		};

		const resolveCallTarget = (callee: ts.Expression, scopedFns: Map<string, string>): string | null => {
			const unwrapped = unwrapExpression(callee);
			if (ts.isIdentifier(unwrapped)) {
				const imp = mod.namedImports.get(unwrapped.text);
				if (imp) {
					const resolved = resolveExportTarget(imp.targetFile, imp.exportName);
					return `${resolved.targetFile}::${resolved.exportName}`;
				}
				return scopedFns.get(unwrapped.text) ?? null;
			}
			if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression)) {
				const targetFile = mod.namespaceImports.get(unwrapped.expression.text);
				if (targetFile) {
					const resolved = resolveExportTarget(targetFile, unwrapped.name.text);
					return `${resolved.targetFile}::${resolved.exportName}`;
				}
			}
			return null;
		};

		const visitNode = (node: ts.Node, env: Map<string, EvalValue>, scopedFns: Map<string, string>): void => {
			if (ts.isBlock(node)) {
				visitStatementList(node.statements, env, scopedFns, false);
				return;
			}

			if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
				visitStatementList(node.statements, env, scopedFns, false);
				return;
			}

			if (ts.isForOfStatement(node)) {
				const loopEnv = new Map(env);
				const iterVal = evaluateExpression(node.expression, env);
				if (ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations.length > 0) {
					const decl = node.initializer.declarations[0]!;
					bindBindingName(decl.name, iterVal?.kind === "strings" ? iterVal : null, loopEnv);
				}
				visitNode(node.expression, env, scopedFns);
				visitNode(node.statement, loopEnv, scopedFns);
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
					const evaluated = evaluateExpression(firstArg, env);
					if (evaluated?.kind === "strings" && evaluated.values.length > 0) {
						for (const rawName of evaluated.values) {
							discovered.push({
								command: normalizeSlashCommand(rawName),
								filePath,
								extension: extensionNameFromFilePath(filePath),
							});
						}
					} else if (evaluated?.kind === "param") {
						helperRequirements.push({
							fnId: evaluated.fnId,
							paramIndex: evaluated.paramIndex,
							propPath: evaluated.propPath,
							prefix: evaluated.prefix,
							suffix: evaluated.suffix,
							definedAt: `${filePath}:${line}`,
						});
					} else {
						throw new Error(
							`Could not statically resolve registerCommand(...) at ${filePath}:${line}: ${firstArg.getText(sourceFile)}`,
						);
					}
				}

				const targetFnId = resolveCallTarget(callee, scopedFns);
				if (targetFnId) {
					recordCall({
						targetFnId,
						args: node.arguments.map((arg) => evaluateExpression(arg, env)),
						filePath,
						line: lineNumberAt(sourceFile, node.getStart(sourceFile)),
					});
				}

				if (
					ts.isPropertyAccessExpression(callee) &&
					callee.name.text === "forEach" &&
					node.arguments.length > 0
				) {
					const iterVal = evaluateExpression(callee.expression, env);
					const callback = unwrapExpression(node.arguments[0]!);
					if (
						iterVal?.kind === "strings" &&
						(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
					) {
						visitNode(callee.expression, env, scopedFns);
						visitFunctionLike(callback, null, env, iterVal, scopedFns);
						for (let i = 1; i < node.arguments.length; i++) {
							visitNode(node.arguments[i]!, env, scopedFns);
						}
						return;
					}
				}
			}

			if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
				visitFunctionLike(node, null, env, null, scopedFns);
				return;
			}

			ts.forEachChild(node, (child) => visitNode(child, env, scopedFns));
		};

		visitStatementList(sourceFile.statements, mod.topLevelEnv, localFnIds, true);
	}

	// Resolve helper functions that wrap pi.registerCommand(...) via their call sites (supporting multi-hop helpers).
	const pending: HelperRequirement[] = [...helperRequirements];
	const seenReqs = new Set<string>();
	while (pending.length > 0) {
		const req = pending.shift()!;
		const reqKey = `${req.fnId}|${req.paramIndex}|${req.propPath.join(".")}|${req.prefix}|${req.suffix}`;
		if (seenReqs.has(reqKey)) continue;
		seenReqs.add(reqKey);

		const calls = callsByTarget.get(req.fnId) ?? [];
		if (calls.length === 0) {
			throw new Error(
				`Found registerCommand helper ${req.fnId} (at ${req.definedAt}) with no production call sites to resolve its command name`,
			);
		}
		for (const call of calls) {
			const argVal = call.args[req.paramIndex] ?? null;
			const resolved = resolvePropPath(argVal, req.propPath, req.prefix, req.suffix);
			if (resolved?.kind === "strings" && resolved.values.length > 0) {
				for (const rawName of resolved.values) {
					discovered.push({
						command: normalizeSlashCommand(rawName),
						filePath: call.filePath,
						extension: extensionNameFromFilePath(call.filePath),
					});
				}
			} else if (resolved?.kind === "param") {
				pending.push({
					fnId: resolved.fnId,
					paramIndex: resolved.paramIndex,
					propPath: resolved.propPath,
					prefix: resolved.prefix,
					suffix: resolved.suffix,
					definedAt: `${call.filePath}:${call.line}`,
				});
			} else {
				throw new Error(
					`Could not statically resolve argument ${req.paramIndex} (${req.propPath.join(".") || "<direct>"}) in call to ${req.fnId} at ${call.filePath}:${call.line}`,
				);
			}
		}
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

	it("discovers direct, loop-template, constant, and cross-file helper registerCommand calls", () => {
		const files = new Map<string, string>([
			[
				"/repo/extensions/alpha/index.ts",
				`
				const CONST_CMD = "alpha-const";
				export default function alpha(pi: any) {
					pi.registerCommand("alpha-direct", { handler: async () => {} });
					pi.registerCommand(CONST_CMD, { handler: async () => {} });
					for (const kind of ["one", "two"] as const) {
						pi.registerCommand(\`alpha-\${kind}\`, { handler: async () => {} });
					}
				}
				`,
			],
			[
				"/repo/extensions/beta/switch.ts",
				`
				export function registerMode(pi: any, mode: { name: string }) {
					const { name } = mode;
					pi.registerCommand(name, { handler: async () => {} });
				}
				`,
			],
			[
				"/repo/extensions/beta/index.ts",
				`
				import { registerMode } from "./switch.ts";
				const MODE = "beta-mode";
				export default function beta(pi: any) {
					registerMode(pi, { name: MODE });
				}
				`,
			],
			[
				"/repo/extensions/gamma/lifecycle.ts",
				`
				export function registerLifecycle(pi: any, options: { command: string }) {
					pi.registerCommand(options.command, { handler: async () => {} });
				}
				`,
			],
			[
				"/repo/extensions/gamma/index.ts",
				`
				import { registerLifecycle } from "./lifecycle.ts";
				export default function gamma(pi: any) {
					registerLifecycle(pi, { command: "gamma-cmd" });
				}
				`,
			],
		]);

		const discovered = discoverRegisteredCommandsFromSources(files);
		expect(discovered.map((d) => `${d.command}:${d.extension}`).sort()).toEqual([
			"/alpha-const:alpha",
			"/alpha-direct:alpha",
			"/alpha-one:alpha",
			"/alpha-two:alpha",
			"/beta-mode:beta",
			"/gamma-cmd:gamma",
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
