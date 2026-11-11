import fs from "node:fs";
import path from "node:path";
import { HOME_DIR } from "./paths.ts";

export function normalizePathConstraint(pathConstraint: string, cwd = process.cwd()): string | null {
	let trimmed = pathConstraint.trim();
	if (!trimmed) return trimmed;

	if (path.isAbsolute(trimmed)) {
		const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
		if (relative === "") return null;
		if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
			throw new Error(`Path constraint must be relative to the workspace: ${pathConstraint}`);
		}
		trimmed = relative;
	}

	if (trimmed === "." || trimmed === "./") return null;
	// Strip a leading `./` so `./**/*.rs` and `**/*.rs` behave identically.
	if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

	// Bare recursive wildcards match everything, equivalent to no path constraint.
	if (trimmed === "**" || trimmed === "**/" || trimmed === "**/*") return null;

	// FFF's glob matcher can treat a hidden directory root glob such as
	// `.agents/**` as empty, while the tool contract says this means "inside
	// this directory". Collapse simple trailing recursive directory globs to the
	// directory-prefix constraint understood by the parser. Keep real file globs
	// such as `src/**/*.ts` unchanged.
	const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
	if (recursiveDir) {
		const dir = recursiveDir[1];
		if (dir && !/[*?[{]/.test(dir)) return `${dir}/`;
	}

	// Already signals path-constraint syntax to the parser.
	if (trimmed.startsWith("/") || trimmed.endsWith("/")) return trimmed;
	// Globs (`*.ts`, `src/**/*.cc`, `{src,lib}`) are handled by the parser.
	if (/[*?[{]/.test(trimmed)) return trimmed;
	// Filename with extension (`main.rs`, `config.json`) -> FilePath constraint.
	const lastSegment = trimmed.split("/").pop() ?? "";
	if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
	// Bare directory prefix -> append `/` so the parser sees a PathSegment.
	return `${trimmed}/`;
}

// Exclusions are emitted as `!<constraint>` tokens, which the Rust parser
// understands (crates/fff-query-parser/src/parser.rs). Normalize each one the
// same way as the include path so bare dirs become PathSegment excludes.
// Strip a leading `!` before normalizing so we never double-negate (`!!src/`).
export function normalizeExcludes(
	exclude: string | string[] | undefined,
	cwd = process.cwd(),
): string[] {
	if (!exclude) return [];
	const list = Array.isArray(exclude) ? exclude : [exclude];
	const out: string[] = [];
	for (const raw of list) {
		const parts = raw
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		for (const p of parts) {
			const stripped = p.startsWith("!") ? p.slice(1) : p;
			const normalized = normalizePathConstraint(stripped, cwd);
			if (normalized) out.push(`!${normalized}`);
		}
	}
	return out;
}

export function buildQuery(
	pathConstraint: string | undefined,
	pattern: string,
	exclude?: string | string[],
	cwd = process.cwd(),
): string {
	const parts: string[] = [];
	if (pathConstraint) {
		const normalized = normalizePathConstraint(pathConstraint, cwd);
		if (normalized) parts.push(normalized);
	}
	parts.push(...normalizeExcludes(exclude, cwd));
	parts.push(pattern);
	return parts.join(" ");
}

// Split an absolute path into an existing directory (the aux root) and a
// remainder usable as a fuzzy path constraint relative to that root. Glob and
// nonexistent segments both go into the suffix: walk up to the nearest existing
// ancestor so partially-wrong paths still resolve to a search root.
export function resolveAuxRoot(absPath: string): { root: string; suffix: string } | null {
	const trimmed = path.normalize(absPath.trim()).replace(/\/+$/, "") || "/";
	if (!path.isAbsolute(trimmed)) return null;
	if (trimmed === path.sep) return { root: path.sep, suffix: "" };

	const parts = trimmed.split(path.sep);
	const firstGlob = parts.findIndex((p) => /[*?[{]/.test(p));
	const boundary = firstGlob === -1 ? parts.length : firstGlob;

	// Deepest existing non-glob prefix wins; everything below it is suffix.
	for (let i = boundary; i > 0; i--) {
		const candidate = parts.slice(0, i).join(path.sep) || path.sep;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(candidate);
		} catch {
			continue;
		}
		if (stat.isFile()) {
			return {
				root: parts.slice(0, i - 1).join(path.sep) || path.sep,
				suffix: parts.slice(i - 1).join("/"),
			};
		}
		return { root: candidate, suffix: parts.slice(i).join("/") };
	}
	return null;
}

export function isOutsideWorkspaceRelativePath(relativePath: string): boolean {
	return (
		path.isAbsolute(relativePath) ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`)
	);
}

// Decide whether a `path` parameter should route to the workspace finder or
// to an aux finder. Accepts absolute paths, `~`-prefixed paths, and relative
// paths escaping the workspace (`../other-project`); everything is resolved
// against cwd first. Returns null to signal "no rerouting" (workspace finder).
export function routePathConstraint(
	pathConstraint: string | undefined,
	cwd: string,
): { root: string; suffix: string } | null {
	if (!pathConstraint) return null;
	let candidate = pathConstraint.trim();
	if (!candidate) return null;
	if (candidate === "~" || candidate.startsWith("~/")) {
		candidate = path.join(HOME_DIR, candidate.slice(1));
	}
	if (!path.isAbsolute(candidate)) {
		// Plain workspace-relative constraints stay on the workspace finder.
		if (candidate !== ".." && !candidate.startsWith("../")) return null;
		candidate = path.resolve(cwd, candidate);
	}
	const rel = path.relative(cwd, candidate);
	if (!isOutsideWorkspaceRelativePath(rel)) return null;
	return resolveAuxRoot(candidate);
}

export function rootCovers(root: string, target: string): boolean {
	if (root === target) return true;
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	return target.startsWith(prefix);
}
