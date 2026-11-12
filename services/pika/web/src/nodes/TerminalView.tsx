import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ILink, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Icon } from "../components/icons";
import { BUTTON, Callout, cx } from "../components/ui";
import type { Theme } from "../lib/theme";
import { AttachStream, type ScreenOp } from "./attach";
import { NodeRequestError, type NodeChannel } from "./channel";
import { homePath, paneCwd } from "./client";
import { LIMITS, type TerminalInfo } from "./contract";
import { claimsSize, splitInput } from "./input";
import { actionShortcut, isFindKey, LINK_MODIFIER } from "./keys";
import { cellRange, findPaths, PathChecker, resolvePath, type CellText, type PathMatch } from "./links";
import { clipboardImage, pasteText, runsPi } from "./paste";
import { swallowQueries } from "./queries";
import { WebglRenderer, type Renderer } from "./renderer";
import { onSettled, whenSettled } from "./resize-gate";
import { SizeOwner } from "./size";
import { UploadCancelled, uploadFiles, uploadName, type UploadItem, type UploadProgress } from "./upload";

/** The page's ground and ink, so the terminal reads as part of it in either theme. */
const THEMES: Record<Theme, ITheme> = {
	light: { background: "#ffffff", foreground: "#0b0b0b", cursor: "#0b0b0b", cursorAccent: "#ffffff", selectionBackground: "rgba(11, 11, 11, 0.18)" },
	dark: { background: "#121212", foreground: "#ededed", cursor: "#ededed", cursorAccent: "#121212", selectionBackground: "rgba(237, 237, 237, 0.24)" },
};

export const TERMINAL_OPTIONS = {
	// The same scrollback as the daemon's headless screen; window reports stay off, as there.
	scrollback: 1000,
	fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
	fontSize: 13,
	cursorBlink: true,
	// The search addon highlights matches with decorations, a proposed API; no option here changes a reply.
	allowProposedApi: true,
} as const satisfies ITerminalOptions;

function webgl2Available(): boolean {
	try {
		return document.createElement("canvas").getContext("webgl2") !== null;
	} catch {
		return false;
	}
}

const clamp = (value: number, max: number): number => Math.max(1, Math.min(max, Math.floor(value)));

/** A host smaller than this is not measured: a box on its way in or out would fit to a sliver of a grid. */
const MIN_FIT_PX = { width: 48, height: 32 };

/** Search highlights in either theme; the overview ruler colours are required by the addon even without a ruler. */
const SEARCH_DECORATIONS: Record<Theme, NonNullable<ISearchOptions["decorations"]>> = {
	light: { matchBackground: "#fde68a", matchOverviewRuler: "#d4a72c", activeMatchBackground: "#f59e0b", activeMatchColorOverviewRuler: "#b45309" },
	dark: { matchBackground: "#5c4a12", matchOverviewRuler: "#a37f1a", activeMatchBackground: "#b7791f", activeMatchColorOverviewRuler: "#f59e0b" },
};

const messageOf = (error: unknown): string =>
	error instanceof NodeRequestError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);

/** One buffer line's text with the cell each character sits in, so a link's range covers wide characters right. */
function readLine(term: Terminal, index: number): CellText | undefined {
	const buffer = term.buffer.active;
	const line = buffer.getLine(index);
	if (!line) return undefined;
	const cell = buffer.getNullCell();
	let text = "";
	const cells: number[] = [];
	const widths: number[] = [];
	for (let x = 0; x < line.length; x++) {
		line.getCell(x, cell);
		const width = cell.getWidth();
		// The second half of a wide character.
		if (width === 0) continue;
		const chars = cell.getChars() || " ";
		for (let i = 0; i < chars.length; i++) {
			cells.push(x);
			widths.push(width);
		}
		text += chars;
	}
	return { text, cells, widths };
}

/** The path in an OSC 7 report (`file://host/path`), as shells that announce their directory send it. */
function osc7Path(data: string): string | undefined {
	const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
	if (!match) return undefined;
	try {
		const path = decodeURIComponent(match[1]!);
		return path.includes("\0") ? undefined : path;
	} catch {
		return undefined;
	}
}

const SIZE_FORMAT = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const bytes = (size: number) => (size < 1024 * 1024 ? `${SIZE_FORMAT.format(size / 1024)} KiB` : `${SIZE_FORMAT.format(size / 1024 / 1024)} MiB`);

interface SizeView {
	cols: number;
	rows: number;
	owned: boolean;
	canFitHere: boolean;
	/** A `term.resized` has said who owns the size. */
	told: boolean;
}

/**
 * One node terminal in xterm.js (NODE.md, "Terminals"). It attaches on mount and again on a sequence gap, swallows
 * every terminal query (the daemon answers them), and renders at the PTY's size: this window claims the size on typing
 * or "Fit here", and otherwise shows the size another window set, letterboxed.
 *
 * The workspace's terminal layer mounts it once and only moves it, so `visible` says whether it shows: a hidden view
 * gives back its WebGL context and measures nothing; showing again takes a context and fits its box. A new fit goes
 * to the node only once no pointer is down (`resize-gate.ts`), so a divider drag sends one size, on release.
 */
export function TerminalView({
	channel,
	terminal,
	theme,
	home,
	onKill,
	onOpenFile,
	visible = true,
	onFocus,
}: {
	channel: NodeChannel;
	terminal: TerminalInfo;
	theme: Theme;
	/** The node's home directory, for `~` in paths. */
	home: string;
	onKill: () => void;
	/** Opens a file in the node's editor, at a line when the output named one. */
	onOpenFile: (path: string, at?: { line: number; column?: number }) => void;
	/** Whether the view is on screen. */
	visible?: boolean;
	/** The terminal took keyboard focus. */
	onFocus?: () => void;
}) {
	const { terminalId } = terminal;
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const ownerRef = useRef<SizeOwner | null>(null);
	const [renderer, setRenderer] = useState<Renderer>();
	const [phase, setPhase] = useState<{ kind: "attaching" | "live" } | { kind: "failed"; message: string }>({ kind: "attaching" });
	const [size, setSize] = useState<SizeView>({ cols: terminal.cols, rows: terminal.rows, owned: false, canFitHere: false, told: false });
	const exited = terminal.exited !== undefined;
	const initialTheme = useRef(theme);
	const initialSize = useRef({ cols: terminal.cols, rows: terminal.rows });
	const searchRef = useRef<SearchAddon | null>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const [search, setSearch] = useState<{ query: string; results?: ISearchResultChangeEvent } | null>(null);
	const openSearch = useRef(() => {});
	openSearch.current = () => {
		setSearch((current) => current ?? { query: "" });
		requestAnimationFrame(() => searchInput.current?.select());
	};
	/** Input as if typed: it claims the size like typing does (NODE.md, "Resize"). */
	const sendInput = useRef<(data: string) => void>(() => {});
	const [upload, setUpload] = useState<{ progress: UploadProgress; abort: AbortController } | null>(null);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const uploading = useRef<AbortController | null>(null);
	const [dragging, setDragging] = useState(false);
	const [hoverLink, setHoverLink] = useState<string>();
	const fileInput = useRef<HTMLInputElement>(null);
	// Read by the link provider and the paste, which outlive renders.
	const latest = useRef({ terminal, home, onOpenFile, theme, onFocus });
	latest.current = { terminal, home, onOpenFile, theme, onFocus };
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	const rendererRef = useRef<WebglRenderer<WebglAddon> | null>(null);
	/** Fits the grid to the host now, when it shows; set while the terminal is mounted. */
	const measureRef = useRef<() => void>(() => {});
	/** The shell's directory from OSC 7, when it reports one; else the pane's session or starting cwd. */
	const reportedCwd = useRef<string | undefined>(undefined);

	useEffect(() => {
		const element = host.current!;
		const term = new Terminal({ ...TERMINAL_OPTIONS, cols: initialSize.current.cols, rows: initialSize.current.rows, theme: THEMES[initialTheme.current] });
		// Before anything is written: a query answered here would reach pi as a second reply.
		const swallowing = swallowQueries(term);
		const fit = new FitAddon();
		term.loadAddon(fit);
		const searcher = new SearchAddon();
		term.loadAddon(searcher);
		searchRef.current = searcher;
		const onResults = searcher.onDidChangeResults((results) => setSearch((current) => current && { ...current, results }));
		// Find in the terminal only: elsewhere on the page the browser's own find, or Monaco's, keeps the key.
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown" || !isFindKey(event)) return true;
			event.preventDefault();
			openSearch.current();
			return false;
		});
		// OSC 7 sets no state that changes replies, so the daemon answering queries is unaffected.
		const osc7 = term.parser.registerOscHandler(7, (data) => {
			const path = osc7Path(data);
			if (path) reportedCwd.current = path;
			return true;
		});
		const checker = new PathChecker((dir) => channel.request("fs.readDir", { path: dir }).then((result) => result.entries));
		let asked: { at: number; cwd: Promise<string> } | undefined;
		/** Where relative paths start: the shell's OSC 7 when it sends one, else `paneCwd`, asked at most every 2 s. */
		const cwdNow = (): Promise<string> => {
			const info = latest.current.terminal;
			if (reportedCwd.current && !info.status?.bridgeConnected) return Promise.resolve(reportedCwd.current);
			const now = Date.now();
			if (!asked || now - asked.at > 2_000) asked = { at: now, cwd: paneCwd((type, params) => channel.request(type, params), info) };
			return asked.cwd;
		};
		/** A link for a path the line names, if it is a file on the node. */
		const linkFor = async (line: CellText, y: number, match: PathMatch, cwd: string): Promise<ILink | undefined> => {
			const nodeHome = latest.current.home;
			const path = resolvePath(match.path, cwd, nodeHome);
			if (!path) return undefined;
			const kind = await checker.kind(path);
			if (kind !== "file" && kind !== "symlink") return undefined;
			const { first, last } = cellRange(line, match.start, match.end);
			const at = match.line ? { line: match.line, ...(match.column ? { column: match.column } : {}) } : undefined;
			const label = `${homePath(path, nodeHome)}${match.line ? `:${match.line}${match.column ? `:${match.column}` : ""}` : ""}`;
			return {
				range: { start: { x: first, y }, end: { x: last, y } },
				text: line.text.slice(match.start, match.end),
				decorations: { underline: true, pointerCursor: true },
				activate: (event) => {
					if (!event.metaKey && !event.ctrlKey) return;
					event.preventDefault();
					latest.current.onOpenFile(path, at);
				},
				hover: () => setHoverLink(label),
				leave: () => setHoverLink(undefined),
			};
		};
		const links = term.registerLinkProvider({
			provideLinks(y, callback) {
				const line = readLine(term, y - 1);
				const matches = line ? findPaths(line.text) : [];
				if (!line || matches.length === 0) return callback(undefined);
				const relative = matches.some((match) => !match.path.startsWith("/") && !match.path.startsWith("~"));
				void (relative ? cwdNow() : Promise.resolve("/"))
					.then((cwd) => Promise.all(matches.map((match) => linkFor(line, y, match, cwd))))
					.then(
						(found) => {
							const present = found.filter((link): link is ILink => link !== undefined);
							callback(present.length ? present : undefined);
						},
						() => callback(undefined),
					);
			},
		});
		term.open(element);
		termRef.current = term;
		const focused = () => latest.current.onFocus?.();
		term.textarea?.addEventListener("focus", focused);

		const renderer = new WebglRenderer<WebglAddon>(term, () => new WebglAddon(), setRenderer, webgl2Available());
		rendererRef.current = renderer;
		if (visibleRef.current) renderer.show();

		let disposed = false;
		let attachToken = 0;
		const stream = new AttachStream();
		const owner = new SizeOwner(initialSize.current, (notice) => {
			channel.notify({ type: "term.resize", terminalId, ...notice }).catch(() => {});
		});
		ownerRef.current = owner;
		let told = false;
		const publish = () => setSize({ ...owner.size, owned: owner.owned, canFitHere: owner.canFitHere, told });

		const measure = () => {
			if (!visibleRef.current || element.clientWidth < MIN_FIT_PX.width || element.clientHeight < MIN_FIT_PX.height) return;
			const proposed = fit.proposeDimensions();
			if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
			owner.fitChanged({ cols: clamp(proposed.cols, LIMITS.maxCols), rows: clamp(proposed.rows, LIMITS.maxRows) });
			publish();
		};

		const apply = (ops: ScreenOp[]) => {
			for (const op of ops) {
				if (op.op === "reset") {
					term.reset();
					term.resize(op.cols, op.rows);
				} else if (op.op === "write") term.write(op.data);
				else attach();
			}
		};

		const attach = () => {
			const token = ++attachToken;
			stream.begin();
			setPhase({ kind: "attaching" });
			channel.request("term.attach", { terminalId }).then(
				(result) => {
					if (disposed || token !== attachToken) return;
					owner.attached(result.terminal);
					told = false;
					apply(stream.snapshot(result.snapshot));
					setPhase({ kind: "live" });
					measure();
					publish();
				},
				(error: unknown) => {
					if (disposed || token !== attachToken) return;
					setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
				},
			);
		};

		const offEvents = channel.onEvent((event) => {
			if (!("terminalId" in event) || event.terminalId !== terminalId) return;
			if (event.type === "term.output") apply(stream.output(event.seq, event.data));
			else if (event.type === "term.snapshot") apply(stream.snapshot(event.snapshot));
			else if (event.type === "term.resized") {
				owner.resized(event);
				told = true;
				term.resize(event.cols, event.rows);
				publish();
			}
		});

		const send = (data: string) => {
			if (claimsSize(data)) owner.input();
			for (const chunk of splitInput(data)) channel.notify({ type: "term.input", terminalId, data: chunk }).catch(() => {});
			publish();
		};
		sendInput.current = send;
		const onData = term.onData(send);

		measureRef.current = measure;
		let measureTimer: ReturnType<typeof setTimeout> | undefined;
		let pendingMeasure = () => {};
		const observer = new ResizeObserver(() => {
			clearTimeout(measureTimer);
			pendingMeasure();
			measureTimer = setTimeout(() => {
				pendingMeasure = whenSettled(measure);
			}, 80);
		});
		observer.observe(element);
		const offSettled = onSettled(measure);

		// Subscribed first, so output from the attach on is buffered.
		attach();

		return () => {
			disposed = true;
			clearTimeout(measureTimer);
			pendingMeasure();
			offSettled();
			observer.disconnect();
			term.textarea?.removeEventListener("focus", focused);
			measureRef.current = () => {};
			offEvents();
			onData.dispose();
			onResults.dispose();
			osc7.dispose();
			links.dispose();
			sendInput.current = () => {};
			// An upload in flight is deleted on the node: there is no pane left to paste its paths into.
			uploading.current?.abort();
			channel.request("term.detach", { terminalId }).catch(() => {});
			swallowing.dispose();
			renderer.dispose();
			rendererRef.current = null;
			term.dispose();
			termRef.current = null;
			ownerRef.current = null;
			searchRef.current = null;
		};
	}, [channel, terminalId]);

	useEffect(() => {
		if (termRef.current) termRef.current.options.theme = THEMES[theme];
	}, [theme]);

	// Shown: a WebGL context again, a redraw, and a fit once the box has its size. Hidden: the context goes back.
	useEffect(() => {
		const renderer = rendererRef.current;
		const term = termRef.current;
		if (!renderer || !term) return;
		if (!visible) {
			renderer.hide();
			return;
		}
		renderer.show();
		let drop = () => {};
		const frame = requestAnimationFrame(() => {
			term.refresh(0, term.rows - 1);
			drop = whenSettled(() => measureRef.current());
		});
		return () => {
			cancelAnimationFrame(frame);
			drop();
		};
	}, [visible]);

	useEffect(() => {
		if (termRef.current) termRef.current.options.disableStdin = exited;
	}, [exited]);

	const fitHere = () => {
		ownerRef.current?.fitHere();
		termRef.current?.focus();
	};

	/** Typing searches from the current match on (`incremental`); Enter and the buttons move to the next or previous. */
	const find = (query: string, backwards = false, incremental = false) => {
		const searcher = searchRef.current;
		if (!searcher) return;
		if (!query) {
			searcher.clearDecorations();
			setSearch((current) => current && { query, results: undefined });
			return;
		}
		const options: ISearchOptions = { decorations: SEARCH_DECORATIONS[latest.current.theme] };
		if (backwards) searcher.findPrevious(query, options);
		else searcher.findNext(query, { ...options, incremental });
	};

	const closeSearch = () => {
		searchRef.current?.clearDecorations();
		setSearch(null);
		termRef.current?.focus();
	};

	/** Uploads to the node's uploads directory, then puts the paths on the pane's input line (NODE.md, "Upload"). */
	const send = async (items: UploadItem[]) => {
		if (uploading.current || items.length === 0) return;
		const abort = new AbortController();
		uploading.current = abort;
		setUploadError(null);
		const total = items.reduce((sum, item) => sum + item.blob.size, 0);
		setUpload({ abort, progress: { index: 0, count: items.length, name: items[0]!.name, sent: 0, total } });
		try {
			const done = await uploadFiles((type, params) => channel.request(type, params), items, {
				signal: abort.signal,
				onProgress: (progress) => setUpload({ abort, progress }),
			});
			const term = termRef.current;
			if (abort.signal.aborted || !term || latest.current.terminal.exited) return;
			sendInput.current(pasteText(done.map((item) => item.path), { bracketed: term.modes.bracketedPasteMode, pi: runsPi(latest.current.terminal) }));
			term.focus();
		} catch (error) {
			if (!(error instanceof UploadCancelled)) setUploadError(messageOf(error));
		} finally {
			uploading.current = null;
			setUpload(null);
		}
	};

	const dropped = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		if (exited) return;
		const folder = Array.from(event.dataTransfer.items).find((item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory);
		if (folder) {
			setUploadError("Folders cannot be uploaded; drop the files in them instead.");
			return;
		}
		void send(Array.from(event.dataTransfer.files, (file) => ({ blob: file, name: uploadName(file.name) })));
	};

	const percent = upload && upload.progress.total > 0 ? Math.floor((upload.progress.sent / upload.progress.total) * 100) : 0;

	return (
		<div
			className="flex min-h-0 flex-1 flex-col"
			data-terminal-view={terminalId}
			onDragOver={(event) => {
				if (exited || !event.dataTransfer.types.includes("Files")) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
				setDragging(true);
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
			}}
			onDrop={dropped}
			onPasteCapture={(event) => {
				// An image with no text, as a screenshot is: pi takes the uploaded file's path, as its own Ctrl+V does.
				if (exited || event.clipboardData.getData("text/plain")) return;
				const image = clipboardImage(event.clipboardData);
				if (!image) return;
				event.preventDefault();
				event.stopPropagation();
				void send([image]);
			}}
		>
			<div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3 text-[12.5px] text-muted">
				<span className="tabular-nums" data-terminal-size="">
					{size.cols}×{size.rows}
				</span>
				{size.told && <span className="shrink-0 whitespace-nowrap" data-size-owner={size.owned ? "here" : "elsewhere"}>{size.owned ? "Sized by this window" : "Sized by another window"}</span>}
				{size.canFitHere && (
					<button type="button" className={cx(BUTTON.quiet, "h-7 px-2")} onClick={fitHere} data-fit-here="">
						Fit here
					</button>
				)}
				{renderer && renderer !== "webgl" && renderer !== "hidden" && (
					<span className="text-ink" data-renderer="dom" title="xterm.js draws with DOM elements, which is slower for heavy output">
						{renderer === "no-webgl"
							? "WebGL is unavailable here; drawing with the DOM renderer"
							: renderer === "context-lost"
								? "The WebGL context was lost; drawing with the DOM renderer"
								: "WebGL failed to start; drawing with the DOM renderer"}
					</span>
				)}
				{phase.kind === "attaching" && <span role="status">Attaching…</span>}
				{hoverLink && (
					<span className="min-w-0 truncate" data-link-hint="">
						{LINK_MODIFIER}-click opens {hoverLink}
					</span>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-1">
					<button
						type="button"
						className={cx(BUTTON.quiet, "h-7 px-2")}
						onClick={() => openSearch.current()}
						title={actionShortcut("find") ? `Find (${actionShortcut("find")})` : "Find"}
						data-find-open=""
					>
						<Icon name="search" size={13} />
						<span className="sr-only">Find</span>
					</button>
					{!exited && (
						<>
							<button
								type="button"
								className={cx(BUTTON.quiet, "h-7 px-2")}
								disabled={upload !== null}
								onClick={() => fileInput.current?.click()}
								title="Upload files to the node and paste their paths (or drop them on the terminal)"
								data-upload-pick=""
							>
								Upload
							</button>
							<input
								ref={fileInput}
								type="file"
								multiple
								hidden
								onChange={(event) => {
									const picked = Array.from(event.target.files ?? [], (file) => ({ blob: file, name: uploadName(file.name) }));
									event.target.value = "";
									void send(picked);
								}}
								data-upload-input=""
							/>
						</>
					)}
					<button type="button" className={cx(BUTTON.quiet, "h-7 px-2")} onClick={onKill} data-kill-terminal="">
						{exited ? "Remove" : "Kill"}
					</button>
				</span>
			</div>
			{search && (
				<div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12.5px]" data-terminal-search="">
					<input
						ref={searchInput}
						className="h-7 w-[220px] min-w-0 rounded-sm border border-line bg-page px-2 text-[12.5px]"
						aria-label="Find in the terminal"
						placeholder="Find"
						value={search.query}
						autoFocus
						onChange={(event) => {
							const query = event.target.value;
							setSearch((current) => current && { ...current, query });
							find(query, false, true);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								closeSearch();
							} else if (event.key === "Enter") {
								event.preventDefault();
								find(search.query, event.shiftKey);
							} else if (isFindKey(event.nativeEvent)) {
								event.preventDefault();
								event.currentTarget.select();
							}
						}}
						data-find-input=""
					/>
					<span className="tabular-nums text-muted" role="status" data-find-results="">
						{search.query && search.results
							? search.results.resultCount === 0
								? "No matches"
								: search.results.resultIndex >= 0
									? `${search.results.resultIndex + 1} of ${search.results.resultCount}`
									: `${search.results.resultCount} matches`
							: ""}
					</span>
					<button type="button" className={cx(BUTTON.quiet, "h-7 px-2")} onClick={() => find(search.query, true)} disabled={!search.query} data-find-previous="">
						Previous
					</button>
					<button type="button" className={cx(BUTTON.quiet, "h-7 px-2")} onClick={() => find(search.query)} disabled={!search.query} data-find-next="">
						Next
					</button>
					<button type="button" className={cx(BUTTON.quiet, "ml-auto h-7 px-2")} onClick={closeSearch} aria-label="Close find" data-find-close="">
						<Icon name="close" size={13} />
					</button>
				</div>
			)}
			{upload && (
				<div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3 text-[12.5px]" role="status" data-upload-progress={percent}>
					<span className="min-w-0 truncate">
						Uploading {upload.progress.name}
						{upload.progress.count > 1 ? ` (${upload.progress.index + 1} of ${upload.progress.count})` : ""}
					</span>
					<span className="h-1.5 w-[120px] shrink-0 overflow-hidden rounded-full bg-hover" aria-hidden="true">
						<span className="block h-full bg-ink" style={{ width: `${percent}%` }} />
					</span>
					<span className="shrink-0 tabular-nums text-muted">
						{bytes(upload.progress.sent)} of {bytes(upload.progress.total)}
					</span>
					<button type="button" className={cx(BUTTON.quiet, "ml-auto h-7 px-2")} onClick={() => upload.abort.abort()} data-upload-cancel="">
						Cancel
					</button>
				</div>
			)}
			{uploadError && (
				<div className="shrink-0 px-3 pt-2" data-upload-error="">
					<Callout tone="red" title="Upload failed">
						{uploadError}
						<button type="button" className={cx(BUTTON.quiet, "ml-2 h-6 px-1.5")} onClick={() => setUploadError(null)}>
							Dismiss
						</button>
					</Callout>
				</div>
			)}
			{exited && (
				<div className="shrink-0 border-b border-line bg-soft px-3 py-1.5 text-[12.5px]" data-terminal-exited="">
					Exited
					{terminal.exited!.code !== null ? ` with code ${terminal.exited!.code}` : ""}
					{terminal.exited!.signal ? ` by ${terminal.exited!.signal}` : ""}. Its last screen stays until you remove it.
				</div>
			)}
			{phase.kind === "failed" && (
				<div className="shrink-0 p-3">
					<Callout tone="red" title="Could not attach">
						{phase.message}
					</Callout>
				</div>
			)}
			<div className="relative flex min-h-0 flex-1 flex-col">
				{/* No padding here: the fit addon measures this element. A non-owner's grid is smaller or larger than it, letterboxed or scrolled. */}
				<div ref={host} className="min-h-0 flex-1 overflow-auto bg-page" data-terminal-host="" />
				{dragging && (
					<div
						className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-sm border-2 border-dashed border-ink bg-page/85 text-[14px] font-medium"
						data-drop-target=""
					>
						Drop to upload, then paste the paths here
					</div>
				)}
			</div>
		</div>
	);
}
