/**
 * Deck's one menu: context menus (tabs, agent rows, tree items) and menus that drop from a button (the app menu, the
 * project switcher, the rail's "+"), drawn and driven like a desktop app's (macOS, Zed, VS Code).
 *
 * - **Rows:** a 16 px icon column (an item's icon, or the check of a chosen one), the label, a muted hint (a path),
 *   the shortcut right-aligned, and a chevron on an item that opens a submenu. Headers name a group of items;
 *   a note is one line of explanation where there is nothing to choose.
 * - **Disabled items** stay in the list only when that teaches something (an older pika-node). They can be
 *   highlighted but not chosen, and say why once, in a bubble beside the menu while highlighted, never as a second
 *   line under every item.
 * - **Placement:** `position: fixed` at the pointer, or under its button; measured before paint and moved inside the
 *   window, flipping above when it would run off the bottom. A submenu opens beside its item, flipping left.
 * - **Keyboard:** focus starts on the first enabled item (or the checked one); arrows, Home and End move, a letter
 *   jumps to the next item it starts, Enter and Space choose, Right opens a submenu and Left or Escape leaves it;
 *   Escape and Tab close the menu and give focus back.
 * - **Pointer:** the item under the pointer is the highlighted one, as keyboard focus is; resting on a submenu's item
 *   opens it. A press outside, the window losing focus, or a resize closes the menu. Opening one menu closes any other.
 *
 * Each `useMenu` draws its own menu where its owner renders, so the owner must sit outside anything that contains
 * fixed children (`content-visibility`, `transform`): the rail and the workspace render theirs at their top level.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cx } from "../../components/ui";
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
	/** A choice among several (the current project, the theme): a check before it, and focus starts on it. */
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

export interface MenuRequest {
	/** The menu's top-left corner: the pointer, or the button's bottom-left. */
	x: number;
	y: number;
	/** Where the menu's bottom goes when it flips above (the button's top); the pointer's `y` without one. */
	flipY?: number;
	/** Where the menu's right edge goes when it would run off the right (a submenu's parent item's left). */
	flipX?: number;
	/** The button that opened it: pressing it again closes the menu (its owner's toggle) rather than reopening it. */
	anchor?: Element;
	items: readonly MenuEntry[];
	/** The menu's accessible name. */
	label: string;
	/** Extra attributes on the menu element, for tests (`data-tab-menu`, ...). */
	attrs?: Record<string, string>;
}

/** A menu at a pointer event (a right click), or under an element (a button, or a row opened from the keyboard). */
export const menuAtPointer = (event: { clientX: number; clientY: number }) => ({ x: event.clientX, y: event.clientY });
export function menuBelow(element: Element) {
	const box = element.getBoundingClientRect();
	return { x: box.left, y: box.bottom + 2, flipY: box.top - 2, anchor: element };
}

/** Whether a key opens a focused element's context menu: the menu key, or Shift+F10. */
export const isMenuKey = (event: { key: string; shiftKey: boolean }) => event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

const OPENED = "pika-deck-menu";
/** A list's own items: submenus render beside it, not inside it. */
const ITEMS = "[data-menu-item]";
const EDGE = 4;
/** How long the pointer rests on an item before its submenu opens, or on another item before an open one closes. */
const SUBMENU_MS = 120;

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
	return { menu: request ? <RootMenu key={request.serial} request={request} onClose={close} /> : null, open, close, openFor: request?.label };
}

function RootMenu({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
	const tree = useId();
	const restore = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

	useEffect(() => {
		const away = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (target?.closest?.("[data-menu-tree]")?.getAttribute("data-menu-tree") === tree || request.anchor?.contains(target)) return;
			onClose();
		};
		window.addEventListener("pointerdown", away, true);
		window.addEventListener("blur", onClose);
		window.addEventListener("resize", onClose);
		return () => {
			window.removeEventListener("pointerdown", away, true);
			window.removeEventListener("blur", onClose);
			window.removeEventListener("resize", onClose);
		};
	}, [onClose, request.anchor, tree]);

	// Focus goes back where it was, then a chosen item may move it (opening a file, a dialog).
	const finish = useCallback(() => {
		onClose();
		if (restore.current?.isConnected) restore.current.focus();
	}, [onClose]);

	return <MenuList request={request} tree={tree} finish={finish} focusFirst />;
}

interface Open {
	index: number;
	box: DOMRect;
	/** Opened from the keyboard: focus moves into it. */
	focus: boolean;
}

function MenuList({ request, tree, finish, focusFirst, onBack, onEnter }: {
	request: MenuRequest;
	tree: string;
	/** Closes the whole menu and gives focus back. */
	finish: () => void;
	/** Focus the first item once placed (the root, or a submenu opened from the keyboard). */
	focusFirst: boolean;
	/** In a submenu: close it and focus its item in the parent. */
	onBack?: () => void;
	/** In a submenu: the pointer came in, so a pending close must not happen. */
	onEnter?: () => void;
}) {
	const list = useRef<HTMLDivElement>(null);
	const reasonId = useId();
	const [place, setPlace] = useState<{ left: number; top: number }>();
	const [sub, setSub] = useState<Open>();
	const [active, setActive] = useState<number>();
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	useLayoutEffect(() => {
		const element = list.current;
		if (!element) return;
		const { width, height } = element.getBoundingClientRect();
		let left = request.x;
		if (left + width > window.innerWidth - EDGE) left = request.flipX !== undefined ? request.flipX - width : window.innerWidth - width - EDGE;
		left = Math.max(EDGE, left);
		let top = request.y;
		if (top + height > window.innerHeight - EDGE) top = request.flipY !== undefined ? request.flipY - height : window.innerHeight - height - EDGE;
		setPlace({ left, top: Math.max(EDGE, top) });
	}, [request]);

	const elements = () => [...(list.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
	const enabled = (element: HTMLElement) => element.getAttribute("aria-disabled") !== "true";

	// Focus once placed: a menu measured while hidden takes no focus. With nothing to choose, the menu itself takes it,
	// so Escape still closes it.
	const placed = place !== undefined;
	useLayoutEffect(() => {
		if (!placed || !focusFirst) return;
		const items = elements();
		(items.find((item) => item.getAttribute("aria-checked") === "true") ?? items.find(enabled) ?? items[0] ?? list.current)?.focus();
	}, [placed, focusFirst]);

	const entries = request.items;
	const indexOf = (element: Element | null) => (element instanceof HTMLElement && element.dataset.menuIndex ? Number(element.dataset.menuIndex) : undefined);

	const openSub = (index: number, focus: boolean) => {
		const element = list.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`);
		if (!element) return;
		clearTimeout(timer.current);
		setSub({ index, box: element.getBoundingClientRect(), focus });
	};
	const closeSub = (refocus: boolean) => {
		clearTimeout(timer.current);
		const index = sub?.index;
		setSub(undefined);
		if (refocus && index !== undefined) list.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`)?.focus();
	};

	const key = (event: KeyboardEvent<HTMLDivElement>) => {
		const items = elements();
		const at = items.indexOf(document.activeElement as HTMLElement);
		const current = items[at];
		const entry = current ? entries[indexOf(current) ?? -1] : undefined;
		const item = entry && isMenuItem(entry) ? entry : undefined;
		if (event.key === "ArrowDown") items[(at + 1) % items.length]?.focus();
		else if (event.key === "ArrowUp") items[(at - 1 + items.length) % items.length]?.focus();
		else if (event.key === "Home" || event.key === "PageUp") items[0]?.focus();
		else if (event.key === "End" || event.key === "PageDown") items.at(-1)?.focus();
		else if (event.key === "ArrowRight" && item?.submenu && !item.disabled) openSub(indexOf(current!)!, true);
		else if ((event.key === "ArrowLeft" || event.key === "Escape") && onBack) onBack();
		else if (event.key === "Escape" || event.key === "Tab" || isMenuKey(event)) finish();
		else if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
			const letter = event.key.toLowerCase();
			const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
			order.find((element) => element.dataset.menuLabel?.toLowerCase().startsWith(letter))?.focus();
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	const choose = (item: MenuItem, index: number) => {
		if (item.disabled) return;
		if (item.submenu) return openSub(index, true);
		finish();
		item.run?.();
	};

	const hover = (element: HTMLElement, item: MenuItem, index: number) => {
		if (document.activeElement !== element) element.focus();
		if (sub?.index === index) return clearTimeout(timer.current);
		clearTimeout(timer.current);
		if (item.submenu && !item.disabled) timer.current = setTimeout(() => openSub(index, false), SUBMENU_MS);
		else if (sub) timer.current = setTimeout(() => setSub(undefined), SUBMENU_MS);
	};

	const activeEntry = active !== undefined ? entries[active] : undefined;
	const reason = activeEntry && isMenuItem(activeEntry) && activeEntry.disabled && activeEntry.reason ? { index: active!, text: activeEntry.reason } : undefined;
	const subEntry = sub ? entries[sub.index] : undefined;

	// Consecutive items under a header form a group named by it.
	const rendered: ReactNode[] = [];
	let group: { id: string; label: string; children: ReactNode[] } | undefined;
	const flush = () => {
		if (!group) return;
		rendered.push(
			<div key={`group-${group.id}`} role="group" aria-labelledby={group.id}>
				{group.children}
			</div>,
		);
		group = undefined;
	};
	entries.forEach((entry, index) => {
		if (entry === "separator") {
			flush();
			rendered.push(<div key={`separator-${index}`} className="dk-menu-separator" role="separator" />);
		} else if (!isMenuItem(entry) && entry.kind === "header") {
			flush();
			const id = `${reasonId}-h${index}`;
			rendered.push(
				<div key={`header-${index}`} id={id} className="dk-menu-header" data-menu-header="">
					{entry.label}
				</div>,
			);
			group = { id, label: entry.label, children: [] };
		} else if (!isMenuItem(entry)) {
			(group?.children ?? rendered).push(
				<div key={`note-${index}`} className="dk-menu-note" data-menu-note="">
					{entry.text}
				</div>,
			);
		} else {
			const row = (
				<MenuRow
					key={entry.id}
					item={entry}
					index={index}
					expanded={entry.submenu ? sub?.index === index : undefined}
					describedBy={entry.disabled && entry.reason ? `${reasonId}-r${index}` : undefined}
					onHover={hover}
					onChoose={choose}
					onFocus={() => setActive(index)}
				/>
			);
			(group?.children ?? rendered).push(row);
		}
	});
	flush();

	return (
		<>
			<div
				ref={list}
				role="menu"
				tabIndex={-1}
				aria-label={request.label}
				className="dk-menu fixed z-50 min-w-[220px] max-w-[380px] p-1"
				style={place ? { left: place.left, top: place.top } : { left: request.x, top: request.y, visibility: "hidden" }}
				onKeyDown={key}
				onContextMenu={(event) => event.preventDefault()}
				onPointerEnter={onEnter}
				onBlur={(event) => {
					if (!list.current?.contains(event.relatedTarget as Node)) setActive(undefined);
				}}
				data-menu={request.label}
				data-menu-tree={tree}
				{...request.attrs}
			>
				{rendered}
				{/* Disabled items' reasons, as their descriptions: outside the items, so they are not part of their names. */}
				<div hidden>
					{entries.map((entry, index) =>
						isMenuItem(entry) && entry.disabled && entry.reason ? (
							<span key={index} id={`${reasonId}-r${index}`}>
								{entry.reason}
							</span>
						) : null,
					)}
				</div>
			</div>
			{reason && <Reason menu={list} index={reason.index} text={reason.text} />}
			{sub && subEntry && isMenuItem(subEntry) && subEntry.submenu && (
				<MenuList
					key={sub.index}
					request={{ x: sub.box.right + 2, y: sub.box.top - 5, flipX: sub.box.left - 2, flipY: sub.box.bottom + 5, items: subEntry.submenu, label: subEntry.label, attrs: { "data-submenu": subEntry.id } }}
					tree={tree}
					finish={finish}
					focusFirst={sub.focus}
					onBack={() => closeSub(true)}
					onEnter={() => clearTimeout(timer.current)}
				/>
			)}
		</>
	);
}

function MenuRow({ item, index, expanded, describedBy, onHover, onChoose, onFocus }: {
	item: MenuItem;
	index: number;
	expanded: boolean | undefined;
	describedBy: string | undefined;
	onHover: (element: HTMLElement, item: MenuItem, index: number) => void;
	onChoose: (item: MenuItem, index: number) => void;
	onFocus: () => void;
}) {
	return (
		<button
			type="button"
			role={item.checked === undefined ? "menuitem" : "menuitemradio"}
			aria-checked={item.checked}
			aria-disabled={item.disabled || undefined}
			aria-haspopup={item.submenu ? "menu" : undefined}
			aria-expanded={expanded}
			aria-describedby={describedBy}
			tabIndex={-1}
			className={cx("dk-menu-item", item.danger && "dk-menu-danger")}
			onPointerMove={(event) => onHover(event.currentTarget, item, index)}
			onFocus={onFocus}
			onClick={() => onChoose(item, index)}
			data-menu-item={item.id}
			data-menu-index={index}
			data-menu-label={item.label}
		>
			<span className="dk-menu-icon" aria-hidden="true">
				{item.checked ? <MenuIcon glyph="check" /> : item.checked === undefined && item.icon ? <MenuIcon glyph={item.icon} /> : null}
			</span>
			<span className="min-w-0 shrink truncate">{item.label}</span>
			{item.hint && <span className="dk-menu-hint">{item.hint}</span>}
			<span className="min-w-3 flex-1" />
			{item.shortcut && <kbd className="dk-menu-keys">{item.shortcut}</kbd>}
			{item.submenu && (
				<svg width="10" height="10" viewBox="0 0 10 10" className="dk-menu-chevron" aria-hidden="true">
					<path d="M3.75 2.25 6.5 5 3.75 7.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			)}
		</button>
	);
}

/** A disabled item's reason, in a bubble beside the menu, level with the item. */
function Reason({ menu, index, text }: { menu: RefObject<HTMLDivElement | null>; index: number; text: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [place, setPlace] = useState<{ left: number; top: number }>();
	useLayoutEffect(() => {
		const bubble = ref.current;
		const item = menu.current?.querySelector(`[data-menu-index="${index}"]`);
		if (!bubble || !item || !menu.current) return;
		const sheet = menu.current.getBoundingClientRect();
		const row = item.getBoundingClientRect();
		const { width, height } = bubble.getBoundingClientRect();
		const right = sheet.right + 6;
		const left = right + width > window.innerWidth - EDGE ? Math.max(EDGE, sheet.left - 6 - width) : right;
		setPlace({ left, top: Math.max(EDGE, Math.min(row.top + row.height / 2 - height / 2, window.innerHeight - height - EDGE)) });
	}, [menu, index, text]);
	return (
		<div ref={ref} className="dk-tooltip" aria-hidden="true" style={place ? place : { left: 0, top: 0, visibility: "hidden" }} data-menu-reason="">
			{text}
		</div>
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
