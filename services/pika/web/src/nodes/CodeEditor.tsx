import { useEffect, useRef } from "react";
import type { Theme } from "../lib/theme";
import type { DiffTab, EditorTab, FileTab } from "./editor";
import { MONO_FONT_FAMILY } from "./fonts";
import { languageFor } from "./language";
import { monaco, themeName } from "./monaco/setup";

/**
 * Monaco for the Nodes page's editor tabs; this module is the page's lazily loaded Monaco chunk. Each file tab keeps
 * one text model while it is open (its undo history and view state survive switching tabs); the store holds the
 * buffer's text, which the model follows and reports back to.
 */

interface Entry {
	model: monaco.editor.ITextModel;
	/** The text the model and the store last agreed on. */
	text: string;
	view?: monaco.editor.ICodeEditorViewState | null;
}

const models = new Map<string, Entry>();
const entryKey = (scope: string, key: string) => `${scope}\n${key}`;

const OPTIONS: monaco.editor.IEditorOptions = {
	automaticLayout: true,
	// The terminal's fonts, with its Nerd Font icons for files that print them.
	fontFamily: MONO_FONT_FAMILY,
	fontSize: 13,
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	renderLineHighlight: "line",
};

const language = (path: string) => languageFor(path, monaco.languages.getLanguages());

function modelFor(scope: string, tab: FileTab, text: string): Entry {
	const key = entryKey(scope, tab.key);
	let entry = models.get(key);
	if (!entry) {
		entry = { model: monaco.editor.createModel(text, language(tab.path)), text };
		models.set(key, entry);
	} else if (entry.text !== text) {
		// A reload or an external change the store took in: an edit, so undo can go back past it.
		entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text }], () => null);
		entry.text = text;
	}
	return entry;
}

/** Drops the models of tabs no longer open in `scope`. */
function prune(scope: string, open: ReadonlySet<string>): void {
	for (const [key, entry] of models) {
		const [owner, tab] = key.split("\n") as [string, string];
		if (owner === scope && !open.has(tab)) {
			entry.model.dispose();
			models.delete(key);
		}
	}
}

/** What the page can do with the diff on screen. */
export interface DiffControl {
	/** Moves to the next or previous change, and focuses the diff. */
	go: (direction: "next" | "previous") => void;
	/** Changed regions in the diff Monaco computed last. */
	changes: number;
}

export interface CodeEditorProps {
	/** The node, so two nodes' tabs for the same path keep their own models. */
	scope: string;
	tab: EditorTab;
	/** Every open tab's key; models of the others are dropped. */
	open: readonly string[];
	theme: Theme;
	onChange: (key: string, text: string) => void;
	onSave: (key: string) => void;
	/** Diffs one column above the other. */
	diffInline?: boolean;
	/** The diff on screen's controls whenever Monaco computes it; null when it goes. */
	onDiff?: (control: DiffControl | null) => void;
}

export default function CodeEditor(props: CodeEditorProps) {
	const { scope, tab, open, theme } = props;
	const openKey = open.join("\n");

	useEffect(() => {
		monaco.editor.setTheme(themeName(theme));
	}, [theme]);

	// After the views' effects, which have moved to the tab now shown. Several editors show at once (one per group),
	// so one going away drops nothing: a model goes when no tab on the node has it open.
	useEffect(() => prune(scope, new Set(openKey.split("\n"))), [scope, openKey]);

	if (tab.kind === "diff") return <DiffView key="diff" tab={tab} theme={theme} inline={props.diffInline === true} onDiff={props.onDiff} />;
	if (tab.body.kind !== "text") return null;
	if (tab.compare && tab.disk && tab.disk.kind !== "deleted" && tab.disk.text !== undefined) {
		return <CompareView key={`compare:${tab.key}`} {...props} tab={tab} disk={tab.disk.text} />;
	}
	return <CodeView {...props} tab={tab} />;
}

function useHandlers(props: CodeEditorProps) {
	const handlers = useRef(props);
	handlers.current = props;
	return handlers;
}

/**
 * One editor for every file tab: switching tabs swaps its model and keeps each tab's view state. It never takes focus
 * itself: a file opened from the terminal leaves focus there, and the workspace focuses an editor when asked to.
 */
function CodeView(props: CodeEditorProps & { tab: FileTab }) {
	const { scope, tab, theme } = props;
	const host = useRef<HTMLDivElement>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const current = useRef<string | undefined>(undefined);
	const handlers = useHandlers(props);
	const initialTheme = useRef(theme);
	const text = tab.body.kind === "text" ? tab.body.text : "";

	useEffect(() => {
		const editor = monaco.editor.create(host.current!, { ...OPTIONS, model: null, theme: themeName(initialTheme.current) });
		editorRef.current = editor;
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
			if (current.current) handlers.current.onSave(current.current);
		});
		const changes = editor.onDidChangeModelContent(() => {
			const key = current.current;
			const entry = key && models.get(entryKey(handlers.current.scope, key));
			if (!key || !entry) return;
			entry.text = entry.model.getValue();
			handlers.current.onChange(key, entry.text);
		});
		return () => {
			const key = current.current;
			const entry = key && models.get(entryKey(handlers.current.scope, key));
			if (entry) entry.view = editor.saveViewState();
			changes.dispose();
			editor.setModel(null);
			editor.dispose();
			editorRef.current = null;
		};
	}, [handlers]);

	useEffect(() => {
		const editor = editorRef.current!;
		const entry = modelFor(scope, tab, text);
		if (editor.getModel() === entry.model) return;
		const previous = current.current && models.get(entryKey(scope, current.current));
		if (previous) previous.view = editor.saveViewState();
		current.current = tab.key;
		editor.setModel(entry.model);
		if (entry.view) editor.restoreViewState(entry.view);
	}, [scope, tab, text]);

	const reveal = tab.reveal;
	useEffect(() => {
		const editor = editorRef.current;
		if (!editor || !reveal) return;
		const position = { lineNumber: reveal.line, column: reveal.column };
		editor.setPosition(position);
		editor.revealPositionInCenter(position);
	}, [reveal]);

	return <div ref={host} className="min-h-0 flex-1" data-code-editor={tab.path} />;
}

/** The node's content on the left, read-only, against the buffer on the right, which stays editable. */
function CompareView(props: CodeEditorProps & { tab: FileTab; disk: string }) {
	const { scope, tab, disk, theme } = props;
	const host = useRef<HTMLDivElement>(null);
	const handlers = useHandlers(props);
	const initialTheme = useRef(theme);
	const text = tab.body.kind === "text" ? tab.body.text : "";
	const entry = useRef<Entry | null>(null);
	entry.current = modelFor(scope, tab, text);

	useEffect(() => {
		const buffer = entry.current!;
		const original = monaco.editor.createModel(disk, buffer.model.getLanguageId());
		const diff = monaco.editor.createDiffEditor(host.current!, { ...OPTIONS, originalEditable: false, theme: themeName(initialTheme.current) });
		diff.setModel({ original, modified: buffer.model });
		const modified = diff.getModifiedEditor();
		modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave(tab.key));
		const changes = buffer.model.onDidChangeContent(() => {
			buffer.text = buffer.model.getValue();
			handlers.current.onChange(tab.key, buffer.text);
		});
		modified.focus();
		return () => {
			changes.dispose();
			diff.setModel(null);
			diff.dispose();
			original.dispose();
		};
		// The disk's text is fixed for one comparison: a newer one remounts this view (its key).
	}, [handlers, tab.key, disk]);

	return <div ref={host} className="min-h-0 flex-1" data-compare-editor={tab.path} />;
}

/**
 * A read-only diff of two versions of a file, from git; it follows the tab's text as the store refreshes it. Side by
 * side stays side by side however narrow the panel, as the toggle says.
 */
function DiffView({ tab, theme, inline, onDiff }: { tab: DiffTab; theme: Theme; inline: boolean; onDiff?: (control: DiffControl | null) => void }) {
	const host = useRef<HTMLDivElement>(null);
	const diffRef = useRef<{ diff: monaco.editor.IStandaloneDiffEditor; original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
	const initialTheme = useRef(theme);
	const initialInline = useRef(inline);
	const report = useRef(onDiff);
	report.current = onDiff;

	useEffect(() => {
		const id = language(tab.path);
		const original = monaco.editor.createModel("", id);
		const modified = monaco.editor.createModel("", id);
		const diff = monaco.editor.createDiffEditor(host.current!, {
			...OPTIONS,
			readOnly: true,
			originalEditable: false,
			renderSideBySide: !initialInline.current,
			useInlineViewWhenSpaceIsLimited: false,
			theme: themeName(initialTheme.current),
		});
		diff.setModel({ original, modified });
		diffRef.current = { diff, original, modified };
		const go = (direction: "next" | "previous") => {
			diff.goToDiff(direction);
			diff.getModifiedEditor().focus();
		};
		let shown = false;
		const updates = diff.onDidUpdateDiff(() => {
			const changes = diff.getLineChanges()?.length ?? 0;
			// The first change of a file opened, not of each refresh: a refresh keeps the place the reader is at.
			if (!shown && changes > 0 && (original.getValueLength() > 0 || modified.getValueLength() > 0)) {
				shown = true;
				diff.goToDiff("next");
			}
			report.current?.({ go, changes });
		});
		return () => {
			updates.dispose();
			report.current?.(null);
			diff.setModel(null);
			diff.dispose();
			original.dispose();
			modified.dispose();
			diffRef.current = null;
		};
	}, [tab.path]);

	useEffect(() => {
		diffRef.current?.diff.updateOptions({ renderSideBySide: !inline });
	}, [inline]);

	useEffect(() => {
		const view = diffRef.current;
		if (!view) return;
		if (view.original.getValue() !== tab.original) view.original.setValue(tab.original);
		if (view.modified.getValue() !== tab.modified) view.modified.setValue(tab.modified);
	}, [tab.original, tab.modified, tab.path]);

	return <div ref={host} className="min-h-0 flex-1" data-diff-editor={tab.path} />;
}
