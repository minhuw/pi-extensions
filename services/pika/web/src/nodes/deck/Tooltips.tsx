/**
 * Deck's tooltips, in place of the browser's `title`: a control carries `data-tip` (and its shortcut in
 * `data-tip-keys`, from `tip`), and one listener on the page shows it the way a desktop app does. The first after a
 * pause of 600 ms; moving to another control while one shows (or just after) shows the next at once; a press, a key,
 * a scroll, or leaving hides it. Touch never shows one. The tip repeats the control's name, which its `aria-label` or
 * text already gives assistive technology, so the bubble itself is `aria-hidden`.
 *
 * The bubble is shadcn/ui's tooltip on Base UI (`components/ui-shadcn/tooltip.tsx`), anchored to the control the
 * pointer rests on, which places it below (above at the window's bottom) and inside the window. One tooltip serves
 * every control, so the ~40 controls that carry a tip need no wrapper each.
 */

import { useEffect, useState } from "react";
import { Tooltip, TooltipContent } from "../../components/ui-shadcn/tooltip";
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

interface Shown {
	text: string;
	keys?: string;
	element: HTMLElement;
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
			setShown({ text: element.dataset.tip, ...(element.dataset.tipKeys ? { keys: element.dataset.tipKeys } : {}), element });
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
	if (!shown) return null;
	return (
		<Tooltip open>
			<TooltipContent anchor={shown.element} aria-hidden="true" data-tooltip={shown.text}>
				{shown.text}
				{shown.keys && <kbd className="font-[inherit] tracking-[0.04em] whitespace-nowrap opacity-70">{shown.keys}</kbd>}
			</TooltipContent>
		</Tooltip>
	);
}
