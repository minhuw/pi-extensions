import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from "react";
import { Icon } from "../components/icons";
import { copyText } from "../lib/clipboard";
import { BUTTON, Callout, cx, Segmented } from "../components/ui";
import type { Theme } from "../lib/theme";
import { CHANGE_GROUPS, changeMode, type Change, type ChangesSnapshot, type ChangesStore } from "./changes";
import { homePath } from "./client";
import type { DiffControl } from "./CodeEditor";
import { sanitize, type Project } from "./contract";
import { type DiffTab, type EditorStore, type EditorTab, type FileTab } from "./editor";
import { baseName, dirName, joinPath, READ_LIMIT_LABEL, type NodeFiles } from "./files";
import { isMenuKey, menuAtPointer, menuBelow, useMenu, type MenuEntry } from "./deck/Menu";
import { tip } from "./deck/Tooltips";
import { FileTree, visibleEntries, type TreeSnapshot } from "./tree";

/**
 * Deck's file views (NODE.md §4 "Files"): the explorer's tree under a project, git's changes, and the body
 * of an editor tab (a file in Monaco, or a diff) as the workspace's tab groups show it.
 */

// Monaco and its worker are the page's largest chunk; they load with the first open tab.
const CodeEditor = lazy(() => import("./CodeEditor"));

const noop = () => () => {};
const EMPTY_TREE: TreeSnapshot = { root: "", expanded: new Set(), dirs: new Map() };

function useTree(tree: FileTree | undefined): TreeSnapshot {
	return useSyncExternalStore(tree?.subscribe ?? noop, tree?.getSnapshot ?? (() => EMPTY_TREE));
}

const LOADING_CHANGES: ChangesSnapshot = { status: "loading" };

export function useChanges(changes: ChangesStore | undefined): ChangesSnapshot {
	return useSyncExternalStore(changes?.subscribe ?? noop, changes?.getSnapshot ?? (() => LOADING_CHANGES));
}

export function usePageVisible(): boolean {
	return useSyncExternalStore(
		(listener) => {
			document.addEventListener("visibilitychange", listener);
			return () => document.removeEventListener("visibilitychange", listener);
		},
		() => document.visibilityState === "visible",
	);
}

/** A diff tab's title words: what it compares. */
export const diffKind = (tab: Pick<DiffTab, "mode">): string => (tab.mode === "staged" ? "staged" : tab.mode === "untracked" ? "new" : "changes");

const SIZE = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const bytes = (size: number) => (size < 1024 ? `${size} bytes` : size < 1024 * 1024 ? `${SIZE.format(size / 1024)} KiB` : `${SIZE.format(size / 1024 / 1024)} MiB`);

/** How a file opens from the explorer: a preview tab on one click, a tab kept for good on two. */
export type OpenHow = "preview" | "open";

export interface ExplorerProps {
	/** Undefined while the node is not connected. */
	files: NodeFiles | undefined;
	home: string;
	/** The tree's root, and the roots to pick from. */
	root: string;
	projects: readonly Project[];
	onRoot: (root: string) => void;
	hidden: boolean;
	onHidden: (hidden: boolean) => void;
	/** The file the focused group shows, marked in the tree. */
	activePath?: string;
	onOpenFile: (path: string, how: OpenHow) => void;
}

/** The explorer: a folder picker over the node's projects, and the tree under the folder picked. */
export function Explorer(props: ExplorerProps) {
	const { files, root, hidden } = props;
	const expandedRef = useRef<{ root: string; dirs: ReadonlySet<string> }>({ root, dirs: new Set() });
	const tree = useMemo(
		() => (files ? new FileTree(files, root, expandedRef.current.root === root ? expandedRef.current.dirs : []) : undefined),
		[files, root],
	);
	useEffect(() => () => tree?.dispose(), [tree]);
	const treeView = useTree(tree);
	expandedRef.current = { root, dirs: treeView.root === root ? treeView.expanded : expandedRef.current.dirs };

	const entryMenu = useMenu();
	const rootMenu = useMenu();
	/** A tree item's context menu: open (or fold), copy its path absolute or under the folder, refresh a folder. */
	const onEntryMenu = (path: string, kind: string, folder: boolean, at: { x: number; y: number; flipY?: number }) => {
		const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
		const items: MenuEntry[] = [
			folder
				? { id: "toggle", label: treeView.expanded.has(path) ? "Collapse" : "Expand", run: () => void tree?.toggle(path) }
				: { id: "open", label: "Open", run: () => void openEntry(path, kind, "open") },
			"separator",
			{ id: "copy-path", label: "Copy Path", run: () => void copyText(path) },
			{ id: "copy-relative", label: "Copy Relative Path", run: () => void copyText(relative) },
			...(folder ? (["separator", { id: "refresh", label: "Refresh", run: () => void tree?.refresh(path) }] as MenuEntry[]) : []),
		];
		entryMenu.open({ ...at, items, label: baseName(path), attrs: { "data-tree-menu": path } });
	};

	const openEntry = async (path: string, kind: string, how: OpenHow) => {
		if (kind === "dir") return how === "preview" ? tree?.toggle(path) : undefined;
		// A symlink may name a directory: list it if it is one.
		if (kind === "symlink" && files && (await files.readDir(path).then(() => true, () => false))) return how === "preview" ? tree?.toggle(path) : undefined;
		props.onOpenFile(path, how);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-explorer="">
			<div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2">
				<button
					type="button"
					className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[4px] px-1.5 text-left text-[12.5px] font-medium hover:bg-dk-hover"
					aria-haspopup="menu"
					aria-expanded={rootMenu.openFor === "Folder"}
					aria-label={`Folder: ${homePath(sanitize(root), props.home)}`}
					onClick={(event) => {
						if (rootMenu.openFor === "Folder") return rootMenu.close();
						const known = props.projects.some((project) => project.path === root);
						const items: MenuEntry[] = [
							...(known ? [] : [{ id: `root:${root}`, label: homePath(sanitize(root), props.home), checked: true, run: () => {} }]),
							...props.projects.map((project) => ({
								id: `root:${project.path}`,
								label: `${sanitize(project.name)}  ${homePath(sanitize(project.path), props.home)}`,
								checked: project.path === root,
								run: () => props.onRoot(project.path),
							})),
						];
						rootMenu.open({ ...menuBelow(event.currentTarget), items, label: "Folder", attrs: { "data-root-menu": "" } });
					}}
					{...tip("Show another folder")}
					data-file-root={root}
				>
					<Icon name="folder" size={13} className="shrink-0 text-dk-ink-2" />
					<span className="min-w-0 flex-1 truncate">{homePath(sanitize(root), props.home)}</span>
					<svg width="9" height="9" viewBox="0 0 10 10" className="shrink-0 text-dk-ink-3" aria-hidden="true">
						<path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
				<button
					type="button"
					className={cx(BUTTON.quiet, "h-7 px-1.5", hidden && "text-ink")}
					aria-pressed={hidden}
					{...tip(hidden ? "Hide dotfiles" : "Show dotfiles")}
					onClick={() => props.onHidden(!hidden)}
					data-show-hidden=""
				>
					<Icon name="eye" size={14} />
					<span className="sr-only">Show dotfiles</span>
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto" role="tree" aria-label={`Files in ${baseName(root)}`} data-file-tree={root}>
				{files ? (
					<TreeLevel tree={tree} view={treeView} dir={root} depth={0} hidden={hidden} activePath={props.activePath} onOpen={(path, kind, how) => void openEntry(path, kind, how)} onMenu={onEntryMenu} />
				) : (
					<p className="p-3 text-[12.5px] text-muted">Not connected.</p>
				)}
			</div>
			{entryMenu.menu}
			{rootMenu.menu}
		</div>
	);
}

/** git's changes under `root`: each opens its diff (a conflict, its file). */
export function ChangesPanel({
	connected,
	root,
	view,
	home,
	activeKey,
	onOpen,
	onRefresh,
}: {
	connected: boolean;
	root: string;
	view: ChangesSnapshot;
	home: string;
	activeKey?: string;
	onOpen: (change: Change) => void;
	onRefresh: () => void;
}) {
	return (
		<div className="min-h-0 flex-1 overflow-auto" data-changes={root}>
			{connected ? <ChangesList view={view} home={home} activeKey={activeKey} onOpen={onOpen} onRefresh={onRefresh} /> : <p className="p-3 text-[12.5px] text-muted">Not connected.</p>}
		</div>
	);
}

export interface EditorTabBodyProps {
	/** The node, which scopes Monaco's models. */
	node: string;
	nodeName: string;
	home: string;
	store: EditorStore;
	tab: EditorTab;
	/** Every editor key open on the node; Monaco drops the models of others. */
	keys: readonly string[];
	theme: Theme;
	diffInline: boolean;
	onDiffInline: (inline: boolean) => void;
	/** The buffer changed: an edited preview is kept. */
	onEdit?: (key: string) => void;
}

/** The diffs on screen, by tab key, for the diff shortcuts: the one focus is in moves. */
const DIFFS = new Map<string, DiffControl>();

/** The diff that `element` (focus, usually) is in. */
export function diffControlAt(element: Element | null): DiffControl | undefined {
	const key = element?.closest("[data-diff-view]")?.getAttribute("data-diff-view");
	return key ? DIFFS.get(key) : undefined;
}

/** One editor tab's body in its group: the file in Monaco with its status, or a diff. Cmd/Ctrl-S saves it. */
export function EditorTabBody(props: EditorTabBodyProps) {
	const { tab, store } = props;
	const diffControl = useRef<DiffControl | null>(null);
	const [diffChanges, setDiffChanges] = useState<number>();
	useEffect(() => () => void DIFFS.delete(tab.key), [tab.key]);
	return (
		<div
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			data-editor-body={tab.key}
			onKeyDown={(event) => {
				// Cmd/Ctrl-S anywhere in the tab saves it, and never opens the browser's own save.
				if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
					event.preventDefault();
					void store.save(tab.key);
				}
			}}
		>
			<TabBody
				{...props}
				diffChanges={diffChanges}
				onDiff={(control) => {
					diffControl.current = control;
					if (control) DIFFS.set(tab.key, control);
					else DIFFS.delete(tab.key);
					setDiffChanges(control?.changes);
				}}
				diffControl={diffControl}
			/>
		</div>
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
	onMenu,
}: {
	tree: FileTree | undefined;
	view: TreeSnapshot;
	dir: string;
	depth: number;
	hidden: boolean;
	activePath?: string;
	onOpen: (path: string, kind: string, how: OpenHow) => void;
	onMenu: (path: string, kind: string, folder: boolean, at: { x: number; y: number; flipY?: number }) => void;
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
								"flex h-[22px] w-full items-center gap-1.5 pr-2 text-left text-[12.5px]",
								path === activePath ? "bg-dk-accent-soft font-medium" : "hover:bg-hover",
							)}
							style={indent}
							{...tip(sanitize(path))}
							onClick={() => onOpen(path, entry.kind, "preview")}
							onContextMenu={(event) => {
								event.preventDefault();
								onMenu(path, entry.kind, folder, menuAtPointer(event));
							}}
							onKeyDown={(event) => {
								if (!isMenuKey(event)) return;
								event.preventDefault();
								onMenu(path, entry.kind, folder, menuBelow(event.currentTarget));
							}}
							onDoubleClick={() => entry.kind !== "dir" && onOpen(path, entry.kind, "open")}
							data-tree-entry={path}
							data-kind={entry.kind}
						>
							<span className="flex w-2.5 shrink-0 justify-center text-muted" aria-hidden="true">
								{folder && (
									<svg width="9" height="9" viewBox="0 0 10 10" className={cx("motion-safe:transition-transform", open && "rotate-90")}>
										<path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
									</svg>
								)}
							</span>
							<Icon name={entry.kind === "dir" ? "folder" : "file"} size={13} className="shrink-0 text-muted" />
							<span className={cx("min-w-0 truncate", entry.kind === "symlink" && "italic")}>{sanitize(entry.name)}</span>
						</button>
						{open && <TreeLevel tree={tree} view={view} dir={path} depth={depth + 1} hidden={hidden} activePath={activePath} onOpen={onOpen} onMenu={onMenu} />}
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

function Centered({ children }: { children: ReactNode }) {
	return <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">{children}</div>;
}

function EditorLoading() {
	return <Centered>Loading the editor…</Centered>;
}

function TabBody(
	props: EditorTabBodyProps & {
		diffChanges?: number;
		onDiff: (control: DiffControl | null) => void;
		diffControl: MutableRefObject<DiffControl | null>;
	},
) {
	const { tab, store, nodeName } = props;
	const editor = (
		<Suspense fallback={<EditorLoading />}>
			<CodeEditor
				scope={props.node}
				tab={tab}
				open={props.keys}
				theme={props.theme}
				onChange={(key, text) => {
					store.edit(key, text);
					props.onEdit?.(key);
				}}
				onSave={(key) => void store.save(key)}
				diffInline={props.diffInline}
				onDiff={props.onDiff}
			/>
		</Suspense>
	);

	if (tab.kind === "diff") return <DiffBody {...props} tab={tab} editor={editor} />;

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

/** A diff tab: what it compares, moving between changes, the layout, and the diff (or why there is none to show). */
function DiffBody(props: EditorTabBodyProps & { tab: DiffTab; editor: ReactNode; diffChanges?: number; diffControl: MutableRefObject<DiffControl | null> }) {
	const { tab, store, editor, diffChanges } = props;
	const name = sanitize(tab.name);
	const sideLabel = tab.blocked ? lowerLabel(tab.labels[tab.blocked.side === "original" ? 0 : 1]) : "";
	const from = tab.from && homePath(sanitize(tab.from), props.home);
	const empty = tab.status === "ready" && !tab.blocked && tab.original === tab.modified;
	const showsDiff = tab.status !== "failed" && !tab.blocked && !empty && !(tab.status === "loading" && !tab.original && !tab.modified);
	return (
		// Focus anywhere in here counts as being in the diff, for its shortcuts.
		<div className="flex min-h-0 flex-1 flex-col" data-diff-view={tab.key}>
			{/* Wraps in a narrow panel, the controls going to a second line, rather than clipping them. */}
			<div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1 text-[12px] text-muted" data-diff-header={tab.path}>
				<span className="min-w-0 max-w-full truncate" {...tip(sanitize(tab.path))}>
					{homePath(sanitize(tab.path), props.home)}
				</span>
				<span className="shrink-0" data-diff-labels="">
					{tab.mode === "untracked" ? "Untracked: every line is new" : `${tab.labels[0]} → ${tab.labels[1]}`}
					{from && <span title={sanitize(tab.from)}>, renamed from {from}</span>}
				</span>
				{showsDiff && diffChanges !== undefined && (
					<span className="shrink-0 tabular-nums" data-diff-count={diffChanges}>
						{diffChanges === 1 ? "1 change" : `${diffChanges.toLocaleString("en")} changes`}
					</span>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-1">
					{showsDiff && (
						<>
							<button
								type="button"
								className={cx(BUTTON.quiet, "h-7 px-2")}
								{...tip("Previous change", "diff.previous")}
								disabled={!diffChanges}
								onClick={() => props.diffControl.current?.go("previous")}
								data-diff-previous=""
							>
								<Icon name="arrowDown" size={13} className="rotate-180" />
								<span className="sr-only">Previous change</span>
							</button>
							<button
								type="button"
								className={cx(BUTTON.quiet, "h-7 px-2")}
								{...tip("Next change", "diff.next")}
								disabled={!diffChanges}
								onClick={() => props.diffControl.current?.go("next")}
								data-diff-next=""
							>
								<Icon name="arrowDown" size={13} />
								<span className="sr-only">Next change</span>
							</button>
							<Segmented
								label="Diff layout"
								size="sm"
								value={props.diffInline ? "inline" : "split"}
								options={[
									["split", "Side by side"],
									["inline", "Inline"],
								]}
								onChange={(value) => props.onDiffInline(value === "inline")}
							/>
						</>
					)}
					<button type="button" className={cx(BUTTON.quiet, "h-7 px-2")} onClick={() => void store.refreshDiff(tab.key)} data-diff-refresh="">
						Refresh
					</button>
				</span>
			</div>
			{tab.status === "failed" ? (
				<div className="p-3">
					<Callout tone="red" title="Could not load the diff">
						{sanitize(tab.error)}
					</Callout>
				</div>
			) : tab.blocked ? (
				<Centered>
					<span data-diff-blocked={tab.blocked.reason}>
						{tab.blocked.reason === "binary"
							? `${name} is binary in the ${sideLabel}; diffs show text files only.`
							: `${name} is over ${READ_LIMIT_LABEL} in the ${sideLabel}, the most a node sends in one read; diff it in the terminal instead.`}
					</span>
				</Centered>
			) : tab.status === "loading" && !tab.original && !tab.modified ? (
				<Centered>Loading the diff…</Centered>
			) : empty ? (
				<Centered>
					<span data-diff-empty="">
						{tab.mode === "untracked"
							? `${name} is empty.`
							: from
								? `Renamed from ${from}, with the same content.`
								: `No changes between ${lowerLabel(tab.labels[0])} and ${lowerLabel(tab.labels[1])}.`}
					</span>
				</Centered>
			) : (
				editor
			)}
		</div>
	);
}

/** A diff side's label inside a sentence: "the index", but "HEAD". */
const lowerLabel = (label: string): string => (label === "HEAD" ? label : label.toLowerCase());

/** The work tree's changes in git's groups; each opens its diff (a conflict, its file). */
export function ChangesList({
	view,
	home,
	activeKey,
	onOpen,
	onRefresh,
}: {
	view: ChangesSnapshot;
	home: string;
	activeKey?: string;
	onOpen: (change: Change) => void;
	onRefresh: () => void;
}) {
	if (view.status === "loading") {
		return (
			<p className="px-3 py-2 text-[12px] text-muted" role="status">
				Loading…
			</p>
		);
	}
	if (view.status === "not_repo") return <p className="px-3 py-2 text-[12.5px] text-muted" data-changes-state="not_repo">This folder is not in a git work tree.</p>;
	if (view.status === "unsupported") {
		return (
			<p className="px-3 py-2 text-[12.5px] text-muted" data-changes-state="unsupported">
				This pika-node has no git.status; update it to list changes.
			</p>
		);
	}
	if (view.status === "failed") {
		return (
			<div className="px-3 py-2 text-[12px] text-red" data-changes-state="failed">
				{sanitize(view.error)}{" "}
				<button type="button" className="underline" onClick={onRefresh}>
					Retry
				</button>
			</div>
		);
	}
	return (
		<>
			<div className="flex items-center gap-1.5 px-3 py-1 text-[12px] text-muted">
				<Icon name="branch" size={12} className="shrink-0" />
				<span className="min-w-0 flex-1 truncate" {...tip(sanitize(view.top))} data-changes-branch={view.branch ?? ""}>
					{view.branch ? sanitize(view.branch) : "Detached HEAD"} · {homePath(sanitize(view.top), home)}
				</span>
				<button type="button" className="shrink-0 underline-offset-2 hover:text-ink hover:underline" onClick={onRefresh} data-changes-refresh="">
					Refresh
				</button>
			</div>
			{view.count === 0 && <p className="px-3 py-2 text-[12.5px] text-muted" data-changes-state="clean">No changes.</p>}
			{CHANGE_GROUPS.map(([group, title]) => {
				const items = view.groups[group];
				if (items.length === 0) return null;
				return (
					<section key={group} aria-label={title} data-change-group={group}>
						<h3 className="px-3 pt-2 pb-0.5 text-[12px] font-semibold text-dk-ink-2">
							{title} <span className="tabular-nums">{items.length.toLocaleString("en")}</span>
						</h3>
						<ul>
							{items.map((change) => {
								const mode = changeMode(change);
								const key = mode ? `diff:${mode}:${change.path}` : `file:${change.path}`;
								const dir = change.relative.includes("/") ? dirName(change.relative) : "";
								return (
									<li key={`${group}:${change.path}`}>
										<button
											type="button"
											className={cx(
												"flex w-full items-center gap-2 py-[3px] pr-2 pl-3 text-left text-[12.5px] hover:bg-hover disabled:cursor-default disabled:opacity-60",
												key === activeKey && "bg-hover font-medium",
											)}
											{...tip(change.submodule ? `${sanitize(change.relative)} is a submodule; open it as a project of its own` : sanitize(change.relative))}
											disabled={change.submodule}
											aria-current={key === activeKey ? "true" : undefined}
											onClick={() => onOpen(change)}
											data-change={change.path}
											data-change-code={change.code}
										>
											<span className="w-3 shrink-0 text-center font-mono text-[11.5px] text-muted" aria-label={codeName(change.code)}>
												{change.code}
											</span>
											<span className={cx("min-w-0 shrink truncate", change.code === "D" && "line-through")}>{sanitize(baseName(change.relative))}</span>
											{dir && <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{sanitize(dir)}</span>}
										</button>
									</li>
								);
							})}
						</ul>
					</section>
				);
			})}
			{view.truncated && (
				<p className="px-3 py-2 text-[11.5px] text-muted" data-changes-truncated="">
					Showing the first {view.count.toLocaleString("en")} changes; the node lists no more.
				</p>
			)}
		</>
	);
}

const CODE_NAMES: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "conflict", "?": "untracked" };
const codeName = (code: string): string => CODE_NAMES[code] ?? code;

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
