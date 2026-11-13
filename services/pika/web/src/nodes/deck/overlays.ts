/**
 * Deck's overlays, which no first paint draws: the rail's dialogs and undo notice, the shortcuts help, and quick open.
 * One chunk, loaded on demand through `OnDemand.tsx`.
 */
export { AddCheckoutDialog, CheckoutSettingsDialog, ConfirmDialog, NewWorktreeDialog, RemoveWorktreeDialog, UndoToast } from "./RailDialogs";
export { KeysHelp } from "../KeysHelp";
export { QuickOpen } from "../QuickOpen";
