import { createContext, useContext } from "react";

/**
 * How a tab's pane view and the page's terminal layer meet. The view draws an empty slot for each pane and registers
 * it; the layer draws the terminal over that slot and follows its box. Terminals are drawn once by the layer and never
 * inside the view, so moving or resizing a pane never rebuilds its xterm.
 */
export interface TerminalSlots {
    /** `element` is where `terminalId`'s terminal goes now; null when the slot is gone (the pane closed or moved). */
    attach(terminalId: string, element: HTMLElement | null): void;
    /** A divider drag (or another resize the user made) ended: fit the terminals and send their sizes to the node. */
    resizeEnd(): void;
    /**
     * Runs `command` on `terminalId`'s drawn terminal: the tab strip's actions and the tab menu reach the terminal
     * this way. False when no terminal of that id is drawn.
     */
    command(terminalId: string, command: TerminalCommand): boolean;
}

/** What chrome outside a terminal asks of it: open its find widget, pick files to upload, kill (or remove) it. */
export type TerminalCommand = "find" | "upload" | "kill";

/** A drawn terminal's commands, which it registers with the layer while it is mounted. */
export type TerminalHandle = Record<TerminalCommand, () => void>;

export const TerminalSlotsContext = createContext<TerminalSlots | null>(null);

export function useTerminalSlots(): TerminalSlots {
    const slots = useContext(TerminalSlotsContext);
    if (!slots) throw new Error("TerminalSplitView needs a TerminalSlotsContext provider: the terminal layer that draws its panes.");
    return slots;
}
