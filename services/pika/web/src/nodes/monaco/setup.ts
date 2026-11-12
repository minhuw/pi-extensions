/**
 * Monaco, bundled and set up for pika's Content Security Policy (NODE.md, "Server hardening": `script-src 'self'`,
 * `worker-src 'self' blob:`, no eval). Only the Nodes page's editor imports this module, through a dynamic import, so
 * no other page loads it.
 *
 * - **Workers:** the one editor worker (diffs, word suggestions, links) is a Vite `?worker` chunk served from 'self';
 *   `getWorker` hands Monaco that worker, so it never builds a worker from a blob or another origin.
 * - **Languages:** syntax highlighting for every Monarch language Monaco ships, each tokenizer loaded on first use.
 *   The TypeScript, CSS, HTML, and JSON language services are left out: they see one remote file without its project,
 *   so their diagnostics would flag every import, and the TypeScript worker alone is several megabytes.
 * - **Editor features:** the contributions `editor.main` loads (find, folding, multi-cursor, the diff editor, ...).
 */
import "monaco-editor/internal/common/workers";
import "monaco-editor/features/find/register";
import "monaco-editor/languages/definitions/register.all";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { Theme } from "../../lib/theme";
import { blend, WB_TOKENS } from "../workbench/tokens";

declare global {
	interface Window {
		MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
	}
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// The Workbench's ground, ink, and accent (`workbench/tokens.ts`), as the terminal uses them.
for (const theme of ["light", "dark"] as const) {
	const tokens = WB_TOKENS[theme];
	monaco.editor.defineTheme(`pika-${theme}`, {
		base: theme === "dark" ? "vs-dark" : "vs",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": tokens.ground,
			"editor.foreground": tokens.ink,
			"editorCursor.foreground": tokens.accent,
			"editor.selectionBackground": blend(tokens.accent, tokens.ground, theme === "dark" ? 0.32 : 0.2),
			"editor.lineHighlightBackground": tokens.chrome,
			"editor.lineHighlightBorder": tokens.chrome,
			"editorLineNumber.foreground": blend(tokens.ink2, tokens.ground, 0.7),
			"editorLineNumber.activeForeground": tokens.ink,
			"editorGutter.background": tokens.ground,
			"editorWidget.background": tokens.chrome,
			"editorWidget.border": tokens.line,
			"focusBorder": tokens.accent,
		},
	});
}

export const themeName = (theme: Theme): string => (theme === "dark" ? "pika-dark" : "pika-light");

export { monaco };
