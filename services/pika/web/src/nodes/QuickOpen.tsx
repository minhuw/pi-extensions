import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "../components/ui";
import { NodeRequestError } from "./channel";
import { homePath, paneCwd } from "./client";
import { sanitize, type TerminalInfo } from "./contract";
import { joinPath, type NodeFiles } from "./files";
import { rankPaths } from "./fuzzy";
import { rootFor } from "./tree";

type Listing =
	| { status: "loading" }
	| { status: "ready"; root: string; paths: string[]; truncated: boolean }
	| { status: "failed"; root?: string; message: string };

const SHOWN = 50;

/**
 * Quick open: a fuzzy finder over the files of the pane's project (the tree's root, from `projects.list` and the
 * pane's cwd, or the project on screen when given), listed once per opening with `fs.list`. Enter opens the file.
 */
export function QuickOpen({
	files,
	terminal,
	root: project,
	home,
	onPick,
	onClose,
}: {
	files: NodeFiles;
	/** The pane on screen, whose project is listed. */
	terminal?: TerminalInfo;
	/** The folder to list, rather than the pane's project. */
	root?: string;
	home: string;
	onPick: (path: string) => void;
	onClose: () => void;
}) {
	const [listing, setListing] = useState<Listing>({ status: "loading" });
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const listId = useId();

	useEffect(() => {
		let current = true;
		void (async () => {
			let root: string | undefined;
			try {
				if (project) root = project;
				else {
					const [{ projects }, cwd] = await Promise.all([
						files.request("projects.list", {}),
						terminal ? paneCwd((type, params) => files.request(type, params), terminal) : undefined,
					]);
					root = rootFor(projects, cwd, home);
				}
				const listed = await files.request("fs.list", { root });
				if (current) setListing({ status: "ready", root, paths: listed.paths, truncated: listed.truncated });
			} catch (error) {
				if (!current) return;
				const message =
					error instanceof NodeRequestError && error.code === "unsupported"
						? "This pika-node has no fs.list; update it to use quick open."
						: error instanceof NodeRequestError
							? `${error.code}: ${error.message}`
							: error instanceof Error
								? error.message
								: String(error);
				setListing({ status: "failed", ...(root ? { root } : {}), message });
			}
		})();
		return () => {
			current = false;
		};
		// Listed once per opening: the pane's later status changes do not list again.
	}, [files, home]);

	useEffect(() => input.current?.focus(), []);

	const paths = listing.status === "ready" ? listing.paths : undefined;
	const results = useMemo(() => (paths ? rankPaths(query, paths, SHOWN) : []), [paths, query]);
	const active = Math.min(selected, Math.max(0, results.length - 1));

	useEffect(() => {
		list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
	}, [active]);

	const pick = (index: number) => {
		const result = results[index];
		if (!result || listing.status !== "ready") return;
		onPick(joinPath(listing.root, result.path));
	};

	const root = listing.status === "loading" ? undefined : listing.root;

	return (
		<div className="fixed inset-0 z-50 flex justify-center bg-black/30 px-6 pt-[12vh] dark:bg-black/50" onClick={onClose} data-quick-open="">
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Open a file"
				className="flex max-h-[70vh] w-full max-w-[640px] flex-col self-start rounded-sm border border-wb-line-strong bg-page text-ink shadow-[0_16px_40px_rgba(0,0,0,0.22)]"
				onClick={(event) => event.stopPropagation()}
			>
				<input
					ref={input}
					className="h-10 shrink-0 border-b border-line bg-page px-3 text-[14px] outline-none"
					placeholder={root ? `Open a file in ${homePath(sanitize(root), home)}` : "Open a file"}
					aria-label="File name"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setSelected(0);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							onClose();
						} else if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
							event.preventDefault();
							setSelected(Math.min(active + 1, results.length - 1));
						} else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
							event.preventDefault();
							setSelected(Math.max(active - 1, 0));
						} else if (event.key === "Enter") {
							event.preventDefault();
							pick(active);
						}
					}}
					data-quick-open-input=""
				/>
				{listing.status === "loading" && (
					<p className="px-3 py-2 text-[13px] text-muted" role="status">
						Listing files…
					</p>
				)}
				{listing.status === "failed" && <p className="px-3 py-2 text-[13px] text-red">{listing.message}</p>}
				{listing.status === "ready" && results.length === 0 && (
					<p className="px-3 py-2 text-[13px] text-muted">{listing.paths.length ? "No file matches." : "No files here."}</p>
				)}
				<ul ref={list} id={listId} role="listbox" className="min-h-0 overflow-y-auto py-1" data-quick-open-results={results.length}>
					{results.map((result, index) => {
						const slash = result.path.lastIndexOf("/");
						const name = sanitize(result.path.slice(slash + 1));
						const dir = slash > 0 ? sanitize(result.path.slice(0, slash)) : "";
						return (
							<li
								key={result.path}
								id={`${listId}-${index}`}
								role="option"
								aria-selected={index === active}
								data-index={index}
								data-path={result.path}
								className={cx("flex cursor-pointer items-baseline gap-2 px-3 py-1 text-[13px]", index === active && "bg-hover")}
								onMouseMove={() => index !== active && setSelected(index)}
								onClick={() => pick(index)}
							>
								<span className="shrink-0 font-medium">{name}</span>
								<span className="min-w-0 truncate text-[12px] text-muted">{dir}</span>
							</li>
						);
					})}
				</ul>
				{listing.status === "ready" && listing.truncated && (
					<p className="shrink-0 border-t border-line px-3 py-1.5 text-[12px] text-muted">
						Only the first {listing.paths.length.toLocaleString("en")} files are searched.
					</p>
				)}
			</div>
		</div>
	);
}
