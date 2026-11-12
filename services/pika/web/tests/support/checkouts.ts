import type { Checkout, TerminalInfo, Worktree } from "../../src/nodes/contract";
import { railNode, type RailNode } from "../../src/nodes/workspace/places";
import type { DeckKeyItem, DeckProjectRow } from "../../src/lib/api";

/** A checkout id: 32 hex characters, from a letter. */
export const cid = (letter: string): string => letter.repeat(32);

export const worktree = (path: string, branch: string | undefined, extra: Partial<Worktree> = {}): Worktree => ({
	path,
	...(branch ? { branch } : {}),
	head: "0123456789abcdef0123456789abcdef01234567",
	isMain: false,
	prunable: false,
	locked: false,
	detached: branch === undefined,
	...extra,
});

/** A git checkout at `path` with its main worktree on `main`, then `linked` worktrees. */
export function gitCheckout(letter: string, path: string, options: Partial<Checkout> & { linked?: Worktree[] } = {}): Checkout {
	const { linked = [], ...rest } = options;
	const name = path.slice(path.lastIndexOf("/") + 1);
	return {
		id: cid(letter),
		kind: "git",
		path,
		commonDir: `${path}/.git`,
		repository: `https://github.com/me/${name}`,
		project: name,
		name,
		source: "discovered",
		settings: {},
		worktrees: [worktree(path, "main", { isMain: true }), ...linked],
		...rest,
	};
}

export function folderCheckout(letter: string, path: string, options: Partial<Checkout> = {}): Checkout {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return { id: cid(letter), kind: "folder", path, project: name, name, source: "configured", settings: {}, worktrees: [], ...options };
}

/** Keys as the server computes them, without normalizing: `repo:<URL>`, else `local:<project>@node:<node>`. */
export const fakeKey = (item: DeckKeyItem): string | null => (item.repository ? `repo:${item.repository}` : item.project ? `local:${item.project}@node:${item.node}` : null);

export function rail(node: string, checkouts: readonly Checkout[], rows: readonly DeckProjectRow[] = [], keyOf: (item: DeckKeyItem) => string | null | undefined = fakeKey): RailNode {
	return railNode(node, checkouts, { keyOf, rows: new Map(rows.map((row) => [row.key, row])) });
}

/** A terminal the node placed in a worktree. */
export const placed = (checkout: Checkout, path: string): Pick<TerminalInfo, "checkoutId" | "worktreePath" | "cwd"> => ({ checkoutId: checkout.id, worktreePath: path, cwd: path });
