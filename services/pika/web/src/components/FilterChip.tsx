import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

/** Notion-style filter chip with a dropdown panel. */
export function FilterChip({
	icon,
	label,
	value,
	children,
}: {
	icon: IconName;
	label: string;
	value?: string;
	children: (close: () => void) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				aria-haspopup="true"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className={cx(
					"flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] hover:bg-hover",
					value ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-muted",
				)}
			>
				<Icon name={icon} size={14} />
				<span>{label}</span>
				{value && <span className="max-w-[180px] truncate font-medium">: {value}</span>}
				<span aria-hidden="true" className="text-[10px]">
					▾
				</span>
			</button>
			{open && (
				<div
					role="menu"
					className="absolute top-full left-0 z-20 mt-1 max-h-80 min-w-[220px] overflow-y-auto rounded-md border border-line bg-page p-1 shadow-[0_4px_12px_rgba(15,15,15,0.08)]"
				>
					{children(() => setOpen(false))}
				</div>
			)}
		</div>
	);
}

export function MenuOption({ selected, onSelect, children }: { selected?: boolean; onSelect: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={selected ?? false}
			onClick={onSelect}
			className={cx(
				"flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[14px] hover:bg-hover",
				selected && "font-medium",
			)}
		>
			<span className="w-3 text-[12px] text-accent">{selected ? "✓" : ""}</span>
			<span className="truncate">{children}</span>
		</button>
	);
}
