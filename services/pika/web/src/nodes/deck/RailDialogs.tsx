/**
 * Deck's dialogs and small surfaces, on shadcn/ui's primitives (`components/ui-shadcn`): Add Repository (a path on the
 * node, completed from its folders), New Worktree (Orca's flow: a branch, a base, the folder it lands in, and pi
 * started in it), Remove Worktree (git's refusals shown in place), a checkout's worktree settings, the confirmations
 * (kill, close unsaved, forget a key), the inline rename field, and the undo notice that follows a removal (T3 Code's:
 * the change is made at once, and Undo puts it back for five seconds).
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
import { NodeRequestError } from "../channel";
import { homePath } from "../client";
import type { Checkout, CheckoutSettings } from "../contract";
import { worktreePathFor } from "../workspace/places";

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
 * Add Repository: a path on the node, `~` for its home, added as a checkout (`checkout.add`: a path in a git work tree
 * adds its repository; any other folder is added as it is). As it is typed, the folders of the directory it names are offered
 * (`fs.readDir`, folders only) in a list under the field (Base UI's Autocomplete): arrows pick one, Tab, Enter or a
 * click completes it. Enter with nothing picked adds the path typed; an error stays under the field.
 */
export function AddCheckoutDialog({
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
			<DialogContent data-dialog="add-checkout">
				<DialogTitle>Add a repository on {nodeName}</DialogTitle>
				<DialogDescription>A repository (or any folder) on the node, shown to every browser. Nothing on disk changes.</DialogDescription>
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
						data-add-checkout-path=""
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
					<Button onClick={() => void submit()} disabled={busy || !value.trim()} data-add-checkout-submit="">
						{busy ? "Adding…" : "Add Repository"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export interface WorktreeRequest {
	/** The new branch, as typed. */
	name: string;
	base: string;
	startAgent: boolean;
}

const LABEL = "mt-3 block text-[12px] font-medium text-dk-ink-2";

/**
 * New Worktree, as Orca makes one: a new branch named as typed, from a base (the checkout's setting, else `HEAD`),
 * checked out in `<location>/<repo>-<slug>`, both shown as they are typed; pi starts in it unless unchecked, after
 * the checkout's setup script when it has one. The node checks the branch name with git.
 */
export function NewWorktreeDialog({
	projectName,
	checkout,
	home,
	onCreate,
	onCancel,
}: {
	projectName: string;
	checkout: Checkout;
	home: string;
	onCreate: (request: WorktreeRequest) => Promise<void>;
	onCancel: () => void;
}) {
	const [name, setName] = useState("");
	const [base, setBase] = useState(checkout.settings.worktreeBase ?? "");
	const [startAgent, setStartAgent] = useState(true);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const id = useId();
	const typed = name.trim();
	const path = typed ? worktreePathFor(checkout, typed) : undefined;
	const submit = async () => {
		if (!typed) {
			setError("Name the new branch");
			return;
		}
		if (!path) {
			setError("The folder name needs a letter or a digit");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await onCreate({ name: typed, base: base.trim() || "HEAD", startAgent });
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
				<DialogDescription>A new branch, checked out in a folder of its own.</DialogDescription>
				<label className={LABEL} htmlFor={`${id}-name`}>
					Branch
				</label>
				<Input
					id={`${id}-name`}
					className="mt-1"
					value={name}
					placeholder="feature/name"
					spellCheck={false}
					autoComplete="off"
					autoFocus
					aria-invalid={error ? true : undefined}
					onValueChange={(next) => {
						setName(next);
						setError(undefined);
					}}
					onKeyDown={enter}
					data-worktree-name=""
				/>
				<label className={LABEL} htmlFor={`${id}-base`}>
					Start from
				</label>
				<Input id={`${id}-base`} className="mt-1" value={base} placeholder="HEAD" spellCheck={false} autoComplete="off" onValueChange={setBase} onKeyDown={enter} data-worktree-base="" />
				<dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]" data-worktree-preview="">
					<dt className="text-dk-ink-3">Branch</dt>
					<dd className="truncate font-mono text-dk-ink" data-worktree-branch-preview="">
						{typed || "—"}
					</dd>
					<dt className="text-dk-ink-3">Folder</dt>
					<dd className="truncate font-mono text-dk-ink" title={path} data-worktree-path-preview="">
						{path ? homePath(path, home) : "—"}
					</dd>
				</dl>
				{checkout.settings.setupScript && (
					<p className="mt-2 text-[12.5px] text-dk-ink-2" data-worktree-setup="">
						Then its setup script runs there, in a terminal you can watch.
					</p>
				)}
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

export interface RemoveWorktreeRequest {
	deleteBranch: boolean;
	/** Stop the live terminals in it first (the node answered `busy`). */
	force: boolean;
}

const terminalsText = (count: number): string => (count === 1 ? "1 terminal" : `${count} terminals`);

/**
 * Remove Worktree: `git worktree remove` on the node, never forced, so git keeps a worktree with changes and says why
 * (shown here). The branch stays unless "Also delete branch" (`git branch -d`, which keeps an unmerged branch). When
 * terminals still run in it, the node refuses; the dialog then offers to stop them and remove it.
 */
export function RemoveWorktreeDialog({
	nodeName,
	path,
	home,
	branch,
	prunable,
	liveTerminals,
	onRemove,
	onCancel,
}: {
	nodeName: string;
	path: string;
	home: string;
	branch?: string;
	prunable: boolean;
	/** The live terminals this browser knows in the worktree, for the offer to stop them. */
	liveTerminals: number;
	onRemove: (request: RemoveWorktreeRequest) => Promise<void>;
	onCancel: () => void;
}) {
	const [deleteBranch, setDeleteBranch] = useState(false);
	const [busyCount, setBusyCount] = useState<number>();
	const [error, setError] = useState<string>();
	const [working, setWorking] = useState(false);
	const cancel = useRef<HTMLButtonElement>(null);
	const confirm = async () => {
		setWorking(true);
		setError(undefined);
		try {
			await onRemove({ deleteBranch, force: busyCount !== undefined });
		} catch (failure) {
			setWorking(false);
			if (failure instanceof NodeRequestError && failure.code === "busy") {
				const counted = Number(/\d+/.exec(failure.message)?.[0]);
				setBusyCount(liveTerminals || (Number.isFinite(counted) && counted > 0 ? counted : 1));
				setError(failure.message);
			} else if (failure instanceof NodeRequestError && failure.code === "conflict") setError(failure.message);
			else setError(failure instanceof NodeRequestError ? `${failure.code}: ${failure.message}` : errorText(failure));
		}
	};
	return (
		<AlertDialog open onOpenChange={(open) => !open && !working && onCancel()}>
			<AlertDialogContent initialFocus={cancel} data-dialog="remove-worktree">
				<AlertDialogTitle>Remove the worktree {branch ?? homePath(path, home)}?</AlertDialogTitle>
				<AlertDialogDescription render={<div />}>
					{prunable ? (
						<span className="block">
							Its folder <span className="font-mono">{homePath(path, home)}</span> is gone; this clears git's record of it on {nodeName}.
						</span>
					) : (
						<span className="block">
							Runs <code className="code-chip">git worktree remove</code> on {nodeName}, which deletes <span className="font-mono">{homePath(path, home)}</span>. git
							refuses when it has changes or untracked files.
						</span>
					)}
					{branch && (
						<label className="mt-3 flex w-fit items-center gap-2 text-[13px] text-dk-ink">
							<Checkbox checked={deleteBranch} onCheckedChange={setDeleteBranch} disabled={working} data-remove-delete-branch="" />
							Also delete branch <span className="font-mono">{branch}</span>
						</label>
					)}
					{error && (
						<span className="mt-2 block text-[13px] whitespace-pre-wrap text-dk-failed-ink" role="alert" data-dialog-error="">
							{error}
						</span>
					)}
				</AlertDialogDescription>
				<AlertDialogFooter>
					<AlertDialogClose ref={cancel} render={<Button variant="outline" />} disabled={working}>
						Cancel
					</AlertDialogClose>
					<Button variant="destructive" onClick={() => void confirm()} disabled={working} data-confirm="" data-force={busyCount !== undefined ? "" : undefined}>
						{busyCount !== undefined ? `Stop ${terminalsText(busyCount)} and Remove` : working ? "Removing…" : "Remove Worktree"}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** A checkout's worktree settings from the dialog's fields, or why they cannot be saved. */
export function settingsFrom(fields: { location: string; base: string; script: string }, home: string): CheckoutSettings | string {
	const settings: CheckoutSettings = {};
	const location = fields.location.trim();
	if (location) {
		const expanded = expandHome(location, home);
		if (!expanded) return "Give the folder as an absolute path, or one that starts with ~";
		settings.worktreeLocation = expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
	}
	const base = fields.base.trim();
	if (base) {
		if (base.length > 255 || /[\u0000-\u001f\u007f]/.test(base)) return "The base is one line of at most 255 characters";
		settings.worktreeBase = base;
	}
	if (fields.script.trim()) {
		if (fields.script.length > 4_096) return "The setup script is at most 4,096 characters";
		if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(fields.script)) return "The setup script has a control character";
		settings.setupScript = fields.script;
	}
	return settings;
}

/**
 * A checkout's worktree settings, kept by its node for every browser: where new worktrees go, the ref they start from,
 * and a setup script run in each new one. An empty field is the default.
 */
export function CheckoutSettingsDialog({
	checkoutName,
	checkout,
	home,
	onSave,
	onCancel,
}: {
	checkoutName: string;
	checkout: Checkout;
	home: string;
	onSave: (settings: CheckoutSettings) => Promise<void>;
	onCancel: () => void;
}) {
	const [location, setLocation] = useState(checkout.settings.worktreeLocation ? homePath(checkout.settings.worktreeLocation, home) : "");
	const [base, setBase] = useState(checkout.settings.worktreeBase ?? "");
	const [script, setScript] = useState(checkout.settings.setupScript ?? "");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const id = useId();
	const parent = checkout.path.slice(0, checkout.path.lastIndexOf("/")) || "/";
	const save = async () => {
		const settings = settingsFrom({ location, base, script }, home);
		if (typeof settings === "string") {
			setError(settings);
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await onSave(settings);
		} catch (failure) {
			setError(failure instanceof NodeRequestError ? `${failure.code}: ${failure.message}` : errorText(failure));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
			<DialogContent data-dialog="checkout-settings">
				<DialogTitle>Worktree settings of {checkoutName}</DialogTitle>
				<DialogDescription>Kept on the node for every browser. An empty field uses the default.</DialogDescription>
				<label className={LABEL} htmlFor={`${id}-location`}>
					New worktrees go in
				</label>
				<Input
					id={`${id}-location`}
					className="mt-1"
					value={location}
					placeholder={homePath(parent, home)}
					spellCheck={false}
					autoComplete="off"
					onValueChange={(next) => {
						setLocation(next);
						setError(undefined);
					}}
					data-settings-location=""
				/>
				<label className={LABEL} htmlFor={`${id}-base`}>
					They start from
				</label>
				<Input
					id={`${id}-base`}
					className="mt-1"
					value={base}
					placeholder="HEAD"
					spellCheck={false}
					autoComplete="off"
					onValueChange={(next) => {
						setBase(next);
						setError(undefined);
					}}
					data-settings-base=""
				/>
				<label className={LABEL} htmlFor={`${id}-script`}>
					Setup script
				</label>
				<textarea
					id={`${id}-script`}
					className={cn(INPUT_AREA, "mt-1")}
					rows={4}
					value={script}
					placeholder="npm ci"
					spellCheck={false}
					onChange={(event) => {
						setScript(event.target.value);
						setError(undefined);
					}}
					data-settings-script=""
				/>
				<p className="mt-1 text-[12px] text-dk-ink-3">
					Runs with <code className="code-chip">sh -c</code> in each new worktree, in a terminal you can watch.
				</p>
				{error && (
					<p className="mt-2 text-[13px] text-dk-failed-ink" role="alert" data-dialog-error="">
						{error}
					</p>
				)}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />} disabled={busy}>
						Cancel
					</DialogClose>
					<Button onClick={() => void save()} disabled={busy} data-settings-save="">
						{busy ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

const INPUT_AREA =
	"w-full min-w-0 resize-y rounded-[4px] border border-dk-line-strong bg-dk-raised px-2 py-1.5 font-mono text-[12.5px] text-dk-ink outline-none placeholder:text-dk-ink-3 focus:border-dk-accent focus:shadow-[0_0_0_2px_var(--dk-accent-soft)]";

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
	/** Without one, the notice only says what happened. */
	undo?: () => Promise<void> | void;
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
					{toast.type !== "failed" && notice.undo && (
						<ToastAction
							onClick={() =>
								void Promise.resolve(notice.undo?.()).then(
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
