/**
 * The agent rail's dialogs and small surfaces: Add Project (a path on the node, completed from its folders), New
 * Worktree (Orca's flow: a branch, a base, and pi started in it), the inline rename field, and the undo notice that
 * follows a removal (T3 Code's: the change is made at once, and Undo puts it back for five seconds).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BUTTON, cx, Dialog } from "../../components/ui";

const FIELD =
	"h-7 w-full rounded-[4px] border border-dk-line-strong bg-dk-raised px-2 font-mono text-[12.5px] text-dk-ink outline-none placeholder:text-dk-ink-3 focus:border-dk-accent focus:shadow-[0_0_0_2px_var(--dk-accent-soft)]";
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `~` and `~/…` on the node, under its home; an absolute path as it is; anything else is undefined. */
export function expandHome(path: string, home: string): string | undefined {
	if (path === "~") return home;
	if (path.startsWith("~/")) return `${home === "/" ? "" : home}/${path.slice(2)}`;
	return path.startsWith("/") ? path : undefined;
}

/** A typed path split at its last slash: the folder to list, and the start of the name typed in it. */
export function completionParts(value: string): { dir: string; prefix: string } | undefined {
	const slash = value.lastIndexOf("/");
	if (slash < 0) return undefined;
	return { dir: value.slice(0, slash + 1), prefix: value.slice(slash + 1) };
}

/** The folders of `names` a prefix starts (case aside); hidden ones only when the prefix starts with a dot. */
export function matchFolders(names: readonly string[], prefix: string, limit = 50): string[] {
	const lower = prefix.toLowerCase();
	return names.filter((name) => (prefix.startsWith(".") || !name.startsWith(".")) && name.toLowerCase().startsWith(lower)).slice(0, limit);
}

/**
 * Add Project: a path on the node, `~` for its home. As it is typed, the folders of the directory it names are offered
 * (`fs.readDir`, folders only): arrows pick one, Tab or a click completes it. Enter adds the path typed (or completes
 * the one picked); an error stays under the field.
 */
export function AddProjectDialog({
	nodeName,
	home,
	listFolders,
	onAdd,
	onCancel,
}: {
	nodeName: string;
	home: string;
	/** A directory's folder names on the node; rejects when it cannot be read. */
	listFolders: (dir: string) => Promise<string[]>;
	onAdd: (path: string) => Promise<void>;
	onCancel: () => void;
}) {
	const [value, setValue] = useState("~/");
	const [folders, setFolders] = useState<{ dir: string; names: string[] }>();
	const [picked, setPicked] = useState(-1);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const cache = useRef(new Map<string, Promise<string[]>>());
	const listId = useId();
	const parts = completionParts(value);
	const dir = parts ? expandHome(parts.dir.length > 1 ? parts.dir.slice(0, -1) : parts.dir, home) : undefined;

	useEffect(() => input.current?.focus(), []);
	useEffect(() => {
		if (!dir) return;
		let current = true;
		let request = cache.current.get(dir);
		if (!request) {
			request = listFolders(dir).catch(() => []);
			cache.current.set(dir, request);
		}
		void request.then((names) => {
			if (current) setFolders({ dir, names });
		});
		return () => {
			current = false;
		};
	}, [dir, listFolders]);

	const suggestions = useMemo(() => (parts && folders && folders.dir === dir ? matchFolders(folders.names, parts.prefix) : []), [parts?.prefix, folders, dir]);
	const complete = (name: string) => {
		if (!parts) return;
		setValue(`${parts.dir}${name}/`);
		setPicked(-1);
		setError(undefined);
		input.current?.focus();
	};
	const submit = async () => {
		const typed = value.trim();
		const expanded = expandHome(typed, home);
		if (!expanded) {
			setError("Give an absolute path, or one that starts with ~");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await onAdd(expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded);
		} catch (failure) {
			setError(errorText(failure));
			setBusy(false);
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (suggestions.length === 0) return;
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setPicked((at) => (at + step + suggestions.length + (at < 0 && step < 0 ? 1 : 0)) % suggestions.length);
		} else if (event.key === "Tab" && suggestions.length > 0 && !event.shiftKey) {
			event.preventDefault();
			complete(suggestions[Math.max(picked, 0)]!);
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (picked >= 0 && suggestions[picked]) complete(suggestions[picked]);
			else void submit();
		}
	};
	const optionId = (index: number) => `${listId}-${index}`;
	return (
		<Dialog title={`Add a project on ${nodeName}`} onCancel={onCancel} locked={busy} label="add-project">
			<p className="mt-1 text-[13px] text-muted">A folder on the node, shown to every browser. Nothing on disk changes.</p>
			<label className="mt-3 block text-[12px] font-medium text-muted" htmlFor={`${listId}-path`}>
				Folder
			</label>
			<input
				ref={input}
				id={`${listId}-path`}
				className={cx(FIELD, "mt-1")}
				value={value}
				spellCheck={false}
				autoComplete="off"
				role="combobox"
				aria-expanded={suggestions.length > 0}
				aria-controls={listId}
				aria-autocomplete="list"
				{...(picked >= 0 ? { "aria-activedescendant": optionId(picked) } : {})}
				aria-invalid={error ? true : undefined}
				onChange={(event) => {
					setValue(event.target.value);
					setPicked(-1);
					setError(undefined);
				}}
				onKeyDown={onKeyDown}
				data-add-project-path=""
			/>
			{suggestions.length > 0 && (
				<ul id={listId} role="listbox" aria-label="Folders" className="mt-1 max-h-[180px] overflow-y-auto rounded-[4px] border border-dk-line py-0.5 font-mono text-[12.5px]" data-folder-suggestions="">
					{suggestions.map((name, index) => (
						<li
							key={name}
							id={optionId(index)}
							role="option"
							aria-selected={index === picked}
							className={cx("cursor-default truncate px-2 py-0.5", index === picked ? "bg-[var(--dk-menu-hi)]" : "hover:bg-dk-hover")}
							onPointerDown={(event) => {
								event.preventDefault();
								complete(name);
							}}
							data-folder={name}
						>
							{name}/
						</li>
					))}
				</ul>
			)}
			{error && (
				<p className="mt-2 text-[13px] text-red" role="alert" data-dialog-error="">
					{error}
				</p>
			)}
			<div className="mt-5 flex justify-end gap-2">
				<button type="button" className={BUTTON.secondary} onClick={onCancel} disabled={busy}>
					Cancel
				</button>
				<button type="button" className={BUTTON.primary} onClick={() => void submit()} disabled={busy || !value.trim()} data-add-project-submit="">
					{busy ? "Adding…" : "Add Project"}
				</button>
			</div>
		</Dialog>
	);
}

export interface WorktreeRequest {
	branch: string;
	/** Empty: the project's current commit. */
	base?: string;
	startAgent: boolean;
}

/**
 * New Worktree, as Orca makes one: a new branch from a base (the project's current commit by default), checked out
 * beside the repository, with pi started in it unless unchecked. The node checks the branch name with git.
 */
export function NewWorktreeDialog({ projectName, onCreate, onCancel }: { projectName: string; onCreate: (request: WorktreeRequest) => Promise<void>; onCancel: () => void }) {
	const [branch, setBranch] = useState("");
	const [base, setBase] = useState("");
	const [startAgent, setStartAgent] = useState(true);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const id = useId();
	const first = useRef<HTMLInputElement>(null);
	useEffect(() => first.current?.focus(), []);
	const submit = async () => {
		const name = branch.trim();
		if (!name) {
			setError("Name the new branch");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await onCreate({ branch: name, ...(base.trim() ? { base: base.trim() } : {}), startAgent });
		} catch (failure) {
			setError(errorText(failure));
			setBusy(false);
		}
	};
	const enter = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		void submit();
	};
	return (
		<Dialog title={`New worktree of ${projectName}`} onCancel={onCancel} locked={busy} label="new-worktree">
			<p className="mt-1 text-[13px] text-muted">A new branch, checked out in a folder beside the repository.</p>
			<label className="mt-3 block text-[12px] font-medium text-muted" htmlFor={`${id}-branch`}>
				Branch
			</label>
			<input
				ref={first}
				id={`${id}-branch`}
				className={cx(FIELD, "mt-1")}
				value={branch}
				placeholder="feature/name"
				spellCheck={false}
				autoComplete="off"
				aria-invalid={error ? true : undefined}
				onChange={(event) => {
					setBranch(event.target.value);
					setError(undefined);
				}}
				onKeyDown={enter}
				data-worktree-branch=""
			/>
			<label className="mt-3 block text-[12px] font-medium text-muted" htmlFor={`${id}-base`}>
				Start from
			</label>
			<input
				id={`${id}-base`}
				className={cx(FIELD, "mt-1")}
				value={base}
				placeholder="HEAD (the project's current commit)"
				spellCheck={false}
				autoComplete="off"
				onChange={(event) => setBase(event.target.value)}
				onKeyDown={enter}
				data-worktree-base=""
			/>
			<label className="mt-3 flex items-center gap-2 text-[13px]">
				<input type="checkbox" checked={startAgent} onChange={(event) => setStartAgent(event.target.checked)} data-worktree-start-agent="" />
				Start pi in it
			</label>
			{error && (
				<p className="mt-2 text-[13px] text-red" role="alert" data-dialog-error="">
					{error}
				</p>
			)}
			<div className="mt-5 flex justify-end gap-2">
				<button type="button" className={BUTTON.secondary} onClick={onCancel} disabled={busy}>
					Cancel
				</button>
				<button type="button" className={BUTTON.primary} onClick={() => void submit()} disabled={busy} data-worktree-submit="">
					{busy ? "Creating…" : "Create Worktree"}
				</button>
			</div>
		</Dialog>
	);
}

/**
 * A name edited in place: Enter or leaving the field saves (blank text clears the name), Escape gives up. The field
 * stops the rail's own keys while it has focus.
 */
export function InlineRename({ initial, label, onCommit, onCancel, className }: { initial: string; label: string; onCommit: (name: string | null) => void; onCancel: () => void; className?: string }) {
	const [value, setValue] = useState(initial);
	const field = useRef<HTMLInputElement>(null);
	const done = useRef(false);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const finish = (commit: boolean) => {
		if (done.current) return;
		done.current = true;
		if (!commit) return onCancel();
		const trimmed = value.trim();
		if (trimmed === initial.trim()) return onCancel();
		onCommit(trimmed || null);
	};
	return (
		<input
			ref={field}
			className={cx("h-6 min-w-0 flex-1 rounded-[2px] border border-dk-accent bg-dk-ground px-1 text-[13px] text-dk-ink outline-none", className)}
			value={value}
			aria-label={label}
			maxLength={120}
			spellCheck={false}
			onChange={(event) => setValue(event.target.value)}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Enter") {
					event.preventDefault();
					finish(true);
				} else if (event.key === "Escape") {
					event.preventDefault();
					finish(false);
				}
			}}
			onBlur={() => finish(true)}
			onClick={(event) => event.stopPropagation()}
			data-inline-rename=""
		/>
	);
}

export interface UndoNotice {
	/** Changes with each notice, so a new one restarts the timer. */
	id: number;
	message: string;
	undo: () => Promise<void> | void;
}

/** How long Undo stays offered, as in T3 Code's thread notices. */
export const UNDO_MS = 5_000;

/** A removal's notice with its Undo, for five seconds (held while the pointer is on it). */
export function UndoToast({ notice, onDone }: { notice: UndoNotice; onDone: () => void }) {
	const [hovered, setHovered] = useState(false);
	const [failed, setFailed] = useState<string>();
	const left = useRef(UNDO_MS);
	useEffect(() => {
		if (hovered) return;
		const started = Date.now();
		const timer = setTimeout(onDone, left.current);
		return () => {
			clearTimeout(timer);
			left.current = Math.max(1_000, left.current - (Date.now() - started));
		};
	}, [hovered, onDone, notice.id]);
	return (
		<div
			className="dk-menu fixed bottom-9 left-3 z-40 flex max-w-[360px] items-center gap-3 px-3 py-2 text-[13px]"
			role="status"
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
			data-undo-notice=""
		>
			<span className="min-w-0 flex-1">{failed ?? notice.message}</span>
			{!failed && (
				<button
					type="button"
					className="shrink-0 rounded-[3px] px-1.5 font-medium text-dk-accent hover:bg-dk-hover"
					onClick={() =>
						void Promise.resolve(notice.undo()).then(onDone, (error: unknown) => {
							setFailed(`Undo failed: ${errorText(error)}`);
							setHovered(false);
						})
					}
					data-undo=""
				>
					Undo
				</button>
			)}
		</div>
	);
}
