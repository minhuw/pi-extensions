import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import docsData from "virtual:pi-docs";
import { AppRoutes } from "../src/App";
import { searchDocs } from "../src/docs/search";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
	vi.unstubAllGlobals();
	if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
	else Reflect.deleteProperty(navigator, "clipboard");
});

function Location() {
	const location = useLocation();
	return <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>;
}

function openDocs(path = "/docs", basename = "/") {
	return render(<MemoryRouter basename={basename} initialEntries={[path]}><AppRoutes /><Location /></MemoryRouter>);
}

function clipboard(writeText: (text: string) => Promise<void>) {
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

describe("public documentation", () => {
	it("opens the reference without an authentication or data request", async () => {
		const fetch = vi.fn().mockRejectedValue(new Error("Documentation must not request private data"));
		vi.stubGlobal("fetch", fetch);
		document.title = "pika";
		const view = openDocs();
		expect(await screen.findByRole("heading", { level: 1, name: "Reference" })).toBeTruthy();
		expect(document.title).toBe("Reference · Pi extensions");
		expect(screen.getByRole("table").textContent).toContain("/benchmark");
		expect(fetch).not.toHaveBeenCalled();
		view.unmount();
		expect(document.title).toBe("pika");
	});

	it("renders canonical articles and follows relative links under a deployment basename", async () => {
		openDocs("/pika/docs/extensions/benchmark", "/pika");
		expect(await screen.findByRole("heading", { level: 1, name: "Benchmark" })).toBeTruthy();
		const main = screen.getByRole("main");
		expect(within(main).getByRole("link", { name: "Autoresearch" }).getAttribute("href")).toBe("/pika/docs/extensions/autoresearch");
		expect(within(main).getByRole("link", { name: "View source on GitHub" }).getAttribute("href")).toBe("https://github.com/minhuw/pi-extensions/blob/master/extensions/benchmark/README.md");
		for (const heading of docsData.pages.find((page) => page.slug === "extensions/benchmark")!.headings) {
			expect(document.getElementById(heading.id)?.textContent).toBe(heading.title);
		}
		fireEvent.click(within(main).getByRole("link", { name: "Autoresearch" }));
		expect(await screen.findByRole("heading", { level: 1, name: "Autoresearch" })).toBeTruthy();
	});

	it("keeps the query in the URL and supports a useful empty result", async () => {
		openDocs("/docs/search?q=%2Fbenchmark");
		const input = await screen.findByLabelText("Search documentation content");
		expect((input as HTMLInputElement).value).toBe("/benchmark");
		const main = screen.getByRole("main");
		const resultLinks = within(within(main).getByRole("list")).getAllByRole("link");
		expect(resultLinks[0].textContent).toContain("/benchmark");
		expect(resultLinks[0].getAttribute("href")).toBe("/docs/extensions/benchmark");
		fireEvent.change(input, { target: { value: "not-a-real-docs-term-923" } });
		expect(await screen.findByRole("heading", { name: "No results" })).toBeTruthy();
		expect(screen.getByTestId("location").textContent).toBe("/docs/search?q=not-a-real-docs-term-923");
		fireEvent.change(input, { target: { value: "" } });
		expect(await screen.findByRole("heading", { name: "Browse documentation" })).toBeTruthy();
		expect(screen.getByTestId("location").textContent).toBe("/docs/search");
	});

	it("submits masthead search and leaves ordinary input typing alone", async () => {
		openDocs();
		const input = await screen.findByLabelText("Search documentation", { selector: "input" });
		fireEvent.keyDown(window, { key: "/" });
		expect(document.activeElement).toBe(input);
		const key = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
		input.dispatchEvent(key);
		expect(key.defaultPrevented).toBe(false);
		fireEvent.change(input, { target: { value: "/herder" } });
		fireEvent.submit(input.closest("form")!);
		expect(await screen.findByLabelText("Search documentation content")).toBeTruthy();
		expect(screen.getByTestId("location").textContent).toBe("/docs/search?q=%2Fherder");
	});

	it("copies the actual command and reports clipboard failure with recovery", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		clipboard(writeText);
		openDocs();
		const button = await screen.findByRole("button", { name: "Copy code" });
		fireEvent.click(button);
		expect(await screen.findByText("Code copied")).toBeTruthy();
		expect(writeText).toHaveBeenCalledWith("/benchmark the new parser against main on the large fixture");
		writeText.mockRejectedValueOnce(new Error("denied"));
		fireEvent.click(button);
		expect(await screen.findByText("Select and copy the code below")).toBeTruthy();
	});

	it("preserves fenced code text when rendering Markdown examples", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		clipboard(writeText);
		openDocs("/docs/extensions/benchmark");
		await screen.findByRole("heading", { level: 1, name: "Benchmark" });
		fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[0]);
		await waitFor(() => expect(writeText).toHaveBeenCalled());
		expect(writeText.mock.calls[0][0]).toBe("/benchmark the new parser against main on the large fixture");
	});

	it("exposes the directory as a disclosure and retains theme preference", async () => {
		openDocs();
		const menu = await screen.findByRole("button", { name: "Browse documentation" });
		expect(menu.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(menu);
		expect(menu.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(localStorage.getItem("pika-theme")).toBe("dark");
		fireEvent.click(menu);
		expect(menu.getAttribute("aria-expanded")).toBe("false");
	});

	it("offers navigation for an unknown page and tolerates malformed fragments", async () => {
		openDocs("/docs/missing-reference#%E0%A4%A");
		expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
		expect(within(screen.getByRole("main")).getByRole("link", { name: "Reference overview" }).getAttribute("href")).toBe("/docs");
	});
});

describe("documentation search", () => {
	it("ranks exact commands first, finds sections, and requires every query term", () => {
		expect(searchDocs(docsData, "/benchmark")[0]).toMatchObject({ title: "/benchmark", kind: "command" });
		expect(searchDocs(docsData, "METRIC format").some((result) => result.href === "/docs/extensions/benchmark#the-metric-format")).toBe(true);
		expect(searchDocs(docsData, "benchmark not-a-real-docs-term-923")).toEqual([]);
		expect(searchDocs(docsData, "   ")).toEqual([]);
	});

	it("does not emit every chapter when only the page title matched", () => {
		const results = searchDocs(docsData, "benchmark");
		expect(results.some((result) => result.kind === "heading" && result.title === "Development")).toBe(false);
	});
});
