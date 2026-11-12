/**
 * Deck's menus, as data drawn by shadcn/ui's dropdown menu on Base UI (`components/ui-shadcn/dropdown-menu.tsx`):
 * context menus (tabs, agent rows, tree items) and menus that drop from a button (the app menu, the project switcher,
 * the rail's "+"). Base UI does the keyboard (arrows, Home/End, typeahead, Right into a submenu and Left out of it,
 * Escape), the pointer (hover highlights, resting on a submenu's item opens it, a press outside closes), placement
 * with collision flipping, and focus. This module keeps Deck's rules on top:
 *
 * - **Rows:** an icon column (an item's icon, or the check of a chosen one), the label, a muted hint (a path), the
 *   shortcut right-aligned, a chevron on an item that opens a submenu. Headers name a group; a note is one line of
 *   explanation where there is nothing to choose.
 * - **Disabled items** stay in the list only when that teaches something (an older pika-node). They can be
 *   highlighted but not chosen, and say why once, in a bubble beside the menu while highlighted (and as the item's
 *   description), never as a second line under every item.
 * - **Opening:** imperatively, at the pointer or under an element, with no trigger; opening one menu closes any other.
 *   The window losing focus or resizing closes it, as a desktop menu does.
 * - **Focus:** a chosen item gets focus back where it was before it runs (it may move focus on: a dialog, a file);
 *   Escape gives it back too; a press outside leaves it where the press puts it.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
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
} from "../../components/ui-shadcn/dropdown-menu";
import { Tooltip, TooltipContent } from "../../components/ui-shadcn/tooltip";
import { Icon, type IconName } from "../../components/icons";

/** An item's icon: one of the shared icons, or a glyph only menus draw. */
export type MenuGlyph = IconName | "split-right" | "split-down" | "restart" | "unread" | "kill" | "pin" | "fold" | "node" | "keyboard" | "reveal";

export interface MenuItem {
	id: string;
	label: string;
	/** What choosing it does; an item with a `submenu` opens that instead. */
	run?: () => void;
	/** The items of the submenu this item opens. */
	submenu?: readonly MenuEntry[];
	icon?: MenuGlyph;
	/** Secondary text after the label, muted and truncated first (a project's path). */
	hint?: string;
	/** The shortcut that does the same, as `actionShortcut` formats it. */
	shortcut?: string;
	disabled?: boolean;
	/** Why a disabled item cannot run (an older pika-node); shown beside the menu while it is highlighted. */
	reason?: string;
	/** Ends or destroys something (Kill, Remove): red text. */
	danger?: boolean;
	/** A choice among several (the current project, the theme): a check before it. */
	checked?: boolean;
}

/** A group's name, above its items. */
export interface MenuHeader {
	kind: "header";
	label: string;
}

/** One line of explanation that is not a choice: why a menu has nothing to offer, or why some items are missing. */
export interface MenuNote {
	kind: "note";
	text: string;
}

export type MenuEntry = MenuItem | MenuHeader | MenuNote | "separator";

export const isMenuItem = (entry: MenuEntry): entry is MenuItem => typeof entry !== "string" && !("kind" in entry);
/** A menu's items, without separators, headers and notes. */
export const menuItems = (entries: readonly MenuEntry[]): MenuItem[] => entries.filter(isMenuItem);

/** Where a menu opens: under an element (a button, or a row opened from the keyboard), or at a point (the pointer). */
export type MenuAnchor = Element | { x: number; y: number };

export interface MenuRequest {
	anchor: MenuAnchor;
	items: readonly MenuEntry[];
	/** The menu's accessible name. */
	label: string;
	/** Extra attributes on the menu element, for tests (`data-tab-menu`, ...). */
	attrs?: Record<string, string>;
}

/** A menu at a pointer event (a right click), or under an element (a button, or a row opened from the keyboard). */
export const menuAtPointer = (event: { clientX: number; clientY: number }): { anchor: MenuAnchor } => ({ anchor: { x: event.clientX, y: event.clientY } });
export const menuBelow = (element: Element): { anchor: MenuAnchor } => ({ anchor: element });

/** Whether a key opens a focused element's context menu: the menu key, or Shift+F10. */
export const isMenuKey = (event: { key: string; shiftKey: boolean }) => event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

const OPENED = "pika-deck-menu";

/**
 * Whether the latest input was a key rather than a press, as for `:focus-visible`: a menu opened from the keyboard
 * starts on its first item (or its checked one), one opened by the pointer starts with nothing highlighted, as on the
 * desktop. Base UI does this for menus with a trigger; Deck's menus have none.
 */
let fromKeyboard = false;
window.addEventListener("keydown", () => (fromKeyboard = true), true);
window.addEventListener("pointerdown", () => (fromKeyboard = false), true);

/** One menu's state and element: `open` shows it (closing any other menu), `menu` is what to render. */
export function useMenu(): { menu: ReactNode; open: (request: MenuRequest) => void; close: () => void; openFor: string | undefined } {
	const [request, setRequest] = useState<MenuRequest & { serial: number }>();
	const serial = useRef(0);
	const close = useCallback(() => setRequest(undefined), []);
	const open = useCallback((next: MenuRequest) => {
		serial.current += 1;
		window.dispatchEvent(new CustomEvent(OPENED, { detail: serial.current }));
		setRequest({ ...next, serial: serial.current });
	}, []);
	useEffect(() => {
		if (!request) return;
		const other = (event: Event) => {
			if ((event as CustomEvent<number>).detail !== request.serial) close();
		};
		window.addEventListener(OPENED, other);
		return () => window.removeEventListener(OPENED, other);
	}, [request, close]);
	return { menu: request ? <EntryMenu key={request.serial} request={request} onClose={close} /> : null, open, close, openFor: request?.label };
}

/** A point as Base UI's virtual anchor: a zero-size box at it. */
const pointAnchor = (x: number, y: number) => ({ getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) });

function EntryMenu({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
	const restore = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const [highlighted, setHighlighted] = useState<HTMLElement>();
	const reasonIds = useId();
	const { anchor } = request;
	const element = anchor instanceof Element ? anchor : undefined;
	const [virtual] = useState(() => (anchor instanceof Element ? undefined : pointAnchor(anchor.x, anchor.y)));
	const [keyboard] = useState(fromKeyboard);
	const popup = useRef<HTMLDivElement>(null);
	// Base UI can report the menu closed once more after it is gone (focus leaving it for a dialog its item opened);
	// that late report must not pull focus back. A layout effect, so it is cleared before the dialog's field takes focus.
	const mounted = useRef(false);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Focusing an item highlights it in Base UI, and the arrows go on from there.
	useEffect(() => {
		if (!keyboard) return;
		const frame = requestAnimationFrame(() => {
			const items = [...(popup.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? [])];
			(items.find((item) => item.getAttribute("aria-checked") === "true") ?? items.find((item) => !item.hasAttribute("data-disabled")))?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [keyboard]);

	useEffect(() => {
		window.addEventListener("blur", onClose);
		window.addEventListener("resize", onClose);
		return () => {
			window.removeEventListener("blur", onClose);
			window.removeEventListener("resize", onClose);
		};
	}, [onClose]);

	// Focus goes back where it was, then the item runs and may move it on (opening a file, a dialog).
	const choose = (item: MenuItem) => {
		if (item.disabled || item.submenu) return;
		if (restore.current?.isConnected) restore.current.focus();
		onClose();
		item.run?.();
	};

	const reason = highlighted?.dataset.reason;
	return (
		<DropdownMenu
			open
			modal={false}
			onOpenChange={(open, details) => {
				if (open || !mounted.current) return;
				if (details.reason === "outside-press") {
					// The button that opened it toggles it: its own press is not "outside", so its click closes the menu.
					// Any other press closes it and leaves focus where the press puts it.
					if (!element?.contains(details.event.target as Node)) onClose();
					return;
				}
				if (restore.current?.isConnected) restore.current.focus();
				onClose();
			}}
			onItemHighlighted={(item) => setHighlighted(item)}
		>
			<DropdownMenuContent
				ref={popup}
				anchor={element ?? virtual}
				sideOffset={element ? 2 : 0}
				// Focus is given back here (the menu unmounts as it closes, before Base UI's own return could run).
				finalFocus={false}
				aria-label={request.label}
				onContextMenu={(event) => event.preventDefault()}
				data-menu={request.label}
				{...request.attrs}
			>
				<Entries entries={request.items} reasonIds={reasonIds} onChoose={choose} />
				{/* Disabled items' reasons, as their descriptions: outside the items, so they are not part of their names. */}
				<div hidden>
					{reasons(request.items, reasonIds).map(([id, text]) => (
						<span key={id} id={id}>
							{text}
						</span>
					))}
				</div>
			</DropdownMenuContent>
			{reason && highlighted && (
				<Tooltip open>
					<TooltipContent anchor={highlighted} side="inline-end" sideOffset={10} aria-hidden="true" data-menu-reason="">
						{reason}
					</TooltipContent>
				</Tooltip>
			)}
		</DropdownMenu>
	);
}

/** Every disabled item's reason in a menu and its submenus, with the id its item is described by. */
function reasons(entries: readonly MenuEntry[], prefix: string): [string, string][] {
	return entries.flatMap((entry, index): [string, string][] => {
		if (!isMenuItem(entry)) return [];
		if (entry.submenu) return reasons(entry.submenu, `${prefix}-${index}`);
		return entry.disabled && entry.reason ? [[`${prefix}-${index}`, entry.reason]] : [];
	});
}

/** Entries as rows: consecutive items under a header form a group named by it. */
function Entries({ entries, reasonIds, onChoose }: { entries: readonly MenuEntry[]; reasonIds: string; onChoose: (item: MenuItem) => void }) {
	const rendered: ReactNode[] = [];
	let group: { key: string; label: string; children: ReactNode[] } | undefined;
	const flush = () => {
		if (!group) return;
		rendered.push(
			<DropdownMenuGroup key={group.key}>
				<DropdownMenuLabel data-menu-header="">{group.label}</DropdownMenuLabel>
				{group.children}
			</DropdownMenuGroup>,
		);
		group = undefined;
	};
	entries.forEach((entry, index) => {
		if (entry === "separator") {
			flush();
			rendered.push(<DropdownMenuSeparator key={`separator-${index}`} />);
		} else if (!isMenuItem(entry) && entry.kind === "header") {
			flush();
			group = { key: `group-${index}`, label: entry.label, children: [] };
		} else if (!isMenuItem(entry)) {
			(group?.children ?? rendered).push(
				<div key={`note-${index}`} className="max-w-[300px] py-[5px] pr-2 pl-[30px] text-[12px] leading-4 whitespace-normal text-dk-ink-2" data-menu-note="">
					{entry.text}
				</div>,
			);
		} else {
			(group?.children ?? rendered).push(<Row key={entry.id} item={entry} reasonId={`${reasonIds}-${index}`} onChoose={onChoose} />);
		}
	});
	flush();
	return <>{rendered}</>;
}

function Row({ item, reasonId, onChoose }: { item: MenuItem; reasonId: string; onChoose: (item: MenuItem) => void }) {
	const content = (
		<>
			<DropdownMenuIcon>{item.checked ? <MenuIcon glyph="check" /> : item.checked === undefined && item.icon ? <MenuIcon glyph={item.icon} /> : null}</DropdownMenuIcon>
			<span className="min-w-0 shrink truncate">{item.label}</span>
			{item.hint && <DropdownMenuHint>{item.hint}</DropdownMenuHint>}
		</>
	);
	const data = { "data-menu-item": item.id, "data-menu-label": item.label };
	if (item.submenu) {
		return (
			<DropdownMenuSub>
				<DropdownMenuSubTrigger label={item.label} disabled={item.disabled} {...data}>
					{content}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent aria-label={item.label} data-submenu={item.id}>
					<Entries entries={item.submenu} reasonIds={reasonId} onChoose={onChoose} />
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		);
	}
	const reason = item.disabled ? item.reason : undefined;
	return (
		<DropdownMenuItem
			label={item.label}
			disabled={item.disabled}
			// Disabled wins over red: an older daemon's Remove reads as unavailable, not as a live destructive action.
			variant={item.danger && !item.disabled ? "destructive" : "default"}
			// A choice among several reads as one: `menuitemradio` with its state.
			{...(item.checked !== undefined ? { role: "menuitemradio", "aria-checked": item.checked } : {})}
			aria-describedby={reason ? reasonId : undefined}
			onClick={() => onChoose(item)}
			data-reason={reason}
			{...data}
		>
			{content}
			{item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
		</DropdownMenuItem>
	);
}

/** Glyphs only menus draw, in the shared icons' 16-unit grid and 1.4 stroke. */
const GLYPHS: Record<Exclude<MenuGlyph, IconName> | "check", ReactNode> = {
	check: <path d="M3.5 8.4 6.6 11.4 12.5 4.6" />,
	"split-right": (
		<>
			<rect x="2.5" y="3" width="11" height="10" rx="1.5" />
			<path d="M8 3v10" />
		</>
	),
	"split-down": (
		<>
			<rect x="2.5" y="3" width="11" height="10" rx="1.5" />
			<path d="M2.5 8h11" />
		</>
	),
	restart: <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.5v2.6h2.6" />,
	unread: <circle cx="8" cy="8" r="2.75" fill="currentColor" stroke="none" />,
	kill: (
		<>
			<circle cx="8" cy="8" r="5.5" />
			<path d="m6 6 4 4M10 6l-4 4" />
		</>
	),
	pin: <path d="M6 2.5h4l-.6 4 2.1 2.2H4.5l2.1-2.2zM8 8.7v4.8" />,
	fold: <path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3" />,
	node: (
		<>
			<rect x="2.5" y="3" width="11" height="4" rx="1" />
			<rect x="2.5" y="9" width="11" height="4" rx="1" />
			<path d="M5 5h.01M5 11h.01" />
		</>
	),
	keyboard: (
		<>
			<rect x="1.75" y="4" width="12.5" height="8" rx="1.5" />
			<path d="M4.5 6.75h.01M7 6.75h.01M9 6.75h.01M11.5 6.75h.01M5.5 9.5h5" />
		</>
	),
	reveal: (
		<>
			<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
			<path d="m7 8.75 1.5 1.5 2.5-2.5" />
		</>
	),
};

function MenuIcon({ glyph }: { glyph: MenuGlyph | "check" }) {
	if (glyph in GLYPHS) {
		return (
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
				{GLYPHS[glyph as keyof typeof GLYPHS]}
			</svg>
		);
	}
	return <Icon name={glyph as IconName} size={14} />;
}
