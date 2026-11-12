/**
 * shadcn/ui's alert dialog (Base UI flavour, `registry/bases/base/ui/alert-dialog.tsx`; MIT, see SHADCN-LICENSE):
 * a confirmation (`role="alertdialog"`) on Deck's dialog sheet. Unlike a dialog, a press on the backdrop does not
 * dismiss it; Escape and Cancel do.
 */
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type { ComponentProps } from "react";
import { DIALOG_SHEET } from "./dialog";
import { usePortalContainer } from "./portal";
import { cn } from "./utils";

function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
	return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogContent({ className, children, ...props }: AlertDialogPrimitive.Popup.Props) {
	const container = usePortalContainer();
	return (
		<AlertDialogPrimitive.Portal container={container}>
			<AlertDialogPrimitive.Backdrop data-slot="alert-dialog-overlay" className="fixed inset-0 isolate z-50 bg-black/30 dark:bg-black/50" />
			<AlertDialogPrimitive.Popup data-slot="alert-dialog-content" aria-modal="true" className={cn(DIALOG_SHEET, className)} {...props}>
				{children}
			</AlertDialogPrimitive.Popup>
		</AlertDialogPrimitive.Portal>
	);
}

function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="alert-dialog-footer" className={cn("mt-5 flex justify-end gap-2", className)} {...props} />;
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
	return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={cn("text-[15px] font-semibold break-words", className)} {...props} />;
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
	return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={cn("mt-2 text-[13px] text-dk-ink-2", className)} {...props} />;
}

function AlertDialogClose(props: AlertDialogPrimitive.Close.Props) {
	return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />;
}

export { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle };
