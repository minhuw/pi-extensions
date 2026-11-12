/**
 * shadcn/ui's dropdown menu (Base UI flavour, `registry/bases/base/ui/dropdown-menu.tsx`; MIT, see SHADCN-LICENSE),
 * restyled to Deck (`services/pika/DESIGN.deck.md`, "Menus"): a raised sheet with a hairline and a soft shadow, 26 px
 * rows with a 16 px icon column, full-ink labels, muted right-aligned shortcuts, the accent tint on the highlighted
 * row, 40% ink for a disabled one, red for a destructive one. Only the parts Deck uses are kept.
 *
 * `DropdownMenuContent` also takes Base UI's `anchor`: Deck opens its menus imperatively, at the pointer (a virtual
 * anchor) or under an element, with no `Trigger`.
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { usePortalContainer } from "./portal";
import { cn } from "./utils";

function DropdownMenu(props: MenuPrimitive.Root.Props) {
	return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

const POPUP =
	"z-50 max-h-(--available-height) min-w-[220px] max-w-[380px] overflow-x-hidden overflow-y-auto rounded-[6px] border border-dk-menu-line bg-dk-raised p-1 text-[13px] leading-4 text-dk-ink shadow-dk outline-none";

function DropdownMenuContent({
	anchor,
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 2,
	collisionPadding = 4,
	className,
	...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "anchor" | "align" | "alignOffset" | "side" | "sideOffset" | "collisionPadding">) {
	const container = usePortalContainer();
	return (
		<MenuPrimitive.Portal container={container}>
			<MenuPrimitive.Positioner className="isolate z-50 outline-none" positionMethod="fixed" anchor={anchor} align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} collisionPadding={collisionPadding}>
				<MenuPrimitive.Popup data-slot="dropdown-menu-content" className={cn(POPUP, className)} {...props} />
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
	return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

/** A group's name, lined up with the labels after the icon column. */
function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
	return (
		<MenuPrimitive.GroupLabel
			data-slot="dropdown-menu-label"
			className={cn("truncate pt-1.5 pr-2 pb-[3px] pl-[30px] text-[11.5px] leading-[14px] font-semibold whitespace-nowrap text-dk-ink-3 first:pt-1", className)}
			{...props}
		/>
	);
}

const ITEM =
	"group/menu-item flex h-[26px] w-full cursor-default items-center gap-2 rounded-[4px] pr-2 pl-1.5 text-left whitespace-nowrap text-dk-ink outline-none select-none data-highlighted:bg-dk-menu-hi data-disabled:text-dk-ink/40 data-disabled:data-highlighted:bg-dk-hover data-[variant=destructive]:text-dk-failed-ink";

function DropdownMenuItem({ className, variant = "default", ...props }: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
	return <MenuPrimitive.Item data-slot="dropdown-menu-item" data-variant={variant} className={cn(ITEM, className)} {...props} />;
}

/** The 16 px column before a label: an item's icon, or the check of a chosen one. */
function DropdownMenuIcon({ className, ...props }: ComponentProps<"span">) {
	return (
		<span
			data-slot="dropdown-menu-icon"
			aria-hidden="true"
			className={cn(
				"flex w-4 shrink-0 justify-center text-dk-ink-2 group-data-highlighted/menu-item:text-dk-ink group-data-popup-open/menu-item:text-dk-ink group-data-disabled/menu-item:text-dk-ink/40 group-data-[variant=destructive]/menu-item:text-dk-failed-ink",
				className,
			)}
			{...props}
		/>
	);
}

/** Secondary text after the label (a project's path): muted, and the first to be truncated. */
function DropdownMenuHint({ className, ...props }: ComponentProps<"span">) {
	return (
		<span
			data-slot="dropdown-menu-hint"
			className={cn("min-w-0 shrink-[1000] truncate text-[12px] text-dk-ink-3 group-data-highlighted/menu-item:text-dk-ink-2", className)}
			{...props}
		/>
	);
}

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"kbd">) {
	return (
		<kbd
			data-slot="dropdown-menu-shortcut"
			className={cn("ml-auto shrink-0 pl-3 font-[inherit] text-[12px] tracking-[0.04em] text-dk-ink-3 tabular-nums group-data-highlighted/menu-item:text-dk-ink-2", className)}
			{...props}
		/>
	);
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
	return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("mx-1.5 my-1 h-px bg-dk-line", className)} {...props} />;
}

function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
	return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({ className, children, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
	return (
		<MenuPrimitive.SubmenuTrigger data-slot="dropdown-menu-sub-trigger" className={cn(ITEM, "data-popup-open:bg-dk-menu-hi", className)} {...props}>
			{children}
			<svg
				width="10"
				height="10"
				viewBox="0 0 10 10"
				className="ml-auto shrink-0 text-dk-ink-3 group-data-highlighted/menu-item:text-dk-ink-2 group-data-popup-open/menu-item:text-dk-ink-2"
				aria-hidden="true"
			>
				<path d="M3.75 2.25 6.5 5 3.75 7.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</MenuPrimitive.SubmenuTrigger>
	);
}

/** A submenu beside its item, its first row level with it; it flips to the left at the window's edge. */
function DropdownMenuSubContent({ align = "start", alignOffset = -5, side = "inline-end", sideOffset = 2, ...props }: ComponentProps<typeof DropdownMenuContent>) {
	return <DropdownMenuContent data-slot="dropdown-menu-sub-content" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} {...props} />;
}

export {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuHint,
	DropdownMenuIcon,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
};
