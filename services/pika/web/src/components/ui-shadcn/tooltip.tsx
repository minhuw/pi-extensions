/**
 * shadcn/ui's tooltip (Base UI flavour, `registry/bases/base/ui/tooltip.tsx`; MIT, see SHADCN-LICENSE), restyled to
 * Deck: a small inverse bubble, no arrow. `TooltipContent` also takes Base UI's `anchor`, so one tooltip can follow
 * whichever control the pointer rests on (`nodes/deck/Tooltips.tsx`).
 */
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { usePortalContainer } from "./portal";
import { cn } from "./utils";

function Tooltip(props: TooltipPrimitive.Root.Props) {
	return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipContent({
	anchor,
	side = "bottom",
	sideOffset = 6,
	align = "center",
	alignOffset = 0,
	collisionPadding = 4,
	className,
	children,
	...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, "anchor" | "align" | "alignOffset" | "side" | "sideOffset" | "collisionPadding">) {
	const container = usePortalContainer();
	return (
		<TooltipPrimitive.Portal container={container}>
			<TooltipPrimitive.Positioner className="isolate z-[60]" positionMethod="fixed" anchor={anchor} align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} collisionPadding={collisionPadding}>
				<TooltipPrimitive.Popup
					data-slot="tooltip-content"
					className={cn(
						"pointer-events-none flex w-fit max-w-[320px] items-baseline gap-2 rounded-[4px] bg-dk-tip px-[7px] py-1 text-[12px] leading-4 text-dk-tip-ink shadow-[0_4px_12px_-2px_rgb(0_0_0/0.25)] [overflow-wrap:anywhere]",
						className,
					)}
					{...props}
				>
					{children}
				</TooltipPrimitive.Popup>
			</TooltipPrimitive.Positioner>
		</TooltipPrimitive.Portal>
	);
}

export { Tooltip, TooltipContent };
