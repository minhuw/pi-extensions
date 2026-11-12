import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "../components/icons";
import { BUTTON, Callout, ConfirmDialog, cx } from "../components/ui";
import type { Theme } from "../lib/theme";
import { homePath } from "./client";
import { sanitize, type Project } from "./contract";
import { isDirty, type EditorStore, type EditorTab, type FileTab } from "./editor";
import { baseName, joinPath, READ_LIMIT_LABEL, type NodeFiles } from "./files";
import { LAYOUT_BOUNDS } from "./layout";
import { Splitter } from "./Splitter";
import { FileTree, visibleEntries, type TreeSnapshot } from "./tree";

// Monaco and its worker are the page's largest chunk; they load with the first open tab.
const CodeEditor = lazy(() => import("./CodeEditor"));

const noop = () => () => {};
const EMPTY_TREE: TreeSnapshot = { root: "", expanded: new Set(), dirs: new Map() };

function useTree(tree: FileTree | undefined): TreeSnapshot {
	return useSyncExternalStore(tree?.subscribe ?? noop, tree?.getSnapshot ?? (() => EMPTY_TREE));
}

const SIZE = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const bytes = (size: number) => (size < 1024 ? `${size} bytes` : size < 1024 * 1024 ? `${SIZE.format(size / 1024)} KiB` : `${SIZE.format(size / 1024 / 1024)} MiB`);

export interface FilePanelProps {
	node: string;
	nodeName: string;
	home: string;
	/** Undefined while the node is not connected. */
	files: NodeFiles | undefined;
	store: EditorStore;
	/** The tree's root, and the roots to pick from. */
	root: string;
	projects: readonly Project[];
	onRoot: (root: string) => void;
	theme: Theme;
	treeWidth: number;
	onTreeWidth: (width: number, commit: boolean) => void;
	hidden: boolean;
	onHidden: (hidden: boolean) => void;
	onCollapse: () => void;
}

/**
 * The Nodes page's right pane (NODE.md §4 "Files"): the tree under the pane's project, and editor tabs for the
 * node's files and diffs.
 */
export function FilePanel(props: FilePanelProps) {
	const { files, root, store, hidden } = props;
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const expandedRef = useRef<{ root: string; dirs: ReadonlySet<string> }>({ root, dirs: new Set() });
	const tree = useMemo(
		() => (files ? new FileTree(files, root, expandedRef.current.root === root ? expandedRef.current.dirs : []) : undefined),
		[files, root],
	);
	useEffect(() => () => tree?.dispose(), [tree]);
	const treeView = useTree(tree);
	expandedRef.current = { root, dirs: treeView.root === root ? treeView.expanded : expandedRef.current.dirs };
	const [closing, setClosing] = useState<EditorTab | null>(null);
	const active = snapshot.tabs.find((tab) => tab.key === snapshot.active);
	const dirty = snapshot.tabs.some(isDirty);

	// Unsaved edits ask before the page goes.
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	const openEntry = async (path: string, kind: string) => {
		if (kind === "dir") return tree?.toggle(path);
		// A symlink may name a directory: list it if it is one.
		if (kind === "symlink" && files && (await files.readDir(path).then(() => true, () => false))) return tree?.toggle(path);
		void store.open(path);
	};

	const close = (tab: EditorTab) => (isDirty(tab) ? setClosing(tab) : store.close(tab.key));

	return (
		<section
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			aria-label="Files"
			data-file-panel=""
			onKeyDown={(event) => {
				// Cmd/Ctrl-S anywhere in the panel saves the tab shown, and never opens the browser's own save.
				if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
					event.preventDefault();
					if (active) void store.save(active.key);
				}
			}}
		>
			<header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
				<Icon name="folder" size={14} className="shrink-0 text-muted" />
				<label className="sr-only" htmlFor="node-file-root">
					Folder
				</label>
				<select
					id="node-file-root"
					className="h-7 min-w-0 flex-1 truncate rounded-sm border border-line bg-page px-1.5 text-[12.5px]"
					value={root}
					onChange={(event) => props.onRoot(event.target.value)}
					data-file-root={root}
				>
					{!props.projects.some((project) => project.path === root) && <option value={root}>{homePath(sanitize(root), props.home)}</option>}
					{props.projects.map((project) => (
						<option key={project.path} value={project.path}>
							{sanitize(project.name)} — {homePath(sanitize(project.path), props.home)}
						</option>
					))}
				</select>
				<button
					type="button"
					className={cx(BUTTON.quiet, "h-7 px-1.5", hidden && "text-ink")}
					aria-pressed={hidden}
					title={hidden ? "Hide dotfiles" : "Show dotfiles"}
					onClick={() => props.onHidden(!hidden)}
					data-show-hidden=""
				>
					<Icon name="eye" size={14} />
					<span className="sr-only">Show dotfiles</span>
				</button>
				<button type="button" className={cx(BUTTON.quiet, "h-7 px-1.5")} title="Hide the files" onClick={props.onCollapse} data-collapse-files="">
					<Icon name="sidebar" size={14} />
					<span className="sr-only">Hide the files</span>
				</button>
			</header>
			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 shrink-0 flex-col overflow-auto bg-sidebar" style={{ width: props.treeWidth }} role="tree" aria-label={`Files in ${baseName(root)}`} data-file-tree={root}>
					{files ? (
						<TreeLevel tree={tree} view={treeView} dir={root} depth={0} hidden={hidden} activePath={active?.path} onOpen={(path, kind) => void openEntry(path, kind)} />
					) : (
						<p className="p-3 text-[12.5px] text-muted">Not connected.</p>
					)}
				</div>
				<Splitter
					name="tree"
					label="Resize the file tree"
					side="left"
					value={props.treeWidth}
					min={LAYOUT_BOUNDS.tree[0]}
					max={LAYOUT_BOUNDS.tree[1]}
					onChange={(width) => props.onTreeWidth(width, false)}
					onCommit={(width) => props.onTreeWidth(width, true)}
				/>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<Tabs tabs={snapshot.tabs} active={snapshot.active} onActivate={(key) => store.activate(key)} onClose={close} />
					{active ? (
						<TabBody {...props} tab={active} keys={snapshot.tabs.map((tab) => tab.key)} />
					) : (
						<Centered>Open a file from the tree. pi's /pika-open and /pika-diff open here too.</Centered>
					)}
				</div>
			</div>
			{closing && (
				<ConfirmDialog
					title={`Close ${sanitize(closing.name)}?`}
					confirmLabel="Close without saving"
					onCancel={() => setClosing(null)}
					onConfirm={() => {
						store.close(closing.key);
						setClosing(null);
					}}
				>
					Its edits are not saved on {props.nodeName}.
				</ConfirmDialog>
			)}
		</section>
	);
}

function TreeLevel({
	tree,
	view,
	dir,
	depth,
	hidden,
	activePath,
	onOpen,
}: {
	tree: FileTree | undefined;
	view: TreeSnapshot;
	dir: string;
	depth: number;
	hidden: boolean;
	activePath?: string;
	onOpen: (path: string, kind: string) => void;
}) {
	const listing = view.dirs.get(dir);
	const indent = { paddingLeft: 8 + depth * 14 };
	if (!listing || listing.status === "loading") {
		return (
			<div className="py-1 text-[12px] text-muted" style={indent} role="status">
				Loading…
			</div>
		);
	}
	if (listing.status === "failed") {
		return (
			<div className="py-1 pr-2 text-[12px] text-red" style={indent} data-tree-error={dir}>
				{sanitize(listing.error)}{" "}
				<button type="button" className="underline" onClick={() => void tree?.refresh(dir)}>
					Retry
				</button>
			</div>
		);
	}
	const entries = visibleEntries(listing.entries, hidden);
	return (
		<>
			{depth === 0 && !listing.watched && (
				<div className="px-2 py-1 text-[11.5px] text-muted" data-tree-unwatched="">
					Not watched: changes on the node show after a refresh.{" "}
					<button type="button" className="underline" onClick={() => void tree?.refresh(dir)}>
						Refresh
					</button>
				</div>
			)}
			{entries.length === 0 && (
				<div className="py-1 text-[12px] text-muted" style={indent}>
					{listing.entries.length ? "Only dotfiles" : "Empty"}
				</div>
			)}
			{entries.map((entry) => {
				const path = joinPath(dir, entry.name);
				const open = view.expanded.has(path);
				const folder = entry.kind === "dir" || (entry.kind === "symlink" && open);
				return (
					<div key={entry.name} role="none">
						<button
							type="button"
							role="treeitem"
							aria-expanded={folder ? open : undefined}
							aria-selected={path === activePath}
							className={cx(
								"flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] hover:bg-hover",
								path === activePath && "bg-hover font-medium",
							)}
							style={indent}
							title={sanitize(path)}
							onClick={() => onOpen(path, entry.kind)}
							data-tree-entry={path}
							data-kind={entry.kind}
						>
							<span className="w-2.5 shrink-0 text-center text-[10px] text-muted" aria-hidden="true">
								{folder ? (open ? "▾" : "▸") : ""}
							</span>
							<Icon name={entry.kind === "dir" ? "folder" : "file"} size={13} className="shrink-0 text-muted" />
							<span className={cx("min-w-0 truncate", entry.kind === "symlink" && "italic")}>{sanitize(entry.name)}</span>
						</button>
						{open && <TreeLevel tree={tree} view={view} dir={path} depth={depth + 1} hidden={hidden} activePath={activePath} onOpen={onOpen} />}
					</div>
				);
			})}
			{listing.truncated && (
				<div className="py-1 pr-2 text-[11.5px] text-muted" style={indent} data-tree-truncated={dir}>
					Showing the first {listing.entries.length.toLocaleString("en")} entries; the node lists no more of a directory.
				</div>
			)}
		</>
	);
}

function Tabs({ tabs, active, onActivate, onClose }: { tabs: readonly EditorTab[]; active?: string; onActivate: (key: string) => void; onClose: (tab: EditorTab) => void }) {
	if (tabs.length === 0) return null;
	return (
		<div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line [scrollbar-width:thin]" role="tablist" aria-label="Open files">
			{tabs.map((tab) => {
				const current = tab.key === active;
				const dirty = isDirty(tab);
				return (
					<div
						key={tab.key}
						className={cx("group flex shrink-0 items-center border-r border-line text-[12.5px]", current ? "bg-page font-medium shadow-[inset_0_-2px_0_var(--color-ink)]" : "bg-sidebar text-muted")}
						data-editor-tab={tab.key}
						data-dirty={dirty || undefined}
					>
						<button
							type="button"
							role="tab"
							aria-selected={current}
							className="flex h-full items-center gap-1.5 pr-1 pl-3"
							title={sanitize(tab.path)}
							onClick={() => onActivate(tab.key)}
							onAuxClick={(event) => {
								if (event.button === 1) onClose(tab);
							}}
						>
							{tab.kind === "diff" && <Icon name="branch" size={12} className="shrink-0" />}
							<span className="max-w-[180px] truncate">{sanitize(tab.name)}</span>
							{tab.kind === "diff" && <span className="text-[11px] text-muted">{tab.staged ? "staged" : "changes"}</span>}
						</button>
						<button
							type="button"
							className="mr-1 flex size-5 items-center justify-center rounded-sm hover:bg-hover"
							aria-label={dirty ? `Close ${sanitize(tab.name)} (unsaved)` : `Close ${sanitize(tab.name)}`}
							onClick={() => onClose(tab)}
						>
							{dirty ? (
								<>
									<span className="size-2 rounded-full bg-ink group-hover:hidden" aria-hidden="true" data-dirty-marker="" />
									<Icon name="close" size={11} className="hidden group-hover:block" />
								</>
							) : (
								<Icon name="close" size={11} />
							)}
						</button>
					</div>
				);
			})}
		</div>
	);
}

function Centered({ children }: { children: ReactNode }) {
	return <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">{children}</div>;
}

function EditorLoading() {
	return <Centered>Loading the editor…</Centered>;
}

function TabBody(props: FilePanelProps & { tab: EditorTab; keys: string[] }) {
	const { tab, store, nodeName } = props;
	const editor = (
		<Suspense fallback={<EditorLoading />}>
			<CodeEditor
				scope={props.node}
				tab={tab}
				open={props.keys}
				theme={props.theme}
				onChange={(key, text) => store.edit(key, text)}
				onSave={(key) => void store.save(key)}
			/>
		</Suspense>
	);

	if (tab.kind === "diff") {
		return (
			<>
				<div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px] text-muted" data-diff-header={tab.path}>
					<span className="min-w-0 truncate" title={sanitize(tab.path)}>
						{homePath(sanitize(tab.path), props.home)}
					</span>
					<span className="shrink-0">
						{tab.labels[0]} → {tab.labels[1]}
					</span>
					<button type="button" className={cx(BUTTON.quiet, "ml-auto h-6 px-2")} onClick={() => void store.refreshDiff(tab.key)}>
						Refresh
					</button>
				</div>
				{tab.status === "failed" ? (
					<div className="p-3">
						<Callout tone="red" title="Could not load the diff">
							{sanitize(tab.error)}
						</Callout>
					</div>
				) : tab.status === "loading" && !tab.original && !tab.modified ? (
					<Centered>Loading the diff…</Centered>
				) : tab.original === tab.modified ? (
					<Centered>No changes between {tab.labels[0].toLowerCase()} and {tab.labels[1].toLowerCase()}.</Centered>
				) : (
					editor
				)}
			</>
		);
	}

	const body = tab.body;
	if (body.kind === "loading") return <Centered>Reading {sanitize(tab.name)}…</Centered>;
	if (body.kind === "binary") return <Centered>{sanitize(tab.name)} is binary ({bytes(body.size)}); the editor opens text files only.</Centered>;
	if (body.kind === "too_large") {
		return (
			<Centered>
				{sanitize(tab.name)} is over {READ_LIMIT_LABEL}, the most a node sends in one read. Open it in the terminal instead.
			</Centered>
		);
	}
	if (body.kind === "missing") return <Centered>{sanitize(tab.name)} does not exist on {nodeName}.</Centered>;
	if (body.kind === "failed") {
		return (
			<div className="p-3">
				<Callout tone="red" title={`Could not read ${sanitize(tab.name)}`}>
					{sanitize(body.message)}
				</Callout>
			</div>
		);
	}
	return (
		<>
			<FileStatus tab={tab} store={store} nodeName={nodeName} />
			{editor}
		</>
	);
}

/** The line above a file's editor: where it lives, saving, and anything that changed on the node. */
function FileStatus({ tab, store, nodeName }: { tab: FileTab; store: EditorStore; nodeName: string }) {
	const disk = tab.disk;
	const name = sanitize(tab.name);
	return (
		<>
			{disk && (
				<div className="shrink-0 border-b border-ink bg-soft px-3 py-2 text-[12.5px]" role="alert" data-disk-change={disk.kind}>
					<p>
						{disk.kind === "deleted"
							? `${name} was deleted on ${nodeName}. Saving writes it again.`
							: disk.kind === "conflict"
								? `${name} changed on ${nodeName} since you opened it, so your save was not written.`
								: `${name} changed on ${nodeName}. Your edits are kept here.`}
					</p>
					{disk.kind !== "deleted" && (
						<div className="mt-2 flex flex-wrap gap-2">
							<button type="button" className={cx(BUTTON.secondary, "h-7")} onClick={() => void store.compare(tab.key, !tab.compare)} data-disk-compare="">
								{tab.compare ? "Hide comparison" : "Compare"}
							</button>
							<button type="button" className={cx(BUTTON.secondary, "h-7")} onClick={() => void store.reload(tab.key)} data-disk-reload="">
								Reload theirs
							</button>
							<button type="button" className={cx(BUTTON.primary, "h-7")} disabled={tab.saving} onClick={() => void store.overwrite(tab.key)} data-disk-overwrite="">
								Overwrite with mine
							</button>
						</div>
					)}
					{tab.compare && disk.kind !== "deleted" && (
						<div className="mt-1 text-[11.5px] text-muted">Left: the file on {nodeName}. Right: your buffer, still editable.</div>
					)}
				</div>
			)}
			{(tab.saveError || tab.saving || !tab.watched) && (
				<div className="flex h-7 shrink-0 items-center gap-3 border-b border-line px-3 text-[12px] text-muted">
					{tab.saving && <span role="status">Saving…</span>}
					{tab.saveError && (
						<span className="text-red" role="alert" data-save-error="">
							{sanitize(tab.saveError)}
						</span>
					)}
					{!tab.watched && !tab.saving && <span data-file-unwatched="">Not watched: changes on {nodeName} show when you save or reload.</span>}
				</div>
			)}
		</>
	);
}
