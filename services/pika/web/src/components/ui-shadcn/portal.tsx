import { createContext, useContext } from "react";

/**
 * Where the primitives' popups (menus, tooltips, dialogs, toasts) portal to. Deck sets its root element, so a popup
 * sits inside `[data-deck]` and takes Deck's tokens; without a provider they go to `<body>`, Base UI's default.
 */
export const PortalContainer = createContext<HTMLElement | null>(null);

export const usePortalContainer = (): HTMLElement | undefined => useContext(PortalContainer) ?? undefined;
