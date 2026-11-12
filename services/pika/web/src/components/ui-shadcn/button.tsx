/**
 * shadcn/ui's button (Base UI flavour, `registry/bases/base/ui/button.tsx`; MIT, see SHADCN-LICENSE), restyled to
 * Deck's controls: 28 px, a 4 px radius; `default` is the accent (a dialog's or a page's primary action, as a
 * desktop's default button), `outline` the secondary one framed in the strong hairline, `ghost` a quiet one, and
 * `destructive` the failed tone for actions that end something.
 */
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const buttonVariants = cva(
	"inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-[4px] font-medium whitespace-nowrap outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dk-accent disabled:opacity-50 data-disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-dk-accent text-dk-on-accent not-disabled:hover:bg-[color-mix(in_srgb,var(--dk-accent)_88%,var(--dk-ink))]",
				outline: "border border-dk-line-strong bg-dk-raised text-dk-ink not-disabled:hover:bg-[color-mix(in_srgb,var(--dk-ink)_5%,var(--dk-raised))]",
				ghost: "text-dk-ink-2 not-disabled:hover:bg-dk-hover not-disabled:hover:text-dk-ink",
				destructive: "bg-dk-failed text-dk-on-failed not-disabled:hover:bg-[color-mix(in_srgb,var(--dk-failed)_88%,var(--dk-ink))]",
			},
			size: {
				default: "h-7 px-2.5 text-[13px]",
				sm: "h-6 px-2 text-[12px]",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

function Button({ className, variant, size, ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
