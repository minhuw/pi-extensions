/**
 * shadcn/ui's input (Base UI flavour, `registry/bases/base/ui/input.tsx`; MIT, see SHADCN-LICENSE), restyled to
 * Deck's fields: 28 px, monospace for paths and branch names, the accent ring on focus.
 */
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "./utils";

export const INPUT =
	"h-7 w-full min-w-0 rounded-[4px] border border-dk-line-strong bg-dk-raised px-2 font-mono text-[12.5px] text-dk-ink outline-none placeholder:text-dk-ink-3 focus:border-dk-accent focus:shadow-[0_0_0_2px_var(--dk-accent-soft)] aria-invalid:border-dk-failed";

function Input({ className, ...props }: InputPrimitive.Props) {
	return <InputPrimitive data-slot="input" className={cn(INPUT, className)} {...props} />;
}

export { Input };
