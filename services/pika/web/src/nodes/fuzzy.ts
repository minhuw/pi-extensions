/**
 * Fuzzy path matching for quick open, after fzy's scoring: the query's characters must appear in order; matches at
 * the start of a path segment or a word, and runs of consecutive matches, score high; gaps cost a little. A query
 * found within the base name ranks above one spread over directories.
 */

const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const CONSECUTIVE = 1.0;
const AFTER_SLASH = 0.9;
const AFTER_WORD = 0.8;
const CAPITAL = 0.7;
const AFTER_DOT = 0.6;
/** Added when the whole query lies within the base name, and again when it starts it. */
const IN_BASENAME = 1.5;
const MAX_PATH = 1_024;

function bonuses(path: string): Float64Array {
	const out = new Float64Array(path.length);
	let previous = "/";
	for (let i = 0; i < path.length; i++) {
		const char = path[i]!;
		out[i] =
			previous === "/"
				? AFTER_SLASH
				: previous === "-" || previous === "_" || previous === " "
				  ? AFTER_WORD
				  : previous === "."
					? AFTER_DOT
					: previous.toLowerCase() === previous && char.toLowerCase() !== char
					  ? CAPITAL
					  : 0;
		previous = char;
	}
	return out;
}

/** Whether `query`'s characters appear in `text` in order (both lower case). */
function subsequence(query: string, text: string): boolean {
	let at = 0;
	for (const char of query) {
		at = text.indexOf(char, at);
		if (at < 0) return false;
		at++;
	}
	return true;
}

/** The score of `path` for `query` (case-insensitive, spaces ignored), or undefined when it does not match. */
export function fuzzyScore(query: string, path: string): number | undefined {
	const q = query.replace(/\s+/g, "").toLowerCase();
	const p = path.toLowerCase();
	if (!q) return 0;
	if (q.length > p.length || path.length > MAX_PATH || !subsequence(q, p)) return undefined;
	const n = q.length;
	const m = p.length;
	const bonus = bonuses(path);
	// D: best score with q[i] matched at p[j]; M: best score of q[..i] within p[..j].
	let previousD = new Float64Array(m).fill(-Infinity);
	let previousM = new Float64Array(m).fill(-Infinity);
	for (let i = 0; i < n; i++) {
		const D = new Float64Array(m).fill(-Infinity);
		const M = new Float64Array(m).fill(-Infinity);
		const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
		let best = -Infinity;
		for (let j = 0; j < m; j++) {
			if (q[i] === p[j]) {
				let score = -Infinity;
				if (i === 0) score = j * GAP_LEADING + bonus[j]!;
				else if (j > 0) score = Math.max(previousM[j - 1]! + bonus[j]!, previousD[j - 1]! + CONSECUTIVE);
				D[j] = score;
				best = Math.max(score, best + gap);
			} else best += gap;
			M[j] = best;
		}
		previousD = D;
		previousM = M;
	}
	let score = previousM[m - 1]!;
	if (!Number.isFinite(score)) return undefined;
	const base = p.slice(p.lastIndexOf("/") + 1);
	if (subsequence(q, base)) score += IN_BASENAME;
	if (base.startsWith(q)) score += IN_BASENAME;
	return score;
}

export interface Ranked {
	path: string;
	score: number;
}

/** The best `limit` matches, best first; equal scores put the shorter path, then the earlier one, first. */
export function rankPaths(query: string, paths: readonly string[], limit = 50): Ranked[] {
	if (!query.trim()) return paths.slice(0, limit).map((path) => ({ path, score: 0 }));
	const ranked: (Ranked & { order: number })[] = [];
	for (const [order, path] of paths.entries()) {
		const score = fuzzyScore(query, path);
		if (score !== undefined) ranked.push({ path, score, order });
	}
	ranked.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.order - b.order);
	return ranked.slice(0, limit).map(({ path, score }) => ({ path, score }));
}
