import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

/** The menu's items, in the order arrow keys move through them. */
const MENU_ITEMS = "[role=menuitem]:not(:disabled), [role=menuitemcheckbox]:not(:disabled), [role=menuitemradio]:not(:disabled)";

/**
 * A compact filter control with a dropdown menu; set, it reads as an inverted black sign. While open, its root carries
 * `data-filter-menu`, so page-wide keys can leave Esc to it. A `glyph` shows the value as marks instead of words; the
 * words stay for screen readers.
 */
export function FilterChip({
	icon,
	label,
	value,
	glyph,
	children,
}: {
	icon?: IconName;
	label: string;
	value?: string;
	glyph?: ReactNode;
	children: (close: () => void) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	// How far the menu moves left so it stays on a narrow screen; it opens under its button wherever it fits. It is
	// measured from the button after every render, since choosing a value can change the button's width and place.
	const [shift, setShift] = useState(0);

	useLayoutEffect(() => {
		const anchor = ref.current?.getBoundingClientRect().left;
		const width = menu.current?.offsetWidth;
		const next = open && anchor !== undefined && width !== undefined ? -Math.max(0, Math.min(anchor + width - (window.innerWidth - 8), anchor - 8)) : 0;
		if (next !== shift) setShift(next);
	});

	// Opening moves focus to the first item, as a menu button does, so arrows and Enter work at once.
	useEffect(() => {
		if (open) menu.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus({ preventScroll: true });
	}, [open]);

	const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const items = [...(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const moves: Record<string, number> = { ArrowDown: (at + 1) % items.length, ArrowUp: (at - 1 + items.length) % items.length, Home: 0, End: items.length - 1 };
		const to = moves[event.key];
		if (to === undefined || !items.length) return;
		event.preventDefault();
		items[to].focus();
	};

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			// Focus inside the menu goes back to its button rather than to the page.
			if (ref.current?.contains(document.activeElement)) button.current?.focus();
		};
		document.addEventListener("mousedown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div ref={ref} className="relative" data-filter-menu={open ? "" : undefined}>
			<button
				ref={button}
				type="button"
				aria-haspopup="true"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" && !open) {
						event.preventDefault();
						setOpen(true);
					}
				}}
				title={value && glyph ? `${label}: ${value}` : undefined}
				className={cx(
					"flex h-7 items-center gap-1.5 rounded-sm border px-2 text-[13px] transition-colors duration-150",
					value ? "border-ink bg-ink text-page hover:bg-ink/82" : "border-line text-ink hover:border-ink hover:bg-hover",
				)}
			>
				{icon && <Icon name={icon} size={14} className={value ? undefined : "text-muted"} />}
				<span className="flex min-w-0">
					{label}
					{value && <span className={glyph ? "sr-only" : "max-w-[180px] truncate font-medium"}>: {value}</span>}
				</span>
				{glyph && (
					<span aria-hidden="true" className="flex items-center">
						{glyph}
					</span>
				)}
				<span aria-hidden="true" className="text-[10px] opacity-70">
					▾
				</span>
			</button>
			{open && (
				<div
					ref={menu}
					role="menu"
					aria-label={label}
					onKeyDown={onMenuKey}
					style={{ left: shift }}
					className="menu-in absolute top-full z-20 mt-1 max-h-80 min-w-[220px] overflow-y-auto rounded-sm border border-ink bg-page p-1 shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
				>
					{children(() => setOpen(false))}
				</div>
			)}
		</div>
	);
}

/** A filter choice: `value` goes in the URL, `label` is what the menu and the chip show. */
export interface FilterOption {
	value: string;
	label: string;
}

/** Options whose label is their value, as for projects and models. */
export function plainOptions(values: readonly string[]): FilterOption[] {
	return values.map((value) => ({ value, label: value }));
}

/** The label of the selected value, or the value itself when the options do not list it (yet). */
export function optionLabel(options: readonly FilterOption[], value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	return options.find((option) => option.value === value)?.label ?? value;
}

export function MenuOption({ selected, onSelect, children }: { selected?: boolean; onSelect: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={selected ?? false}
			onClick={onSelect}
			className={cx(
				"flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] hover:bg-hover",
				selected && "font-medium",
			)}
		>
			<span className="w-3 text-[12px] text-ink">{selected ? "✓" : ""}</span>
			<span className="truncate">{children}</span>
		</button>
	);
}

/** A choice in a menu that allows several: it toggles, and the menu stays open. */
export function MenuCheck({
	checked,
	onToggle,
	children,
	...rest
}: { checked: boolean; onToggle: () => void; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "role" | "type">) {
	return (
		<button
			{...rest}
			type="button"
			role="menuitemcheckbox"
			aria-checked={checked}
			onClick={onToggle}
			className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13px] text-ink hover:bg-hover"
		>
			<span
				aria-hidden="true"
				className={cx("flex size-3.5 shrink-0 items-center justify-center rounded-[2px] border", checked ? "border-ink bg-ink text-page" : "border-ink/40")}
			>
				{checked && <Icon name="check" size={10} />}
			</span>
			{children}
		</button>
	);
}
