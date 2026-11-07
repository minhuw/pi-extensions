export type SpokesmanMode = "auto" | "always";

export interface TurnWorkItem {
	toolName: string;
	summary: string;
	outputExcerpt?: string;
	isError?: boolean;
}

export interface ProseEvaluation {
	rewrite: boolean;
	score: number;
	signals: string[];
	proseWordCount: number;
}

export interface SpokesmanPromptInput {
	userRequest: string;
	recentDialogue?: string;
	workItems?: readonly TurnWorkItem[];
	draftReply: string;
	originalModel: string;
	language?: string;
}

const ABSTRACT_SUFFIX_RE =
	/(?:tion|tions|ment|ments|ance|ances|ence|ences|ibility|icity|ization|izations|iveness|ability|ology|archy|metry|istic|istically|ational|ential)$/i;

const INTERNAL_TOOL_TOKEN_RE =
	/\b(?:tool_call|exec_command|apply_patch|toolResult|write_stdin|multi_tool_use|functions\.\w+)\b/;

const OPAQUE_SHORTHAND_RE =
	/\b(?:(?:cfg|run|idx|blk|ctx|pkt|req|res|err|msg|fn|op)_[A-Za-z0-9_]+|[A-Z]{1,3}\d{2,4}|arXiv:\d{4}\.\d{4,5}(?:v\d+)?)\b/;

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_TOKEN_RE = /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]+(?:['’-][A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]+)*/g;

/**
 * Strip non-prose markdown artifacts so heuristics evaluate only natural-language prose:
 * - Fenced code blocks (``` and ~~~)
 * - Inline code spans (`...`)
 * - Markdown link URLs ([label](url) -> label)
 * - Bare URLs (http:// or https://)
 * - File paths with directory separators or :line suffixes
 * - Markdown table rows (| ... |)
 */
export function stripNonProse(markdown: string): string {
	if (!markdown) return "";

	let text = markdown;

	// 1. Remove fenced code blocks (```...``` and ~~~...~~~)
	text = text.replace(/(?:```|~~~)[\s\S]*?(?:```|~~~|$)/g, "\n");

	// 2. Remove markdown table rows
	text = text.replace(/^\s*\|.*\|\s*$/gm, "");

	// 3. Replace markdown images ![alt](url) -> alt and links [label](url) -> label
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

	// 4. Remove inline code spans (`...`)
	text = text.replace(/`[^`\n]+`/g, " ");

	// 5. Remove bare URLs
	text = text.replace(/\bhttps?:\/\/\S+/gi, " ");

	// 6. Remove file paths with directory separators (e.g. src/foo/bar.ts:12 or ./a/b.js)
	// Require at least one path segment to look like a filename with extension, dot-segment, or line number
	// so slash-chains like "validation/normalization/dispatch" stay in prose for telegraphic detection.
	text = text.replace(
		/(?:^|(?<=\s|[([{]))(?:~|\.\.?|[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.-]+)+(?:\/)?(?::\d+(?::\d+)?)?(?=$|\s|[)\]},.;:!?])/gm,
		(match) => {
			if (
				match.startsWith(".") ||
				match.startsWith("~") ||
				/\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(match) ||
				/:\d+$/.test(match)
			) {
				return " ";
			}
			return match;
		},
	);

	// 7. Remove standalone file:line references (e.g. index.ts:42)
	text = text.replace(/\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?\b/g, " ");

	// Normalize horizontal whitespace while keeping paragraph breaks
	text = text
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return text;
}

function extractWords(prose: string): string[] {
	return prose.match(WORD_TOKEN_RE) ?? [];
}

function countProseWords(prose: string): number {
	const cjkMatches = prose.match(CJK_CHAR_RE);
	const cjkCount = cjkMatches ? cjkMatches.length : 0;
	const withoutCjk = cjkCount > 0 ? prose.replace(CJK_CHAR_RE, " ") : prose;
	const words = extractWords(withoutCjk);
	return cjkCount + words.length;
}

function isNominalOrLongWord(word: string): boolean {
	const clean = word.replace(/[^A-Za-z]/g, "");
	if (clean.length < 4) return false;
	return clean.length >= 7 || ABSTRACT_SUFFIX_RE.test(clean);
}

function isAbstractWord(word: string): boolean {
	const clean = word.replace(/[^A-Za-z]/g, "");
	if (clean.length < 6) return false;
	return clean.length >= 9 || ABSTRACT_SUFFIX_RE.test(clean);
}

/**
 * Deterministic heuristic filter for `auto` mode.
 */
export function evaluateProseForSpokesman(
	markdown: string,
	workItems: readonly TurnWorkItem[] = [],
): ProseEvaluation {
	const prose = stripNonProse(markdown);
	const proseWordCount = countProseWords(prose);

	if (proseWordCount === 0) {
		return { rewrite: false, score: 0, signals: [], proseWordCount: 0 };
	}

	const hasInternalToolLeak = INTERNAL_TOOL_TOKEN_RE.test(prose);
	const hasOpaqueShorthand = OPAQUE_SHORTHAND_RE.test(prose) || OPAQUE_SHORTHAND_RE.test(markdown);
	const arrowMatches = prose.match(/(?:->|=>|→|↔)/g) ?? [];
	const slashChainMatches = prose.match(/\b[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\b/g) ?? [];

	// Short confirmations (< 16 prose words) are never rewritten unless they leak cryptic tool shorthand.
	if (proseWordCount < 16) {
		const hasCrypticLeak =
			hasInternalToolLeak ||
			(hasOpaqueShorthand && (workItems.length >= 1 || arrowMatches.length + slashChainMatches.length >= 1));
		if (!hasCrypticLeak) {
			return { rewrite: false, score: 0, signals: [], proseWordCount };
		}
	}

	const signals: string[] = [];
	let score = 0;

	// 1. "long-sentences": average sentence length >= 26 words across >= 2 sentences, or any single sentence >= 42 words
	const rawSentences = prose
		.split(/(?:[.!?]+(?:\s+|$)|\n+)/)
		.map((s) => s.trim())
		.filter(Boolean);
	const sentenceWordCounts = rawSentences.map(countProseWords).filter((count) => count >= 3);
	if (sentenceWordCounts.length > 0) {
		const maxSentenceWords = Math.max(...sentenceWordCounts);
		const avgSentenceWords =
			sentenceWordCounts.reduce((sum, n) => sum + n, 0) / sentenceWordCounts.length;
		if (
			(sentenceWordCounts.length >= 2 && avgSentenceWords >= 26) ||
			maxSentenceWords >= 42
		) {
			signals.push("long-sentences");
			score += avgSentenceWords >= 30 || maxSentenceWords >= 48 ? 2 : 1;
		}
	}

	// 2. "noun-stacks": 2+ occurrences of 3+ consecutive long/nominalized words or hyphenated multi-modifier chains
	const clauses = prose.split(/[.!?;:\n,()]+/);
	let nounStackCount = 0;
	let maxStackLength = 0;
	for (const clause of clauses) {
		const clauseWords = extractWords(clause);
		let currentRun = 0;
		for (const word of clauseWords) {
			if (isNominalOrLongWord(word)) {
				currentRun++;
				if (currentRun > maxStackLength) maxStackLength = currentRun;
			} else {
				if (currentRun >= 3) nounStackCount++;
				currentRun = 0;
			}
		}
		if (currentRun >= 3) nounStackCount++;
	}
	const hyphenChains = prose.match(/\b[A-Za-z]{3,}-[A-Za-z]{3,}(?:-[A-Za-z]{3,})+\b/g) ?? [];
	const totalStacks = nounStackCount + hyphenChains.length;
	if (totalStacks >= 2 || maxStackLength >= 4) {
		signals.push("noun-stacks");
		score += totalStacks >= 3 || (totalStacks >= 2 && maxStackLength >= 4) ? 2 : 1;
	}

	// 3. "abstract-density": high ratio (>= 0.22) of long/abstract words in prose with >= 20 words
	const allWords = extractWords(prose);
	if (allWords.length >= 20) {
		const abstractCount = allWords.filter(isAbstractWord).length;
		const ratio = abstractCount / allWords.length;
		if (ratio >= 0.22) {
			signals.push("abstract-density");
			score += ratio >= 0.3 ? 2 : 1;
		}
	}

	// 4. "telegraphic-compression": semicolons, em-dashes, slash-chains, parentheticals, or arrow chains
	const semicolons = (prose.match(/;/g) ?? []).length;
	const emDashes = (prose.match(/(?:—|--)/g) ?? []).length;
	const parentheticals = (prose.match(/\([^()\n]{2,80}\)/g) ?? []).length;
	const telegraphicCount =
		semicolons + emDashes + slashChainMatches.length + parentheticals + arrowMatches.length;
	const telegraphicDensity = telegraphicCount / Math.max(1, proseWordCount);
	if (
		(telegraphicCount >= 4 && proseWordCount < 120) ||
		(telegraphicCount >= 3 && proseWordCount < 50) ||
		telegraphicDensity >= 0.05
	) {
		signals.push("telegraphic-compression");
		score += telegraphicCount >= 6 || telegraphicDensity >= 0.08 ? 2 : 1;
	}

	// 5. "private-context-leak": internal tool names, opaque IDs/shorthand, or dense ungrounded prose after multi-tool work
	const hasWorkContextLeak =
		hasInternalToolLeak ||
		hasOpaqueShorthand ||
		(workItems.length >= 2 && (telegraphicCount >= 3 || totalStacks >= 1)) ||
		(workItems.length >= 3 && proseWordCount >= 40 && signals.length >= 1);
	if (hasWorkContextLeak) {
		signals.push("private-context-leak");
		score +=
			hasInternalToolLeak || (hasOpaqueShorthand && (workItems.length >= 1 || telegraphicCount >= 1))
				? 2
				: 1;
	}

	// 6. "wall-of-text": single paragraph >= 90 prose words with no headings or bullet lists
	const hasHeadings = /^#{1,6}\s/m.test(markdown);
	const hasLists = /^[\t ]*(?:[-*+]|\d+\.)\s/m.test(markdown);
	const paragraphs = prose
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (!hasHeadings && !hasLists && paragraphs.length === 1 && proseWordCount >= 90) {
		signals.push("wall-of-text");
		score += proseWordCount >= 140 ? 2 : 1;
	}

	return {
		rewrite: score >= 2,
		score,
		signals,
		proseWordCount,
	};
}

/**
 * Build the system and user prompts for the spokesman model.
 */
export function buildSpokesmanPrompt(input: SpokesmanPromptInput): {
	systemPrompt: string;
	userPrompt: string;
} {
	const languageRule = input.language?.trim()
		? `Write the prose in ${input.language.trim()}. Keep code, identifiers, commands, and file paths unchanged.`
		: "Write in the same language as the user's request. Keep code, identifiers, commands, and file paths unchanged.";

	const systemPrompt = [
		"You are a clear, direct technical communicator acting as the spokesman for an AI coding agent.",
		"Rewrite the agent's draft response so a human developer can understand it immediately without losing any technical precision.",
		"",
		"Rules:",
		"1. Answer the user's latest request directly in the opening sentence.",
		"2. State clearly what was done, the outcome, where the changes or evidence live, and any next step or caveat.",
		"3. Ground your explanation in the [Work record] so any internal labels, shorthand, opaque IDs, or unseen tool outputs referenced in the draft are explained in plain terms the user can follow.",
		"4. Break up dense noun stacks, telegraphic phrasing, arrow/slash chains, and abstract jargon into clear, natural sentences.",
		"5. Keep all fenced code blocks, inline code, identifiers, commands, file paths, line numbers, URLs, and exact numbers accurate and unchanged.",
		"6. Do not invent facts, tool runs, or file edits that are not supported by the [Work record] or the draft response.",
		`7. ${languageRule}`,
		"8. Output ONLY the rewritten response with no preamble, meta-commentary, or wrapper tags.",
	].join("\n");

	const sections: string[] = [
		`[User's latest request]\n${input.userRequest.trim() || "(none)"}`,
	];

	if (input.recentDialogue?.trim()) {
		sections.push(`[Recent conversation]\n${input.recentDialogue.trim()}`);
	}

	if (input.workItems && input.workItems.length > 0) {
		const formattedItems = input.workItems.map((item, idx) => {
			const status = item.isError ? " [error]" : "";
			const base = `${idx + 1}. ${item.toolName}${status}: ${item.summary.trim()}`;
			return item.outputExcerpt?.trim()
				? `${base}\n   Output: ${item.outputExcerpt.trim()}`
				: base;
		});
		sections.push(`[Work record]\n${formattedItems.join("\n")}`);
	}

	sections.push(`[Draft response from ${input.originalModel}]\n${input.draftReply.trim()}`);

	return {
		systemPrompt,
		userPrompt: sections.join("\n\n"),
	};
}
