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

declare global {
	interface Window {
		MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
	}
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// The page's ground and ink, as the terminal uses them.
monaco.editor.defineTheme("pika-light", {
	base: "vs",
	inherit: true,
	rules: [],
	colors: { "editor.background": "#ffffff", "editor.foreground": "#0b0b0b" },
});
monaco.editor.defineTheme("pika-dark", {
	base: "vs-dark",
	inherit: true,
	rules: [],
	colors: { "editor.background": "#121212", "editor.foreground": "#ededed" },
});

export const themeName = (theme: Theme): string => (theme === "dark" ? "pika-dark" : "pika-light");

export { monaco };
