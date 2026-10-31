import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

/** Tags are ink, never a line colour, since those mark record kinds: `yellow` is a caveat and `red` a failure. */
const COLORS = {
	gray: "bg-hover text-ink",
	yellow: "text-ink shadow-[inset_0_0_0_1px_var(--color-ink)]",
	red: "bg-red-soft text-red",
} as const;

export type TagColor = keyof typeof COLORS;

/** A small 2px-cornered label. */
export function Tag({ color = "gray", icon, title, mono, children }: { color?: TagColor; icon?: IconName; title?: string; mono?: boolean; children: ReactNode }) {
	return (
		<span
			className={cx(
				"inline-flex h-[18px] max-w-[240px] shrink-0 items-center gap-1 rounded-sm px-1.5 leading-none whitespace-nowrap",
				mono ? "mono text-[11px]" : "text-[11.5px]",
				COLORS[color],
			)}
			title={title}
		>
			{icon && <Icon name={icon} size={11} className="shrink-0 opacity-70" />}
			<span className="truncate">{children}</span>
		</span>
	);
}
