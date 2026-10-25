import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function cx(...parts: (string | false | null | undefined)[]): string {
	return parts.filter(Boolean).join(" ");
}

type Tone = "neutral" | "accent" | "red" | "green" | "yellow";

const PILL_TONES: Record<Tone, string> = {
	neutral: "bg-hover text-ink",
	accent: "bg-accent-soft text-accent",
	red: "bg-red-soft text-red",
	green: "bg-green-soft text-green",
	yellow: "bg-yellow-soft text-yellow",
};

export function Pill({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
	return (
		<span
			title={title}
			className={cx(
				"inline-flex max-w-full items-center truncate rounded-sm px-1.5 text-[12px] leading-5 whitespace-nowrap",
				PILL_TONES[tone],
			)}
		>
			{children}
		</span>
	);
}

const CALLOUT_TONES: Record<Exclude<Tone, "accent">, { box: string; icon: IconName }> = {
	neutral: { box: "bg-soft", icon: "info" },
	red: { box: "bg-red-soft", icon: "alert" },
	green: { box: "bg-green-soft", icon: "info" },
	yellow: { box: "bg-yellow-soft", icon: "info" },
};

export function Callout({
	tone = "neutral",
	icon,
	title,
	children,
}: {
	tone?: Exclude<Tone, "accent">;
	icon?: IconName;
	title?: ReactNode;
	children?: ReactNode;
}) {
	const style = CALLOUT_TONES[tone];
	return (
		<div
			role={tone === "red" ? "alert" : "note"}
			className={cx("flex gap-3 rounded-md px-4 py-3", style.box)}
			data-callout={tone}
		>
			<Icon name={icon ?? style.icon} className={cx("mt-1 shrink-0", tone === "red" ? "text-red" : "text-muted")} />
			<div className="min-w-0 flex-1">
				{title && <div className={cx("font-medium", tone === "red" && "text-red")}>{title}</div>}
				{children && <div className={cx(title ? "mt-1" : undefined, "min-w-0")}>{children}</div>}
			</div>
		</div>
	);
}

/** Notion-style toggle block: ▸ label, expands its children in place. */
export function Toggle({
	label,
	children,
	defaultOpen = false,
	open: controlledOpen,
	onOpenChange,
	className,
	labelClassName,
}: {
	label: ReactNode;
	children: ReactNode;
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	className?: string;
	labelClassName?: string;
}) {
	const [localOpen, setLocalOpen] = useState(defaultOpen);
	const open = controlledOpen ?? localOpen;
	const setOpen = (value: boolean) => {
		if (controlledOpen === undefined) setLocalOpen(value);
		onOpenChange?.(value);
	};
	return (
		<div className={className}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className={cx(
					"-mx-1 flex max-w-full items-center gap-1.5 rounded-sm px-1 text-left hover:bg-hover",
					labelClassName,
				)}
			>
				<span aria-hidden="true" className="w-3 shrink-0 text-[11px] text-muted">
					{open ? "▾" : "▸"}
				</span>
				<span className="min-w-0 truncate">{label}</span>
			</button>
			{open && <div className="mt-1 pl-[18px]">{children}</div>}
		</div>
	);
}

export function Skeleton({ className }: { className?: string }) {
	return <div className={cx("skeleton", className)} aria-hidden="true" />;
}

export function SkeletonLines({ lines = 3 }: { lines?: number }) {
	return (
		<div className="space-y-2.5" aria-busy="true" aria-label="Loading">
			{Array.from({ length: lines }, (_, i) => (
				<Skeleton key={i} className={cx("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
			))}
		</div>
	);
}

export interface Property {
	icon: IconName;
	label: string;
	value: ReactNode;
}

/** Notion database properties: icon, muted label, value. */
export function Properties({ items }: { items: Property[] }) {
	return (
		<dl className="my-4 grid grid-cols-[minmax(120px,160px)_1fr] gap-y-0.5 text-[14px]">
			{items.map((item) => (
				<div key={item.label} className="contents">
					<dt className="flex h-[34px] items-center gap-2 rounded-sm px-1.5 text-muted">
						<Icon name={item.icon} className="shrink-0" />
						<span className="truncate">{item.label}</span>
					</dt>
					<dd className="flex min-h-[34px] min-w-0 flex-wrap items-center gap-1.5 rounded-sm px-2 hover:bg-hover">
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	);
}

export function Divider({ className }: { className?: string }) {
	return <hr className={cx("border-0 border-t border-line", className)} />;
}

export function PageTitle({ children }: { children: ReactNode }) {
	return <h1 className="text-[36px] leading-tight font-semibold tracking-[-0.01em] break-words">{children}</h1>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="py-16 text-center" data-state="empty">
			<div className="text-[15px] font-medium">{title}</div>
			{children && <div className="mt-1 text-[14px] text-muted">{children}</div>}
		</div>
	);
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
	const message = error instanceof Error ? error.message : String(error);
	return (
		<div className="py-6" data-state="error">
			<Callout tone="red" title="Something went wrong">
				<div className="text-[14px]">{message}</div>
				{onRetry && (
					<button
						type="button"
						onClick={onRetry}
						className="mt-2 rounded-sm border border-line px-2 py-0.5 text-[13px] hover:bg-hover"
					>
						Try again
					</button>
				)}
			</Callout>
		</div>
	);
}
