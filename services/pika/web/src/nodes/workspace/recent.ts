/**
 * The terminal a place's workspace header describes. With a terminal pane in focus, that pane; with an editor or
 * a diff in focus, the terminal pane focused last in the same place (worktree), while the node still lists it; none
 * when no terminal pane had focus there yet (the header then shows only the node).
 */
import type { TerminalInfo } from "../contract";

export class RecentTerminals {
	readonly #last = new Map<string, string>();

	/**
	 * Records `onScreen` (the focused group's terminal pane in `node`'s `place`, undefined when an editor or a diff
	 * has focus) and answers the terminal the header shows, from `terminals` (`NodeView.terminals`). Calling it again
	 * with the same arguments answers the same, so a render may call it.
	 */
	shown(node: string, place: string, onScreen: string | undefined, terminals: readonly TerminalInfo[]): TerminalInfo | undefined {
		const key = `${node}\n${place}`;
		if (onScreen) this.#last.set(key, onScreen);
		const id = onScreen ?? this.#last.get(key);
		return id === undefined ? undefined : terminals.find((item) => item.terminalId === id);
	}
}
