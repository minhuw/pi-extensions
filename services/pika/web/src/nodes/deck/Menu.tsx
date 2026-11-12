/**
 * Deck's one menu: context menus (tabs, agent rows, tree items) and menus that drop from a button (the app menu, the
 * project switcher), drawn and driven like a desktop app's.
 *
 * - **Placement:** `position: fixed` at the pointer, or under its button; measured before paint and moved inside the
 *   window, flipping above when it would run off the bottom.
 * - **Keyboard:** focus starts on the first item (or the checked one); arrows, Home and End move, a letter jumps to the
 *   next item it starts, Enter and Space choose, Escape and Tab close and give focus back.
 * - **Pointer:** the item under the pointer is the highlighted one, as keyboard focus is; a press outside, the window
 *   losing focus, or a resize closes the menu. Opening one menu closes any other.
 *
 * Each `useMenu` draws its own menu where its owner renders, so the owner must sit outside anything that contains
 * fixed children (`content-visibility`, `transform`): the rail and the workspace render theirs at their top level.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../components/ui";

export type MenuEntry =
	| {
			id: string;
			label: string;
			run: () => void;
			/** The shortcut that does the same, as `actionShortcut` formats it. */
			shortcut?: string;
			disabled?: boolean;
			/** Why a disabled item cannot run (an older pika-node, a node not connected), under its label. */
			detail?: string;
			/** Ends or destroys something (Kill, Remove): red text. */
			danger?: boolean;
			/** A choice among several (the current project, the theme): a check before it, and focus starts on it. */
			checked?: boolean;
	  }
	| "separator";

export interface MenuRequest {
	/** The menu's top-left corner: the pointer, or the button's bottom-left. */
	x: number;
	y: number;
	/** Where the menu's bottom goes when it flips above (the button's top); the pointer's `y` without one. */
	flipY?: number;
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
const ITEMS = "[role='menuitem']:not(:disabled), [role='menuitemradio']:not(:disabled)";
const EDGE = 4;

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
	return { menu: request ? <MenuList key={request.serial} request={request} onClose={close} /> : null, open, close, openFor: request?.label };
}

function MenuList({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
	const list = useRef<HTMLDivElement>(null);
	const restore = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const [place, setPlace] = useState<{ left: number; top: number }>();

	useLayoutEffect(() => {
		const element = list.current;
		if (!element) return;
		const { width, height } = element.getBoundingClientRect();
		const left = Math.max(EDGE, Math.min(request.x, window.innerWidth - width - EDGE));
		let top = request.y;
		if (top + height > window.innerHeight - EDGE) top = Math.max(EDGE, (request.flipY ?? request.y) - height);
		setPlace({ left, top });
	}, [request]);

	// Focus once placed: a menu measured while hidden takes no focus.
	const placed = place !== undefined;
	useLayoutEffect(() => {
		if (!placed) return;
		const items = [...(list.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
		(items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
	}, [placed]);

	useEffect(() => {
		const away = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!list.current?.contains(target) && !request.anchor?.contains(target)) onClose();
		};
		window.addEventListener("pointerdown", away, true);
		window.addEventListener("blur", onClose);
		window.addEventListener("resize", onClose);
		return () => {
			window.removeEventListener("pointerdown", away, true);
			window.removeEventListener("blur", onClose);
			window.removeEventListener("resize", onClose);
		};
	}, [onClose, request.anchor]);

	const back = () => {
		onClose();
		if (restore.current?.isConnected) restore.current.focus();
	};

	const key = (event: KeyboardEvent<HTMLDivElement>) => {
		const items = [...(list.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
		const at = items.indexOf(document.activeElement as HTMLElement);
		if (event.key === "ArrowDown") items[(at + 1) % items.length]?.focus();
		else if (event.key === "ArrowUp") items[(at - 1 + items.length) % items.length]?.focus();
		else if (event.key === "Home" || event.key === "PageUp") items[0]?.focus();
		else if (event.key === "End" || event.key === "PageDown") items.at(-1)?.focus();
		else if (event.key === "Escape" || event.key === "Tab" || isMenuKey(event)) back();
		else if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
			const letter = event.key.toLowerCase();
			const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
			order.find((item) => item.dataset.menuLabel?.toLowerCase().startsWith(letter))?.focus();
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<div
			ref={list}
			role="menu"
			aria-label={request.label}
			className="dk-menu fixed z-50 min-w-[200px] max-w-[360px] p-1"
			style={place ? { left: place.left, top: place.top } : { left: request.x, top: request.y, visibility: "hidden" }}
			onKeyDown={key}
			onContextMenu={(event) => event.preventDefault()}
			data-menu={request.label}
			{...request.attrs}
		>
			{request.items.map((item, index) =>
				item === "separator" ? (
					<div key={`separator-${index}`} className="mx-2 my-1 h-px bg-dk-line" role="separator" />
				) : (
					<button
						key={item.id}
						type="button"
						role={item.checked === undefined ? "menuitem" : "menuitemradio"}
						aria-checked={item.checked}
						tabIndex={-1}
						disabled={item.disabled}
						className={cx("dk-menu-item", item.danger && "dk-menu-danger")}
						onPointerMove={(event) => {
							if (!item.disabled && document.activeElement !== event.currentTarget) event.currentTarget.focus();
						}}
						onClick={() => {
							// Focus goes back where it was, then the item may move it (opening a file, a dialog).
							back();
							item.run();
						}}
						data-menu-item={item.id}
						data-menu-label={item.label}
					>
						<span className="flex w-3.5 shrink-0 justify-center" aria-hidden="true">
							{item.checked && (
								<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
									<path d="M2.5 6.2 5 8.7l4.5-5.4" />
								</svg>
							)}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate">{item.label}</span>
							{item.detail && (
								<span className="block text-[11px] leading-[1.35] whitespace-normal text-dk-ink-3" data-menu-detail="">
									{item.detail}
								</span>
							)}
						</span>
						{item.shortcut && <kbd className="dk-menu-keys">{item.shortcut}</kbd>}
					</button>
				),
			)}
		</div>
	);
}
