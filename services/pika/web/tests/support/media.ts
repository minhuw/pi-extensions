import { vi } from "vitest";

export type MediaMatcher = boolean | ((query: string) => boolean);

export function installMatchMedia(matcher: MediaMatcher): () => void {
	const previous = Object.getOwnPropertyDescriptor(window, "matchMedia");
	const matches = typeof matcher === "function" ? matcher : (query: string) => matcher && query.includes("dark");
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: vi.fn((query: string) => ({
			matches: matches(query),
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	});
	return () => {
		if (previous) Object.defineProperty(window, "matchMedia", previous);
		else delete (window as { matchMedia?: unknown }).matchMedia;
	};
}
