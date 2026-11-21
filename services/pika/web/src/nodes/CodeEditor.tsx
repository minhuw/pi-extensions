import { useEffect, useRef } from "react";
import type { Theme } from "../lib/theme";
import type { DiffTab, EditorTab, FileTab } from "./editor";
import { MONO_FONT_FAMILY } from "./fonts";
import { languageFor } from "./language";
import { monaco, themeName } from "./monaco/setup";

/**
 * Monaco for Deck's editor tabs; this module is the page's lazily loaded Monaco chunk. Each file tab keeps
 * one text model while it is open (its undo history and view state survive switching tabs); the store holds the
 * buffer's text, which the model follows and reports back to.
 */

interface Entry {
	scope: string;
	key: string;
	model: monaco.editor.ITextModel;
	/** The text the model and the store last agreed on. */
	text: string;
	view?: monaco.editor.ICodeEditorViewState | null;
	/** How many mounted editors currently display this model; disposal waits until it drops to zero. */
	attached: number;
}

const models = new Map<string, Entry>();
const scopeOwners = new Map<string, Set<symbol>>();
const EMPTY_OPEN: ReadonlySet<string> = new Set();
const entryKey = (scope: string, key: string) => `${scope}\0${key}`;

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

function attach(entry: Entry): void {
	entry.attached += 1;
}

function detach(entry: Entry): void {
	if (entry.attached > 0) entry.attached -= 1;
	if (entry.attached === 0 && models.get(entryKey(entry.scope, entry.key)) !== entry) {
		entry.model.dispose();
	}
}

function modelFor(scope: string, tab: FileTab, text: string): Entry {
	const mapKey = entryKey(scope, tab.key);
	let entry = models.get(mapKey);
	if (!entry) {
		entry = { scope, key: tab.key, model: monaco.editor.createModel(text, language(tab.path)), text, attached: 0 };
		models.set(mapKey, entry);
	} else if (entry.text !== text) {
		// A reload or an external change the store took in: an edit, so undo can go back past it.
		entry.text = text;
		entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text }], () => null);
	}
	return entry;
}

/** Drops the models and saved view states of tabs no longer open in `scope`. */
export function pruneModels(scope: string, open: ReadonlySet<string>): void {
	for (const [mapKey, entry] of models) {
		if (entry.scope === scope && !open.has(entry.key)) {
			models.delete(mapKey);
			if (entry.attached === 0) entry.model.dispose();
		}
	}
}

function retainScope(scope: string, owner: symbol): void {
	let owners = scopeOwners.get(scope);
	if (!owners) {
		owners = new Set();
		scopeOwners.set(scope, owners);
	}
	owners.add(owner);
}

function releaseOwner(owner: symbol): void {
	for (const [scope, owners] of scopeOwners) {
		if (!owners.delete(owner)) continue;
		if (owners.size === 0) {
			scopeOwners.delete(scope);
			pruneModels(scope, EMPTY_OPEN);
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

	useEffect(() => {
		monaco.editor.setTheme(themeName(theme));
	}, [theme]);

	const view =
		tab.kind === "diff" ? (
			<DiffView key="diff" tab={tab} theme={theme} inline={props.diffInline === true} onDiff={props.onDiff} />
		) : tab.body.kind !== "text" ? null : tab.compare && tab.disk && tab.disk.kind !== "deleted" && tab.disk.text !== undefined ? (
			<CompareView key={`compare:${scope}\0${tab.key}`} {...props} tab={tab} disk={tab.disk.text} />
		) : (
			<CodeView {...props} tab={tab} />
		);

	// ScopeLease renders after the editor view so its prune/unmount cleanups always run after the view detaches its model.
	return (
		<>
			{view}
			<ScopeLease scope={scope} open={open} />
		</>
	);
}

function ScopeLease({ scope, open }: { scope: string; open: readonly string[] }) {
	const ownerRef = useRef<symbol | null>(null);
	if (ownerRef.current === null) ownerRef.current = Symbol("CodeEditor");
	const openKey = JSON.stringify(open);
	const openRef = useRef(open);
	openRef.current = open;

	useEffect(() => {
		retainScope(scope, ownerRef.current!);
	}, [scope]);

	useEffect(() => {
		const owner = ownerRef.current!;
		return () => releaseOwner(owner);
	}, []);

	// After the views' effects, which have moved to the tab now shown. Several editors show at once (one per group),
	// so one going away drops nothing while another remains in the scope; when the last unmounts, releaseOwner prunes.
	useEffect(() => {
		pruneModels(scope, new Set(openRef.current));
	}, [scope, openKey]);

	return null;
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
	const current = useRef<Entry | undefined>(undefined);
	const handlers = useHandlers(props);
	const initialTheme = useRef(theme);
	const text = tab.body.kind === "text" ? tab.body.text : "";

	useEffect(() => {
		const editor = monaco.editor.create(host.current!, { ...OPTIONS, model: null, theme: themeName(initialTheme.current) });
		editorRef.current = editor;
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
			const active = current.current;
			if (active && active.scope === handlers.current.scope) handlers.current.onSave(active.key);
		});
		const changes = editor.onDidChangeModelContent(() => {
			const active = current.current;
			if (!active || active.scope !== handlers.current.scope) return;
			const next = active.model.getValue();
			if (next === active.text) return;
			active.text = next;
			handlers.current.onChange(active.key, active.text);
		});
		return () => {
			const active = current.current;
			if (active) active.view = editor.saveViewState();
			changes.dispose();
			editor.setModel(null);
			if (active) detach(active);
			current.current = undefined;
			editor.dispose();
			editorRef.current = null;
		};
	}, [handlers]);

	useEffect(() => {
		const editor = editorRef.current!;
		const entry = modelFor(scope, tab, text);
		if (editor.getModel() === entry.model) return;
		const previous = current.current;
		if (previous) previous.view = editor.saveViewState();
		current.current = entry;
		attach(entry);
		editor.setModel(entry.model);
		if (previous) detach(previous);
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
	const latest = useRef({ tab, text });
	latest.current = { tab, text };

	useEffect(() => {
		const buffer = modelFor(scope, latest.current.tab, latest.current.text);
		attach(buffer);
		const original = monaco.editor.createModel(disk, buffer.model.getLanguageId());
		const diff = monaco.editor.createDiffEditor(host.current!, { ...OPTIONS, originalEditable: false, theme: themeName(initialTheme.current) });
		diff.setModel({ original, modified: buffer.model });
		const modified = diff.getModifiedEditor();
		modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave(buffer.key));
		const changes = buffer.model.onDidChangeContent(() => {
			const next = buffer.model.getValue();
			if (next === buffer.text) return;
			buffer.text = next;
			handlers.current.onChange(buffer.key, buffer.text);
		});
		modified.focus();
		return () => {
			changes.dispose();
			diff.setModel(null);
			diff.dispose();
			original.dispose();
			detach(buffer);
		};
		// The disk's text is fixed for one comparison: a newer one remounts this view (its key).
	}, [handlers, scope, tab.key, disk]);

	useEffect(() => {
		modelFor(scope, tab, text);
	}, [scope, tab, text]);

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
