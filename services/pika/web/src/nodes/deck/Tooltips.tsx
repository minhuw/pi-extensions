/**
 * Deck's tooltips, in place of the browser's `title`: a control carries `data-tip` (and its shortcut in
 * `data-tip-keys`, from `tip`), and one listener on the page shows it the way a desktop app does. The first after a
 * pause of 600 ms; moving to another control while one shows (or just after) shows the next at once; a press, a key,
 * a scroll, or leaving hides it. Touch never shows one. The tip repeats the control's name, which its `aria-label` or
 * text already gives assistive technology, so the bubble itself is `aria-hidden`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { actionShortcut, type ActionId } from "../keys";

/** A control's tooltip, with the shortcut of the action it runs. */
export function tip(label: string | undefined, action?: ActionId): { "data-tip"?: string; "data-tip-keys"?: string } {
	if (!label) return {};
	const keys = action && actionShortcut(action);
	return keys ? { "data-tip": label, "data-tip-keys": keys } : { "data-tip": label };
}

const DELAY_MS = 600;
/** After a tip hides, the next one within this long shows at once. */
const WARM_MS = 500;
const GAP = 6;
const EDGE = 4;

interface Shown {
	text: string;
	keys?: string;
	box: DOMRect;
}

export function DeckTooltips({ root }: { root: HTMLElement | null }) {
	const [shown, setShown] = useState<Shown>();
	useEffect(() => {
		if (!root) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let current: HTMLElement | undefined;
		let showing = false;
		let warmUntil = 0;
		const hide = () => {
			clearTimeout(timer);
			if (showing) warmUntil = Date.now() + WARM_MS;
			showing = false;
			current = undefined;
			setShown(undefined);
		};
		const show = (element: HTMLElement) => {
			if (!element.isConnected || !element.dataset.tip) return;
			showing = true;
			setShown({ text: element.dataset.tip, ...(element.dataset.tipKeys ? { keys: element.dataset.tipKeys } : {}), box: element.getBoundingClientRect() });
		};
		const over = (event: PointerEvent) => {
			if (event.pointerType === "touch" || event.buttons !== 0) return;
			const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tip]") : null;
			if (element === current) return;
			const warm = showing || Date.now() < warmUntil;
			if (!element) return hide();
			clearTimeout(timer);
			current = element;
			if (warm) show(element);
			else {
				if (showing) setShown(undefined);
				showing = false;
				timer = setTimeout(() => show(element), DELAY_MS);
			}
		};
		const out = (event: PointerEvent) => {
			if (!event.relatedTarget || !root.contains(event.relatedTarget as Node)) hide();
		};
		root.addEventListener("pointerover", over);
		root.addEventListener("pointerout", out);
		root.addEventListener("pointerdown", hide, true);
		window.addEventListener("keydown", hide, true);
		window.addEventListener("wheel", hide, { capture: true, passive: true });
		window.addEventListener("blur", hide);
		return () => {
			clearTimeout(timer);
			root.removeEventListener("pointerover", over);
			root.removeEventListener("pointerout", out);
			root.removeEventListener("pointerdown", hide, true);
			window.removeEventListener("keydown", hide, true);
			window.removeEventListener("wheel", hide, true);
			window.removeEventListener("blur", hide);
		};
	}, [root]);
	return shown ? <Bubble shown={shown} /> : null;
}

function Bubble({ shown }: { shown: Shown }) {
	const ref = useRef<HTMLDivElement>(null);
	const [place, setPlace] = useState<{ left: number; top: number }>();
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const { width, height } = element.getBoundingClientRect();
		const { box } = shown;
		const left = Math.max(EDGE, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - EDGE));
		const below = box.bottom + GAP;
		setPlace({ left, top: below + height > window.innerHeight - EDGE ? Math.max(EDGE, box.top - GAP - height) : below });
	}, [shown]);
	return (
		<div
			ref={ref}
			className="dk-tooltip"
			aria-hidden="true"
			style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}
			data-tooltip={shown.text}
		>
			{shown.text}
			{shown.keys && <kbd className="dk-tooltip-keys">{shown.keys}</kbd>}
		</div>
	);
}
