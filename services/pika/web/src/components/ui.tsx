import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function cx(...parts: (string | false | null | undefined)[]): string {
	return parts.filter(Boolean).join(" ");
}

type Tone = "neutral" | "accent" | "red" | "green" | "yellow";

/**
 * Pills carry state, never a line colour: `green` (live, online, delivered) and `accent` read as an inverted black sign,
 * `yellow` (waiting, a caveat) as an outlined notice, and only `red` is coloured.
 */
const PILL_TONES: Record<Tone, string> = {
	neutral: "bg-hover text-ink",
	accent: "bg-ink text-page",
	red: "bg-red-soft text-red",
	green: "bg-ink text-page",
	yellow: "text-ink shadow-[inset_0_0_0_1px_var(--color-ink)]",
};

export function Pill({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
	return (
		<span
			title={title}
			className={cx(
				"inline-flex max-w-full items-center truncate rounded-sm px-1.5 text-[11.5px] leading-[18px] font-medium whitespace-nowrap",
				PILL_TONES[tone],
			)}
		>
			{children}
		</span>
	);
}

/** Callouts are notices: a soft panel, a red one for failures, and a black-framed one (`yellow`) for warnings. */
const CALLOUT_TONES: Record<Exclude<Tone, "accent">, { box: string; icon: IconName }> = {
	neutral: { box: "bg-soft", icon: "info" },
	red: { box: "bg-red-soft", icon: "alert" },
	green: { box: "bg-soft", icon: "info" },
	yellow: { box: "border border-ink bg-page", icon: "info" },
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
			className={cx("flex gap-3 rounded-sm px-4 py-3", style.box)}
			data-callout={tone}
		>
			<Icon name={icon ?? style.icon} className={cx("mt-0.5 shrink-0", tone === "red" ? "text-red" : tone === "yellow" ? "text-ink" : "text-muted")} />
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

/** Every top-level page's column, so page titles start at the same x on every page. */
export const PAGE_COLUMN = "mx-auto w-full max-w-[1240px] px-8 max-sm:px-4";

/** A top-level page: the shared column and top padding; `className` adds the bottom padding. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cx(PAGE_COLUMN, "pt-9", className)}>{children}</div>;
}

/** The page's title; `badges` (status pills) follow its last word inline, at the cap height. */
export function PageTitle({ children, badges }: { children: ReactNode; badges?: ReactNode }) {
	const title = "font-semibold tracking-[-0.02em]";
	if (!badges) return <h1 className={cx("text-[28px] leading-[1.15] break-words text-balance", title)}>{children}</h1>;
	// No wrap between the title's last word and the badges, so they move to the next line together.
	return (
		<div className="text-[28px] leading-[1.15] break-words whitespace-nowrap">
			<h1 className={cx("inline whitespace-normal", title)}>{children}</h1>
			<span className="ml-3 inline-flex gap-1.5 align-[5px] text-[12px] leading-5" data-title-badges="">
				{badges}
			</span>
		</div>
	);
}

export function EmptyState({ title, visual, children }: { title: string; visual?: ReactNode; children?: ReactNode }) {
	return (
		<div className="py-16 text-center" data-state="empty">
			{visual && <div className="mb-4 flex justify-center">{visual}</div>}
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

const BUTTON_BASE =
	"inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-default disabled:opacity-45";

/** Actions are black and white; only a destructive action is red. */
export const BUTTON = {
	primary: `${BUTTON_BASE} bg-ink text-page hover:bg-ink/82`,
	secondary: `${BUTTON_BASE} border border-ink bg-page text-ink hover:bg-hover`,
	danger: `${BUTTON_BASE} bg-red text-white hover:bg-red/88`,
	quiet: `${BUTTON_BASE} text-muted hover:bg-hover hover:text-ink`,
};

/** A modal dialog frame: Escape or the backdrop cancels. The caller focuses what should have focus first. */
export function Dialog({
	title,
	children,
	onCancel,
	label,
}: {
	title: string;
	children: ReactNode;
	onCancel: () => void;
	/** `data-dialog` value, for tests and e2e. */
	label?: string;
}) {
	const titleId = useId();
	const cancel = useRef(onCancel);
	cancel.current = onCancel;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			cancel.current();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6 dark:bg-black/50" onClick={onCancel}>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				data-dialog={label}
				onClick={(event) => event.stopPropagation()}
				className="w-full max-w-[440px] rounded-sm border border-ink bg-page px-5 py-4 text-ink shadow-[0_16px_40px_rgba(0,0,0,0.22)]"
			>
				<h2 id={titleId} className="text-[16px] font-semibold break-words">
					{title}
				</h2>
				{children}
			</div>
		</div>
	);
}

/** A modal confirmation; Escape or the backdrop cancels, and Cancel has focus first. */
export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	busy = false,
	onConfirm,
	onCancel,
}: {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		cancelRef.current?.focus();
	}, []);
	return (
		<Dialog title={title} onCancel={onCancel}>
			<div className="mt-2 text-[14px] text-muted">{children}</div>
			<div className="mt-5 flex justify-end gap-2">
				<button ref={cancelRef} type="button" onClick={onCancel} className={BUTTON.secondary}>
					Cancel
				</button>
				<button type="button" onClick={onConfirm} disabled={busy} className={BUTTON.danger}>
					{confirmLabel}
				</button>
			</div>
		</Dialog>
	);
}
