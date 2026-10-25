import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { installMatchMedia } from "./support/media";

// jsdom has no element scrolling; virtualizers call scrollTo when jumping between prompts.
Element.prototype.scrollTo = function scrollTo(this: Element, options?: ScrollToOptions | number, y?: number) {
	const top = typeof options === "number" ? (y ?? 0) : (options?.top ?? this.scrollTop);
	this.scrollTop = top;
	this.dispatchEvent(new Event("scroll"));
} as Element["scrollTo"];

beforeEach(() => {
	localStorage.clear();
	installMatchMedia(false);
	delete document.documentElement.dataset.theme;
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

