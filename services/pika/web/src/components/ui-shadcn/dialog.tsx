/**
 * shadcn/ui's dialog (Base UI flavour, `registry/bases/base/ui/dialog.tsx`; MIT, see SHADCN-LICENSE), restyled to
 * Deck: a raised sheet with the strong hairline, an 8 px radius and the menus' shadow, over a dim backdrop. Base UI
 * traps focus inside, closes on Escape or a press on the backdrop, and names the dialog by its title and description.
 * Deck's dialogs have no close button in the corner: Cancel is in the footer, and Escape works.
 * The popup says `aria-modal`, which Base UI leaves out: Deck's shortcuts (`useKeyDispatch`) stand still while one is open.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { usePortalContainer } from "./portal";
import { cn } from "./utils";

function Dialog(props: DialogPrimitive.Root.Props) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export const DIALOG_SHEET =
	"fixed top-1/2 left-1/2 z-50 w-[calc(100%-48px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-[8px] border border-dk-line-strong bg-dk-raised px-5 py-4 text-dk-ink shadow-dk outline-none";

function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
	const container = usePortalContainer();
	return (
		<DialogPrimitive.Portal container={container}>
			<DialogPrimitive.Backdrop data-slot="dialog-overlay" className="fixed inset-0 isolate z-50 bg-black/30 dark:bg-black/50" />
			<DialogPrimitive.Popup data-slot="dialog-content" aria-modal="true" className={cn(DIALOG_SHEET, className)} {...props}>
				{children}
			</DialogPrimitive.Popup>
		</DialogPrimitive.Portal>
	);
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="dialog-footer" className={cn("mt-5 flex justify-end gap-2", className)} {...props} />;
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-[15px] font-semibold break-words", className)} {...props} />;
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
	return <DialogPrimitive.Description data-slot="dialog-description" className={cn("mt-1 text-[13px] text-dk-ink-2", className)} {...props} />;
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle };
