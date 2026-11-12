/**
 * Deck's dialogs and small surfaces, on shadcn/ui's primitives (`components/ui-shadcn`): Add Project (a path on the
 * node, completed from its folders), New Worktree (Orca's flow: a branch, a base, and pi started in it), the
 * confirmations (kill, close unsaved, remove a worktree, forget a key), the inline rename field, and the undo notice
 * that follows a removal (T3 Code's: the change is made at once, and Undo puts it back for five seconds).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "../../components/ui-shadcn/alert-dialog";
import { Autocomplete, AutocompleteInput, AutocompleteItem, AutocompleteList } from "../../components/ui-shadcn/autocomplete";
import { Button } from "../../components/ui-shadcn/button";
import { Checkbox } from "../../components/ui-shadcn/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../components/ui-shadcn/dialog";
import { Input } from "../../components/ui-shadcn/input";
import { Toast, ToastAction, ToastProvider, ToastTitle, ToastViewport, useToastManager } from "../../components/ui-shadcn/toast";
import { cn } from "../../components/ui-shadcn/utils";

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
 * (`fs.readDir`, folders only) in a list under the field (Base UI's Autocomplete): arrows pick one, Tab, Enter or a
 * click completes it. Enter with nothing picked adds the path typed; an error stays under the field.
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
	const [picked, setPicked] = useState<string>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const cache = useRef(new Map<string, Promise<string[]>>());
	const id = useId();
	const parts = completionParts(value);
	const dir = parts ? expandHome(parts.dir.length > 1 ? parts.dir.slice(0, -1) : parts.dir, home) : undefined;

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

	// Each suggestion is the whole completed path, so choosing one fills it in.
	const suggestions = useMemo(
		() => (parts && folders && folders.dir === dir ? matchFolders(folders.names, parts.prefix).map((name) => ({ name, path: `${parts.dir}${name}/` })) : []),
		[parts?.dir, parts?.prefix, folders, dir],
	);
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
	const complete = (path: string) => {
		setValue(path);
		setPicked(undefined);
		setError(undefined);
	};
	// Tab completes the folder picked (or the first); Enter completes the one picked, or adds what is typed.
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		const chosen = suggestions.find((suggestion) => suggestion.path === picked)?.path;
		if (event.key === "Tab" && suggestions.length > 0 && !event.shiftKey) {
			event.preventDefault();
			complete(chosen ?? suggestions[0]!.path);
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (chosen) complete(chosen);
			else void submit();
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
			<DialogContent data-dialog="add-project">
				<DialogTitle>Add a project on {nodeName}</DialogTitle>
				<DialogDescription>A folder on the node, shown to every browser. Nothing on disk changes.</DialogDescription>
				<label className="mt-3 block text-[12px] font-medium text-dk-ink-2" htmlFor={`${id}-path`}>
					Folder
				</label>
				<Autocomplete
					inline
					open
					mode="none"
					items={suggestions}
					itemToStringValue={(suggestion: { path: string }) => suggestion.path}
					value={value}
					onValueChange={(next) => {
						setValue(next);
						setPicked(undefined);
						setError(undefined);
					}}
					onItemHighlighted={(suggestion: { path: string } | undefined) => setPicked(suggestion?.path)}
				>
					<AutocompleteInput
						id={`${id}-path`}
						className="mt-1"
						spellCheck={false}
						autoComplete="off"
						autoFocus
						aria-invalid={error ? true : undefined}
						onKeyDown={onKeyDown}
						data-add-project-path=""
					/>
					<AutocompleteList aria-label="Folders" className="mt-1" data-folder-suggestions="">
						{(suggestion: { name: string; path: string }) => (
							<AutocompleteItem key={suggestion.path} value={suggestion} onClick={() => complete(suggestion.path)} data-folder={suggestion.name}>
								{suggestion.name}/
							</AutocompleteItem>
						)}
					</AutocompleteList>
				</Autocomplete>
				{error && (
					<p className="mt-2 text-[13px] text-dk-failed-ink" role="alert" data-dialog-error="">
						{error}
					</p>
				)}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />} disabled={busy}>
						Cancel
					</DialogClose>
					<Button onClick={() => void submit()} disabled={busy || !value.trim()} data-add-project-submit="">
						{busy ? "Adding…" : "Add Project"}
					</Button>
				</DialogFooter>
			</DialogContent>
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
		<Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
			<DialogContent data-dialog="new-worktree">
				<DialogTitle>New worktree of {projectName}</DialogTitle>
				<DialogDescription>A new branch, checked out in a folder beside the repository.</DialogDescription>
				<label className="mt-3 block text-[12px] font-medium text-dk-ink-2" htmlFor={`${id}-branch`}>
					Branch
				</label>
				<Input
					id={`${id}-branch`}
					className="mt-1"
					value={branch}
					placeholder="feature/name"
					spellCheck={false}
					autoComplete="off"
					aria-invalid={error ? true : undefined}
					onValueChange={(next) => {
						setBranch(next);
						setError(undefined);
					}}
					onKeyDown={enter}
					data-worktree-branch=""
				/>
				<label className="mt-3 block text-[12px] font-medium text-dk-ink-2" htmlFor={`${id}-base`}>
					Start from
				</label>
				<Input
					id={`${id}-base`}
					className="mt-1"
					value={base}
					placeholder="HEAD (the project's current commit)"
					spellCheck={false}
					autoComplete="off"
					onValueChange={setBase}
					onKeyDown={enter}
					data-worktree-base=""
				/>
				<label className="mt-3 flex w-fit items-center gap-2 text-[13px]">
					<Checkbox checked={startAgent} onCheckedChange={setStartAgent} data-worktree-start-agent="" />
					Start pi in it
				</label>
				{error && (
					<p className="mt-2 text-[13px] text-dk-failed-ink" role="alert" data-dialog-error="">
						{error}
					</p>
				)}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />} disabled={busy}>
						Cancel
					</DialogClose>
					<Button onClick={() => void submit()} disabled={busy} data-worktree-submit="">
						{busy ? "Creating…" : "Create Worktree"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * A confirmation of something that ends or destroys (Kill, Close without saving, Remove Worktree, Forget the Key):
 * Cancel has focus first, Escape cancels, and a press beside it does nothing. `busy` disables the confirmation;
 * `locked` also disables Cancel and Escape while the confirmed action runs.
 */
export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	busy = false,
	locked = false,
	onConfirm,
	onCancel,
	label,
}: {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	busy?: boolean;
	locked?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	/** `data-dialog` value, for tests and e2e. */
	label?: string;
}) {
	const cancel = useRef<HTMLButtonElement>(null);
	return (
		<AlertDialog open onOpenChange={(open) => !open && !locked && onCancel()}>
			<AlertDialogContent initialFocus={cancel} data-dialog={label}>
				<AlertDialogTitle>{title}</AlertDialogTitle>
				<AlertDialogDescription render={<div />}>{children}</AlertDialogDescription>
				<AlertDialogFooter>
					<AlertDialogClose ref={cancel} render={<Button variant="outline" />} disabled={locked}>
						Cancel
					</AlertDialogClose>
					<Button variant="destructive" onClick={onConfirm} disabled={busy || locked} data-confirm="">
						{confirmLabel}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
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
			className={cn("h-6 min-w-0 flex-1 rounded-[2px] border border-dk-accent bg-dk-ground px-1 text-[13px] text-dk-ink outline-none", className)}
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

/**
 * A removal's notice with its Undo, for five seconds: Base UI's toast holds the timer while the pointer or focus is
 * on it. A failed undo says so in place of the message, for another five seconds.
 */
export function UndoToast({ notice, onDone }: { notice: UndoNotice; onDone: () => void }) {
	return (
		<ToastProvider timeout={UNDO_MS} limit={1}>
			<UndoToastShown notice={notice} onDone={onDone} />
		</ToastProvider>
	);
}

function UndoToastShown({ notice, onDone }: { notice: UndoNotice; onDone: () => void }) {
	const manager = useToastManager();
	const done = useRef(onDone);
	done.current = onDone;
	useEffect(() => {
		// Base UI calls `onClose` for any close, ours too: one on unmount (a newer notice replacing this one, or
		// StrictMode's second mount) must not report this notice done, or it would clear the newer one.
		let mounted = true;
		const id = manager.add({ title: notice.message, onClose: () => mounted && done.current() });
		return () => {
			mounted = false;
			manager.close(id);
		};
		// One toast per notice; `UndoToast` is keyed by it.
	}, []);
	return (
		<ToastViewport>
			{manager.toasts.map((toast) => (
				<Toast key={toast.id} toast={toast} data-undo-notice="">
					<ToastTitle>{toast.title}</ToastTitle>
					{toast.type !== "failed" && (
						<ToastAction
							onClick={() =>
								void Promise.resolve(notice.undo()).then(
									() => manager.close(toast.id),
									(error: unknown) => manager.update(toast.id, { title: `Undo failed: ${errorText(error)}`, type: "failed", timeout: UNDO_MS }),
								)
							}
							data-undo=""
						>
							Undo
						</ToastAction>
					)}
				</Toast>
			))}
		</ToastViewport>
	);
}
