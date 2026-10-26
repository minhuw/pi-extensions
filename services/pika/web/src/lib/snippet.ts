export interface SnippetPart {
	text: string;
	mark: boolean;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/** Decodes the entities an HTML-escaped snippet may contain; unknown ones stay as written. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === "#") {
			const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED[name.toLowerCase()] ?? whole;
	});
}

/**
 * Splits a search snippet (escaped text with `<mark>` around matches) into plain text segments.
 * Only `<mark>` and `</mark>` are structure; anything else is text, so rendering never injects HTML.
 */
export function parseSnippet(snippet: string): SnippetPart[] {
	const parts: SnippetPart[] = [];
	let mark = false;
	for (const piece of snippet.split(/(<\/?mark>)/i)) {
		const tag = piece.toLowerCase();
		if (tag === "<mark>") mark = true;
		else if (tag === "</mark>") mark = false;
		else if (piece) {
			const text = decodeEntities(piece);
			const last = parts[parts.length - 1];
			if (last && last.mark === mark) last.text += text;
			else parts.push({ text, mark });
		}
	}
	return parts;
}
