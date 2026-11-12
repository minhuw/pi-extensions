import { describe, expect, it } from "vitest";
import { bandCrowded } from "../src/components/Layout";

/** An element whose box is `[left, right)` and that is shown, for `bandCrowded`'s measurements. */
function box(left: number, right: number, children: HTMLElement[] = [], end = false): HTMLElement {
	const element = document.createElement("div");
	if (end) element.setAttribute("data-band-end", "");
	element.append(...children);
	element.getBoundingClientRect = () => ({ left, right, width: right - left, top: 0, bottom: 48, height: 48, x: left, y: 0, toJSON: () => ({}) });
	element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
	return element;
}

function nav(tabsRight: number, searchLeft: number, overflow = false): HTMLElement {
	const element = box(0, 1000, [box(0, 120), box(120, tabsRight), box(tabsRight, 1000, [box(searchLeft, 960), box(960, 1000)], true)]);
	Object.defineProperty(element, "clientWidth", { value: 1000 });
	Object.defineProperty(element, "scrollWidth", { value: overflow ? 1200 : 1000 });
	return element;
}

describe("the band's fit", () => {
	it("is crowded when the controls on the right spill over the last tab, or the tabs overflow", () => {
		expect(bandCrowded(nav(600, 620))).toBe(false);
		expect(bandCrowded(nav(700, 650))).toBe(true);
		expect(bandCrowded(nav(600, 620, true))).toBe(true);
	});
});
