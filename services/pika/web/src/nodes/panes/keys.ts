/**
 * Default chords for a terminal tab's panes, as data for the page's registry (`../keys.ts`) to take in. They fire
 * only while focus is in a terminal, so each is a chord the terminal lets the page have: Cmd on macOS, Ctrl+Shift
 * elsewhere.
 *
 * Orca's own (⌘D, ⌘⇧D, ⌘[, ⌘], ⌘W) belong to the browser here: bookmark, bookmark all tabs, back, forward, close tab.
 * So splits use the tmux marks, `\` (a vertical bar: side by side) and `-` (stacked), and focus moves with
 * `[` and `]` like Orca's, all with ⌥ added on macOS; Ctrl+Shift+\ is already "Show or hide the files" elsewhere, so
 * splits add Alt there too.
 */
import type { ActionSpec } from "../keys";

export type PaneActionId = "split.right" | "split.down" | "split.focusNext" | "split.focusPrevious" | "split.close";

export interface PaneActionSpec extends Omit<ActionSpec, "id"> {
    id: PaneActionId;
}

export const PANE_ACTIONS: readonly PaneActionSpec[] = [
    { id: "split.right", label: "Split the terminal right", group: "Terminal", mac: ["Cmd+Alt+\\"], other: ["Ctrl+Shift+Alt+\\"], terminal: true, text: false, only: "terminal" },
    { id: "split.down", label: "Split the terminal down", group: "Terminal", mac: ["Cmd+Alt+-"], other: ["Ctrl+Shift+Alt+-"], terminal: true, text: false, only: "terminal" },
    { id: "split.focusNext", label: "Next terminal pane in the tab", group: "Terminal", mac: ["Cmd+Alt+]"], other: ["Ctrl+Shift+]"], terminal: true, text: false, only: "terminal" },
    { id: "split.focusPrevious", label: "Previous terminal pane in the tab", group: "Terminal", mac: ["Cmd+Alt+["], other: ["Ctrl+Shift+["], terminal: true, text: false, only: "terminal" },
    { id: "split.close", label: "Close the terminal pane", group: "Terminal", mac: ["Cmd+Alt+Backspace"], other: ["Ctrl+Shift+Backspace"], terminal: true, text: false, only: "terminal" },
];
