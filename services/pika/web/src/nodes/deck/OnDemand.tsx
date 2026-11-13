/**
 * Deck's overlays (`overlays.ts`) as components that load their chunk the first time one opens. Deck preloads it once
 * the browser is idle after the first paint (`preloadOverlays`), so a dialog opened later shows at once. Each is a
 * portal over the page, so nothing waits for space while it loads.
 */
import { onDemand } from "../../lib/onDemand";

const overlays = () => import("./overlays");

export const AddCheckoutDialog = onDemand(() => overlays().then((module) => module.AddCheckoutDialog));
export const CheckoutSettingsDialog = onDemand(() => overlays().then((module) => module.CheckoutSettingsDialog));
export const ConfirmDialog = onDemand(() => overlays().then((module) => module.ConfirmDialog));
export const NewWorktreeDialog = onDemand(() => overlays().then((module) => module.NewWorktreeDialog));
export const RemoveWorktreeDialog = onDemand(() => overlays().then((module) => module.RemoveWorktreeDialog));
export const UndoToast = onDemand(() => overlays().then((module) => module.UndoToast));
export const KeysHelp = onDemand(() => overlays().then((module) => module.KeysHelp));
export const QuickOpen = onDemand(() => overlays().then((module) => module.QuickOpen));

const ALL = [AddCheckoutDialog, CheckoutSettingsDialog, ConfirmDialog, NewWorktreeDialog, RemoveWorktreeDialog, UndoToast, KeysHelp, QuickOpen];

/** Loads the overlays' chunk, so each renders at once when it opens. */
export const preloadOverlays = (): Promise<unknown> => Promise.all(ALL.map((component) => component.preload()));
