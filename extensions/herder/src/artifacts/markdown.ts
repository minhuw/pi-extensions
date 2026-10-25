// Any indentation opens a fence, so fences nested in list items are caught too.
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Marks lines inside fenced code blocks, delimiters included. A fence closes on the same character repeated at least
 * as often as the opener; an unclosed fence runs to the end, and `unclosed` names its opener.
 */
export function fences(lines: readonly string[]): { fenced: boolean[]; unclosed?: { n: number; marker: string } } {
	const fenced: boolean[] = [];
	let open: { n: number; marker: string } | undefined;
	for (const [i, line] of lines.entries()) {
		const fence = FENCE.exec(line);
		if (open) {
			fenced.push(true);
			if (fence && fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length && !fence[2].trim()) open = undefined;
		} else if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
			fenced.push(true);
			open = { n: i + 1, marker: fence[1] };
		} else fenced.push(false);
	}
	return { fenced, unclosed: open };
}

export function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** `AC-<n>` without leading zeros, or undefined when `text` is not a criterion id. */
export function criterionId(text: string): string | undefined {
	const match = /^AC-(\d+)$/i.exec(text.trim());
	return match ? `AC-${match[1].replace(/^0+(?=\d)/, "")}` : undefined;
}
