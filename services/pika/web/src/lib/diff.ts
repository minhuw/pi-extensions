export interface DiffLine {
	kind: "context" | "add" | "del";
	text: string;
}

const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Line diff of two texts by longest common subsequence; very large inputs fall back to delete-then-add. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
	const a = splitLines(oldText);
	const b = splitLines(newText);

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	)
		suffix++;

	const head: DiffLine[] = a.slice(0, prefix).map((text) => ({ kind: "context", text }));
	const tail: DiffLine[] = a.slice(a.length - suffix).map((text) => ({ kind: "context", text }));
	const midA = a.slice(prefix, a.length - suffix);
	const midB = b.slice(prefix, b.length - suffix);

	let middle: DiffLine[];
	if (midA.length * midB.length > MAX_CELLS) {
		middle = [
			...midA.map((text): DiffLine => ({ kind: "del", text })),
			...midB.map((text): DiffLine => ({ kind: "add", text })),
		];
	} else {
		middle = lcsDiff(midA, midB);
	}
	return [...head, ...middle, ...tail];
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
	const n = a.length;
	const m = b.length;
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ kind: "context", text: a[i] });
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			out.push({ kind: "del", text: a[i++] });
		} else {
			out.push({ kind: "add", text: b[j++] });
		}
	}
	while (i < n) out.push({ kind: "del", text: a[i++] });
	while (j < m) out.push({ kind: "add", text: b[j++] });
	return out;
}

/** Unified-diff text for one replacement, with `context` lines kept around each change. */
export function unifiedDiff(oldText: string, newText: string, context = 3): DiffLine[] {
	const lines = diffLines(oldText, newText);
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((line, index) => {
		if (line.kind === "context") return;
		for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
	});
	const out: DiffLine[] = [];
	let skipped = 0;
	lines.forEach((line, index) => {
		if (keep[index]) {
			if (skipped) out.push({ kind: "context", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
			skipped = 0;
			out.push(line);
		} else {
			skipped++;
		}
	});
	if (skipped && out.length) out.push({ kind: "context", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
	return out;
}
