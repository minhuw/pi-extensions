import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { installMatchMedia } from "./support/media";

// jsdom has no element scrolling; virtualizers call scrollTo when jumping between prompts.
Element.prototype.scrollTo = function scrollTo(this: Element, options?: ScrollToOptions | number, y?: number) {
	const top = typeof options === "number" ? (y ?? 0) : (options?.top ?? this.scrollTop);
	this.scrollTop = top;
	this.dispatchEvent(new Event("scroll"));
} as Element["scrollTo"];

// jsdom has no ResizeObserver; terminal, editor, and layout views observe container size changes.
class NoopResizeObserver implements ResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

globalThis.ResizeObserver = NoopResizeObserver;

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	globalThis.ResizeObserver = NoopResizeObserver;
	installMatchMedia(false);
	delete document.documentElement.dataset.theme;
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

