/**
 * shadcn/ui's checkbox (Base UI flavour, `registry/bases/base/ui/checkbox.tsx`; MIT, see SHADCN-LICENSE), restyled
 * to Deck: a 14 px box in the strong hairline, filled with the accent when checked.
 */
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "./utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				"peer relative flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-dk-line-strong bg-dk-raised text-dk-on-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dk-accent data-checked:border-dk-accent data-checked:bg-dk-accent data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex">
				<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M3.5 8.4 6.6 11.4 12.5 4.6" />
				</svg>
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
