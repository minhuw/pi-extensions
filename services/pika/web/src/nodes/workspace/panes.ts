/** What the workspace takes of a terminal tab's pane tree (`../panes/pane-tree.ts`), under the names the model uses. */

import { closeLeaf, focusSuccessorOnClose, leaf, leaves, LAYOUT_VERSION, parse, type PaneTree } from "../panes/pane-tree";

export type { PaneTree };

export const paneLeaf = leaf;
export const paneLeaves = leaves;

/**
 * The tree without `terminalId`, its sibling taking the split's place, and where focus goes if it was there (the
 * successor is read before the close, as it must be); null when it was the last pane.
 */
export function removePane(tree: PaneTree, terminalId: string): { tree: PaneTree; successor?: string } | null {
	const successor = focusSuccessorOnClose(tree, terminalId);
	const next = closeLeaf(tree, terminalId);
	return next ? { tree: next, ...(successor ? { successor } : {}) } : null;
}

/** A stored tree, checked by the pane tree's own parser; undefined when it refuses it. */
export function parsePanes(value: unknown): PaneTree | undefined {
	try {
		return parse({ version: LAYOUT_VERSION, tree: value });
	} catch {
		return undefined;
	}
}
