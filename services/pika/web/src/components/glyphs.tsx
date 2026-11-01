/*!
 * The kind glyphs are icons from Lucide 1.66.0 (`lucide-static`, https://lucide.dev), with circles and rectangles
 * rewritten as paths so the canvas can draw them too.
 *
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * The terminal, search, and code icons are derived from Feather (https://feathericons.com):
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** Each glyph's strokes on Lucide's 24-unit square, keyed by what it marks; the Lucide icon's name follows. */
const GLYPHS = {
	// user-round
	prompt: ["M7 8a5 5 0 1 0 10 0a5 5 0 1 0-10 0", "M20 21a8 8 0 0 0-16 0"],
	// send
	relay: [
		"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
		"m21.854 2.147-10.94 10.939",
	],
	// puzzle
	extension: [
		"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
	],
	// sparkle
	model: [
		"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
	],
	// terminal
	shell: ["M12 19h8", "m4 17 6-6-6-6"],
	// file-text
	read: [
		"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
		"M14 2v5a1 1 0 0 0 1 1h5",
		"M10 9H8",
		"M16 13H8",
		"M16 17H8",
	],
	// search
	search: ["m21 21-4.34-4.34", "M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0"],
	// folder
	list: [
		"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
	],
	// globe
	web: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
	// pencil
	edit: [
		"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
		"m15 5 4 4",
	],
	// file-pen
	write: [
		"M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34",
		"M14 2v5a1 1 0 0 0 1 1h5",
		"M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z",
	],
	// file-diff
	patch: [
		"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
		"M9 10h6",
		"M12 13V7",
		"M9 17h6",
	],
	// code
	code: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
	// wrench
	tool: [
		"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z",
	],
	// plug
	mcp: ["M12 22v-5", "M15 8V2", "M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z", "M9 8V2"],
	// bot
	agent: ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
	// workflow
	workflow: [
		"M5 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
		"M7 11v4a2 2 0 0 0 2 2h4",
		"M15 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z",
	],
	// minimize-2
	compaction: ["m14 10 7-7", "M20 10h-6V4", "m3 21 7-7", "M4 14h6v6"],
	// git-branch
	branch: ["M15 6a9 9 0 0 0-9 9V3", "M15 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0"],
} satisfies Record<string, string[]>;

export type GlyphName = keyof typeof GLYPHS;

/**
 * Stroke width in glyph units for a glyph drawn `size` pixels wide: about 1.1 px whatever the size, so the small
 * glyphs inside bullets stay as legible as Lucide's 2-unit strokes are at 24 px.
 */
export function glyphStroke(size: number): number {
	return Math.min(3, Math.max(2, (1.1 * 24) / size));
}

/** A kind glyph in the current colour. */
export function Glyph({ name, size, className }: { name: GlyphName; size: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={glyphStroke(size)}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
			data-glyph={name}
		>
			{GLYPHS[name].map((d) => (
				<path key={d} d={d} />
			))}
		</svg>
	);
}

/** Draws a glyph `size` pixels wide centred on (x, y), for the strip map. */
export function drawGlyph(ctx: CanvasRenderingContext2D, name: GlyphName, x: number, y: number, size: number, color: string) {
	if (typeof Path2D === "undefined") return;
	ctx.save();
	ctx.translate(x - size / 2, y - size / 2);
	ctx.scale(size / 24, size / 24);
	ctx.strokeStyle = color;
	ctx.lineWidth = glyphStroke(size);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	for (const d of GLYPHS[name]) ctx.stroke(new Path2D(d));
	ctx.restore();
}
