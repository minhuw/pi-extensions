import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { AppProviders, AppRoutes } from "../../src/App";
import { PikaApi } from "../../src/lib/api";
import { SessionViewContext, type SessionViewContextValue } from "../../src/session/context";

function testQueryClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
}

/** Renders `ui` with the app's providers and a router at `path`. */
export function renderWithApi(ui: ReactNode, fetchImpl: typeof fetch, path = "/") {
	const api = new PikaApi("/", fetchImpl);
	return render(
		<AppProviders api={api} queryClient={testQueryClient()}>
			<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
		</AppProviders>,
	);
}

export function renderApp(path: string, fetchImpl: typeof fetch, base = "/") {
	const api = new PikaApi(base, fetchImpl);
	return render(
		<AppProviders api={api} queryClient={testQueryClient()}>
			<MemoryRouter initialEntries={[path]}>
				<AppRoutes />
			</MemoryRouter>
		</AppProviders>,
	);
}

/** Renders a component inside the providers the session view gives its timeline. */
export function renderInSession(ui: ReactNode, context: Partial<SessionViewContextValue> = {}) {
	const api = new PikaApi("/", (async () => new Response("{}")) as typeof fetch);
	const value: SessionViewContextValue = { sessionId: "s1", childrenByToolCall: new Map(), ...context };
	return render(
		<AppProviders api={api} queryClient={testQueryClient()}>
			<MemoryRouter>
				<SessionViewContext.Provider value={value}>{ui}</SessionViewContext.Provider>
			</MemoryRouter>
		</AppProviders>,
	);
}

const PANE = "[data-scroll-root], [data-scroll-pane]";
const LIST = "[data-turn-list], [data-session-list], [data-virtual-list]";

function isPane(element: Element): boolean {
	return element.hasAttribute("data-scroll-root") || element.hasAttribute("data-scroll-pane");
}

/**
 * Gives jsdom a layout: the main scroll pane and drawer panes are `viewport` pixels tall and every
 * virtual row is `rowHeight` pixels tall; a pane's scroll height follows its virtual list. Returns
 * a function that restores the prototypes.
 */
export function mockLayout({ viewport, rowHeight }: { viewport: number; rowHeight: number }): () => void {
	const proto = HTMLElement.prototype;
	const saved = {
		clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
		clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
		offsetHeight: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
		scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight"),
	};
	const originalRect = Element.prototype.getBoundingClientRect;
	// Lists sit at the top of the scroll content, so they move up as the pane scrolls.
	Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
		const root = this.closest<HTMLElement>(PANE);
		if (root && this.matches(LIST)) {
			const top = -root.scrollTop;
			return { x: 0, y: top, top, left: 0, right: 1200, bottom: top, width: 1200, height: 0, toJSON: () => ({}) } as DOMRect;
		}
		return originalRect.call(this);
	};
	Object.defineProperty(proto, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement) {
			if (!isPane(this)) return 0;
			const list = this.querySelector<HTMLElement>(LIST);
			return Math.max(viewport, (list ? parseFloat(list.style.height) || 0 : 0) + 600);
		},
	});
	Object.defineProperty(proto, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return isPane(this) ? viewport : 0;
		},
	});
	Object.defineProperty(proto, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return isPane(this) ? 1200 : 0;
		},
	});
	Object.defineProperty(proto, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.hasAttribute("data-index") ? rowHeight : 0;
		},
	});
	return () => {
		Element.prototype.getBoundingClientRect = originalRect;
		for (const [key, descriptor] of Object.entries(saved)) {
			if (descriptor) Object.defineProperty(proto, key, descriptor);
			else delete (proto as unknown as Record<string, unknown>)[key];
		}
	};
}

/** Scrolls the main pane like a browser would, clamped to its scroll height. */
export function scrollMain(top: number): void {
	const root = document.querySelector<HTMLElement>("[data-scroll-root]");
	if (!root) throw new Error("no scroll root");
	root.scrollTop = Math.max(0, Math.min(top, root.scrollHeight - root.clientHeight));
	root.dispatchEvent(new Event("scroll"));
}
