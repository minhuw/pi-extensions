/** The Nodes page's shortcuts: Cmd on macOS; elsewhere Ctrl+Shift, as Ctrl-F and Ctrl-P are readline's (and pi's) own keys. */

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

function shortcut(event: Key, letter: string, mac: boolean): boolean {
	if (event.altKey || event.key.toLowerCase() !== letter) return false;
	return mac ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && event.shiftKey && !event.metaKey;
}

/** Find in the terminal: Cmd-F, or Ctrl-Shift-F. */
export const isFindKey = (event: Key, mac = IS_MAC): boolean => shortcut(event, "f", mac);

/** Quick open: Cmd-P, or Ctrl-Shift-P. */
export const isQuickOpenKey = (event: Key, mac = IS_MAC): boolean => shortcut(event, "p", mac);

/** How the page writes a shortcut, for hints. */
export const shortcutLabel = (letter: string, mac = IS_MAC): string => (mac ? `⌘${letter.toUpperCase()}` : `Ctrl+Shift+${letter.toUpperCase()}`);

/** The modifier a link click needs, for hints. */
export const LINK_MODIFIER = IS_MAC ? "⌘" : "Ctrl";
