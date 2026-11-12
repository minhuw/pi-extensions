/**
 * shadcn/ui's toast (Base UI flavour, `registry/bases/base/ui/toast.tsx`; MIT, see SHADCN-LICENSE), restyled to
 * Deck: one raised notice at the bottom left, above the status bar, with its action in the accent. Base UI holds its
 * timer while the pointer or focus is on it, announces it politely, and lets F6 reach it from the keyboard.
 */
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { usePortalContainer } from "./portal";
import { cn } from "./utils";

const ToastProvider = ToastPrimitive.Provider;
const useToastManager = ToastPrimitive.useToastManager;

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
	const container = usePortalContainer();
	return (
		<ToastPrimitive.Portal container={container}>
			<ToastPrimitive.Viewport data-slot="toast-viewport" className={cn("fixed bottom-9 left-3 z-40 w-[360px] max-w-[calc(100vw-24px)] outline-none", className)} {...props} />
		</ToastPrimitive.Portal>
	);
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
	return (
		<ToastPrimitive.Root
			data-slot="toast"
			className={cn("flex items-center gap-3 rounded-[6px] border border-dk-menu-line bg-dk-raised px-3 py-2 text-[13px] text-dk-ink shadow-dk outline-none focus-visible:outline-2 focus-visible:outline-dk-accent", className)}
			{...props}
		/>
	);
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
	return <ToastPrimitive.Title data-slot="toast-title" className={cn("min-w-0 flex-1 text-[13px] font-normal", className)} {...props} />;
}

function ToastAction({ className, ...props }: ToastPrimitive.Action.Props) {
	return (
		<ToastPrimitive.Action
			data-slot="toast-action"
			className={cn("h-6 shrink-0 cursor-default rounded-[3px] px-1.5 font-medium text-dk-accent outline-none hover:bg-dk-hover focus-visible:outline-2 focus-visible:outline-dk-accent", className)}
			{...props}
		/>
	);
}

export { Toast, ToastAction, ToastProvider, ToastTitle, ToastViewport, useToastManager };
