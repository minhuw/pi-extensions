/**
 * Deck's frame, in place of the site's band: a 40 px app bar (the app menu with pika's other sections, quick open in
 * the middle, the layout toggles and the theme on the right) and a 24 px status bar (the socket, the nodes, what the
 * agents need, notifications, the server's build).
 */

import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Icon, PikaLogo, type IconName } from "../../components/icons";
import { cx } from "../../components/ui";
import { useSignOut } from "../../components/Layout";
import { useHealth } from "../../lib/relay";
import type { Theme } from "../../lib/theme";
import { actionShortcut } from "../keys";
import { menuBelow, useMenu, type MenuEntry } from "./Menu";
import { tip } from "./Tooltips";
import { DECK } from "./tokens";

/** A 28 px icon button of the bars: the arrow cursor, a quiet hover, its name in a tooltip. */
export const BAR_BUTTON =
	"relative inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-[4px] px-1.5 text-dk-ink-2 hover:bg-dk-hover hover:text-dk-ink disabled:opacity-45 disabled:hover:bg-transparent aria-pressed:text-dk-ink";

export interface AppBarProps {
	theme: Theme;
	onTheme: () => void;
	onHelp: () => void;
	/** Undefined until a node is ready: there is nothing to open yet. */
	onQuickOpen?: () => void;
	/** The layout toggles; absent while there is no workspace to lay out. */
	rail?: { open: boolean; onToggle: () => void; badge?: ReactNode };
	files?: { open: boolean; onToggle: () => void };
}

const SECTIONS: readonly { to: string; label: string; icon: IconName; relay?: boolean }[] = [
	{ to: "/", label: "Sessions", icon: "sessions" },
	{ to: "/statistics", label: "Statistics", icon: "statistics" },
	{ to: "/extensions", label: "Extensions", icon: "tool" },
	{ to: "/runs", label: "Herder runs", icon: "herder" },
	{ to: "/active", label: "Active sessions", icon: "pulse", relay: true },
	{ to: "/chatrooms", label: "Chatrooms", icon: "message", relay: true },
	{ to: "/devices", label: "Devices", icon: "device" },
	{ to: "/memory", label: "Memory", icon: "memory" },
	{ to: "/search", label: "Search", icon: "search" },
];

export function DeckAppBar({ theme, onTheme, onHelp, onQuickOpen, rail, files }: AppBarProps) {
	const navigate = useNavigate();
	const health = useHealth();
	const signOut = useSignOut();
	const { menu, open, close, openFor } = useMenu();
	const relay = health.data?.features?.includes("relay") ?? false;
	const quickKeys = actionShortcut("quickOpen");

	const appMenu = (button: HTMLElement) => {
		const items: MenuEntry[] = [
			...SECTIONS.filter((section) => !section.relay || relay).map((section) => ({ id: `go:${section.to}`, label: section.label, icon: section.icon, run: () => navigate(section.to) })),
			"separator",
			{ id: "go:/settings", label: "Settings", icon: "settings", run: () => navigate("/settings") },
			{ id: "go:/docs", label: "Documentation", icon: "file", run: () => navigate("/docs") },
			{ id: "help", label: "Keyboard shortcuts", icon: "keyboard", run: onHelp, ...(actionShortcut("help") ? { shortcut: actionShortcut("help")! } : {}) },
			...(signOut ? (["separator", { id: "sign-out", label: "Sign out", icon: "signOut", run: () => void signOut() }] as MenuEntry[]) : []),
		];
		open({ ...menuBelow(button), items, label: "pika", attrs: { "data-app-menu": "" } });
	};

	return (
		<header className="flex h-10 shrink-0 items-center gap-1 border-b border-dk-line bg-dk-chrome pr-2 pl-1.5" data-deck-bar="">
			<button
				type="button"
				className={cx(BAR_BUTTON, "gap-2 px-2 text-dk-ink")}
				aria-haspopup="menu"
				aria-expanded={openFor === "pika"}
				onClick={(event) => (openFor === "pika" ? close() : appMenu(event.currentTarget))}
				{...tip("pika's other sections")}
				data-app-menu-open=""
			>
				<PikaLogo size={17} />
				<span className="text-[13px] font-semibold">{DECK}</span>
				<svg width="9" height="9" viewBox="0 0 10 10" className="text-dk-ink-3" aria-hidden="true">
					<path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</button>
			<div className="flex min-w-0 flex-1 justify-center px-3">
				<button
					type="button"
					className="flex h-7 w-full max-w-[440px] min-w-0 items-center gap-2 rounded-[5px] border border-dk-line bg-dk-ground px-2.5 text-[12.5px] text-dk-ink-3 hover:border-dk-line-strong hover:text-dk-ink-2 disabled:opacity-60 disabled:hover:border-dk-line"
					disabled={!onQuickOpen}
					onClick={onQuickOpen}
					{...tip(onQuickOpen ? "Open a file by name" : "Open a file once a node is connected", "quickOpen")}
					data-quick-open-bar=""
				>
					<Icon name="search" size={13} className="shrink-0" />
					<span className="min-w-0 flex-1 truncate text-left">Go to file…</span>
					{quickKeys && <kbd className="shrink-0 font-sans text-[11.5px] tracking-[0.04em] text-dk-ink-3">{quickKeys}</kbd>}
				</button>
			</div>
			{rail && (
				<button type="button" className={BAR_BUTTON} aria-pressed={rail.open} aria-label={rail.open ? "Hide the agent list" : "Show the agent list"} onClick={rail.onToggle} {...tip(rail.open ? "Hide the agent list" : "Show the agent list", "sidebar.left")} data-toggle-rail="">
					<PanelGlyph side="left" filled={rail.open} />
					{!rail.open && rail.badge}
				</button>
			)}
			{files && (
				<button type="button" className={BAR_BUTTON} aria-pressed={files.open} aria-label={files.open ? "Hide the explorer" : "Show the explorer"} onClick={files.onToggle} {...tip(files.open ? "Hide the explorer" : "Show the explorer", "files.toggle")} data-toggle-files="">
					<PanelGlyph side="right" filled={files.open} />
				</button>
			)}
			<span className="mx-1 h-4 w-px shrink-0 bg-dk-line" aria-hidden="true" />
			<button type="button" className={cx(BAR_BUTTON, "text-[13px] font-medium")} aria-label="Keyboard shortcuts" onClick={onHelp} {...tip("Keyboard shortcuts", "help")} data-keys-open="">
				?
			</button>
			<button
				type="button"
				className={BAR_BUTTON}
				aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
				onClick={onTheme}
				{...tip(theme === "dark" ? "Light theme" : "Dark theme")}
				data-theme-toggle=""
			>
				<Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
			</button>
			{menu}
		</header>
	);
}

/** A window with its left or right panel, filled while the panel shows (the desktop's sidebar toggle). */
function PanelGlyph({ side, filled }: { side: "left" | "right"; filled: boolean }) {
	const x = side === "left" ? 2.5 : 9.5;
	return (
		<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
			<rect x="2" y="2.5" width="12" height="11" rx="1.5" />
			<path d={side === "left" ? "M6.5 2.5v11" : "M9.5 2.5v11"} />
			{filled && <rect x={x} y="3" width="4" height="10" fill="currentColor" stroke="none" opacity="0.45" />}
		</svg>
	);
}

export interface StatusBarProps {
	socket: "loading" | "open" | "closed" | "insecure" | "failed" | string;
	online: number;
	nodes: number;
	needs: number;
	working: number;
	/** Shown while the browser has not been asked for notifications. */
	onNotify?: () => void;
}

/** The status bar: the socket and nodes on the left, what the agents need, then notifications and the build. */
export function DeckStatusBar({ socket, online, nodes, needs, working, onNotify }: StatusBarProps) {
	const health = useHealth();
	const version = health.data?.version;
	const connected = socket === "open";
	return (
		<footer className="flex h-6 shrink-0 items-center gap-4 border-t border-dk-line bg-dk-chrome px-3 text-[11.5px] text-dk-ink-2 tabular-nums" data-deck-status="">
			<span className="flex items-center gap-1.5" role="status" data-socket-status={socket}>
				<span className={cx("size-[7px] rounded-full", connected ? "bg-dk-ink-2" : "border-[1.5px] border-dashed border-dk-ink-3")} aria-hidden="true" />
				{connected ? "Connected" : socket === "closed" ? "Reconnecting…" : "Connecting…"}
			</span>
			{connected && nodes > 0 && <span data-status-nodes="">{online === nodes ? `${nodes} ${nodes === 1 ? "node" : "nodes"} online` : `${online} of ${nodes} nodes online`}</span>}
			{needs > 0 && <span className="font-medium text-dk-needs-ink" data-status-needs="">{needs === 1 ? "1 needs you" : `${needs} need you`}</span>}
			{working > 0 && <span data-status-working="">{working} working</span>}
			<span className="ml-auto flex items-center gap-4">
				{onNotify && (
					<button type="button" className="h-5 rounded-[3px] px-1 hover:bg-dk-hover hover:text-dk-ink" onClick={onNotify} {...tip("Notify me when an agent waits or finishes")} data-notify-enable="">
						Turn on notifications
					</button>
				)}
				{version && (
					<span className="text-dk-ink-3" data-selectable="" {...tip(health.data?.revision ? `Built from commit ${health.data.revision}` : `pika ${version}`)} data-server-version="">
						pika {version}
					</span>
				)}
			</span>
		</footer>
	);
}
