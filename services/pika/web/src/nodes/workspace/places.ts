/**
 * Where things live on a node, as Deck shows them (NODE.md, "Checkouts"): a node's checkouts grouped into projects by
 * the server's project key, each checkout's worktrees, and the *place* of each terminal and workspace, which is one
 * worktree of one checkout (`placeKey`) or the node's "Other".
 */
import type { DeckKeyItem, DeckProjectRow } from "../../lib/api";
import { sanitize, type Checkout, type TerminalInfo, type Worktree } from "../contract";
import { keyItemOf } from "../deck-projects";
import { baseName } from "../files";
import { OTHER } from "./store";

/** A worktree's place: `<checkout id>:<worktree path>`. Checkout ids are hex, so no place starts like `OTHER`. */
export const placeKey = (checkoutId: string, worktreePath: string): string => `${checkoutId}:${worktreePath}`;

/** A place's checkout and worktree path; undefined for "Other". */
export function splitPlace(place: string): { checkoutId: string; worktreePath: string } | undefined {
	if (place === OTHER) return undefined;
	const colon = place.indexOf(":");
	return colon > 0 ? { checkoutId: place.slice(0, colon), worktreePath: place.slice(colon + 1) } : undefined;
}

/** The folder a place's terminals start in and its explorer shows; undefined for "Other". */
export const placePath = (place: string): string | undefined => splitPlace(place)?.worktreePath;

/** Orca's `sanitizeWorktreeName`: runs of other characters than letters, digits, `.`, `_`, `-` become one `-`; leading and trailing `.` and `-` go. */
export function worktreeSlug(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
}

/** The parent directory of `path`. */
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * Where `worktree.create` puts a worktree named `name`: `<worktreeLocation ?? parent of the main worktree>/<repo>-<slug>`;
 * undefined when the slug is empty (the node refuses it).
 */
export function worktreePathFor(checkout: Pick<Checkout, "path" | "settings">, name: string): string | undefined {
	const slug = worktreeSlug(name.trim());
	if (!slug) return undefined;
	const location = checkout.settings.worktreeLocation ?? parentOf(checkout.path);
	return `${location === "/" ? "" : location}/${baseName(checkout.path)}-${slug}`;
}

/** A git checkout that can make worktrees: one with a main worktree (not a folder, not a bare repository). */
export const makesWorktrees = (checkout: Checkout): boolean => checkout.kind === "git" && checkout.worktrees.some((worktree) => worktree.isMain);

/** One worktree card. */
export interface RailWorktree {
	place: string;
	path: string;
	/** The card's title: the worktree's folder name. Cleaned for display. */
	title: string;
	/** The card's meta line: the branch, else the short commit (detached); none for a folder. Cleaned for display. */
	meta?: string;
	/** What names the worktree in a line of text: its meta line, else its title. */
	label: string;
	branch?: string;
	isMain: boolean;
	/** A linked worktree, which `worktree.remove` can remove. */
	linked: boolean;
	prunable: boolean;
	locked: boolean;
	detached: boolean;
}

export interface RailCheckout {
	checkout: Checkout;
	worktrees: RailWorktree[];
}

/** One project of a node: its checkouts, grouped by the server's key. */
export interface RailProject {
	/** Unique on the node: the server's key, or for a checkout without one, `checkout:<id>` (`pending:` while asked). */
	id: string;
	/** The key the server answered; null for a checkout without one, or while it is not known. */
	serverKey: string | null;
	/** The heading: the server's name for the key, else the first checkout's name. Cleaned for display. */
	name: string;
	/** The server keeps a name for it. */
	named: boolean;
	/** The server keeps it folded (a project without a server key folds in the browser, `RailPrefs.folded`). */
	collapsed: boolean;
	repository?: string;
	checkouts: RailCheckout[];
	/** Two or more checkouts: each shows its path; otherwise the heading stands for the only one. */
	showPaths: boolean;
}

export interface PlaceInfo {
	project: RailProject;
	checkout: RailCheckout;
	worktree: RailWorktree;
}

export interface RailNode {
	projects: RailProject[];
	places: ReadonlyMap<string, PlaceInfo>;
}

export function worktreeCards(checkout: Checkout): RailWorktree[] {
	if (checkout.kind === "folder") {
		const title = sanitize(baseName(checkout.path));
		return [{ place: placeKey(checkout.id, checkout.path), path: checkout.path, title, label: title, isMain: true, linked: false, prunable: false, locked: false, detached: false }];
	}
	return checkout.worktrees.map((worktree: Worktree) => {
		const branch = worktree.branch ? sanitize(worktree.branch) : undefined;
		const title = sanitize(baseName(worktree.path));
		const meta = branch ?? worktree.head?.slice(0, 7);
		return {
			place: placeKey(checkout.id, worktree.path),
			path: worktree.path,
			title,
			...(meta ? { meta } : {}),
			label: meta ?? title,
			...(branch ? { branch } : {}),
			isMain: worktree.isMain,
			linked: !worktree.isMain,
			prunable: worktree.prunable,
			locked: worktree.locked,
			detached: worktree.detached,
		};
	});
}

export interface GroupOptions {
	/** The server's key for an item: a key, null for none, undefined while it is not known. */
	keyOf: (item: DeckKeyItem) => string | null | undefined;
	rows: ReadonlyMap<string, DeckProjectRow>;
}

/**
 * A node's checkouts as projects, in the list's order (by the first checkout of each). A checkout whose key is not
 * known yet joins the others of its repository for now, which is what the server answers for nearly every one.
 */
export function railNode(node: string, checkouts: readonly Checkout[], options: GroupOptions): RailNode {
	const byId = new Map<string, { serverKey: string | null; repository?: string; checkouts: Checkout[] }>();
	for (const checkout of checkouts) {
		const key = options.keyOf(keyItemOf(node, checkout));
		const id = key ? key : key === undefined && checkout.repository ? `pending:${checkout.repository}` : `checkout:${checkout.id}`;
		const group = byId.get(id);
		if (group) group.checkouts.push(checkout);
		else byId.set(id, { serverKey: key ?? null, ...(checkout.repository ? { repository: checkout.repository } : {}), checkouts: [checkout] });
	}
	const places = new Map<string, PlaceInfo>();
	const projects = [...byId].map(([id, group]): RailProject => {
		const row = group.serverKey ? options.rows.get(group.serverKey) : undefined;
		const name = row?.name ? sanitize(row.name) : sanitize(group.checkouts[0]!.name);
		const project: RailProject = {
			id,
			serverKey: group.serverKey,
			name,
			named: Boolean(row?.name),
			collapsed: Boolean(row?.collapsed),
			...(group.repository ? { repository: group.repository } : {}),
			checkouts: [],
			showPaths: group.checkouts.length >= 2,
		};
		for (const checkout of group.checkouts) {
			const entry: RailCheckout = { checkout, worktrees: worktreeCards(checkout) };
			project.checkouts.push(entry);
			for (const worktree of entry.worktrees) if (!places.has(worktree.place)) places.set(worktree.place, { project, checkout: entry, worktree });
		}
		return project;
	});
	return { projects, places };
}

/** The place the node puts a terminal in (`checkoutId`, `worktreePath`) when that worktree is listed; else "Other". */
export function placeOfTerminal(places: ReadonlyMap<string, unknown>, terminal: Pick<TerminalInfo, "checkoutId" | "worktreePath">): string {
	if (!terminal.checkoutId || !terminal.worktreePath) return OTHER;
	const place = placeKey(terminal.checkoutId, terminal.worktreePath);
	return places.has(place) ? place : OTHER;
}

/** Where a place is, in words: `branch · project` (a folder: its project), for a row's second line and a heading. */
export function placeWords(info: PlaceInfo | undefined): string | undefined {
	if (!info) return undefined;
	return info.checkout.checkout.kind === "folder" ? info.project.name : `${info.worktree.label} · ${info.project.name}`;
}
