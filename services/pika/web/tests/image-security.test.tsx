import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";
import {
	classifyImageContent,
	classifyImageSrc,
	normalizeImageMimeType,
	SAFE_IMAGE_MIME_TYPES,
	safeDataImageSrc,
} from "../src/lib/safe-image";
import type { ImageContent, ToolResultMessage } from "../src/lib/types";
import { TimelineItemView } from "../src/session/TimelineItemView";
import { ResultImages } from "../src/session/tools/shared";
import { entry, toolResultMessage, userMessage } from "./support/fixtures";
import { renderInSession } from "./support/render";

// Minimal synthetic 1x1 transparent PNG payload (base64).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const SVG_B64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=";
const HTML_B64 = "PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";

describe("safe-image helpers", () => {
	it("normalizes allowlisted raster MIME types and rejects SVG and non-images", () => {
		for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]) {
			expect(SAFE_IMAGE_MIME_TYPES.has(mime)).toBe(true);
			expect(normalizeImageMimeType(mime)).toBe(mime);
		}
		expect(normalizeImageMimeType(" IMAGE/PNG ; charset=utf-8 ")).toBe("image/png");
		expect(normalizeImageMimeType("image/svg+xml")).toBeNull();
		expect(normalizeImageMimeType("image/svg+xml;charset=utf-8")).toBeNull();
		expect(normalizeImageMimeType("text/html")).toBeNull();
		expect(normalizeImageMimeType("application/javascript")).toBeNull();
		expect(normalizeImageMimeType("")).toBeNull();
		expect(normalizeImageMimeType(undefined)).toBeNull();
	});

	it("builds safe data URLs only for allowlisted raster MIME types with non-empty data", () => {
		expect(safeDataImageSrc("image/png", PNG_B64)).toBe(`data:image/png;base64,${PNG_B64}`);
		expect(safeDataImageSrc("IMAGE/WEBP; charset=binary", PNG_B64)).toBe(`data:image/webp;base64,${PNG_B64}`);
		expect(safeDataImageSrc("image/svg+xml", SVG_B64)).toBeNull();
		expect(safeDataImageSrc("text/html", HTML_B64)).toBeNull();
		expect(safeDataImageSrc("image/png", "")).toBeNull();
		expect(safeDataImageSrc("image/png", "   ")).toBeNull();
		expect(safeDataImageSrc(undefined, PNG_B64)).toBeNull();
	});

	it("classifies same-origin, external, data, and unsafe image URLs", () => {
		const origin = "https://pika.example";
		expect(classifyImageSrc("/api/v1/sessions/s1/images/0", origin)).toEqual({
			kind: "allowed",
			src: "/api/v1/sessions/s1/images/0",
		});
		expect(classifyImageSrc("./shot.png", origin)).toEqual({ kind: "allowed", src: "./shot.png" });
		expect(classifyImageSrc("../shot.png", origin)).toEqual({ kind: "allowed", src: "../shot.png" });
		expect(classifyImageSrc("images/shot.png?v=1:2", origin)).toEqual({ kind: "allowed", src: "images/shot.png?v=1:2" });
		expect(classifyImageSrc("https://pika.example/api/v1/sessions/s1/images/0", origin)).toEqual({
			kind: "allowed",
			src: "https://pika.example/api/v1/sessions/s1/images/0",
		});
		expect(classifyImageSrc("//pika.example/api/v1/sessions/s1/images/0", origin)).toEqual({
			kind: "allowed",
			src: "//pika.example/api/v1/sessions/s1/images/0",
		});
		expect(classifyImageSrc(`data:image/png;base64,${PNG_B64}`, origin)).toEqual({
			kind: "allowed",
			src: `data:image/png;base64,${PNG_B64}`,
		});

		expect(classifyImageSrc("https://tracker.example/pixel.png", origin)).toEqual({
			kind: "external",
			href: "https://tracker.example/pixel.png",
		});
		expect(classifyImageSrc("http://pika.example/api/img.png", origin)).toEqual({
			kind: "external",
			href: "http://pika.example/api/img.png",
		});
		expect(classifyImageSrc("https://pika.example:8443/api/img.png", origin)).toEqual({
			kind: "external",
			href: "https://pika.example:8443/api/img.png",
		});
		expect(classifyImageSrc("//tracker.example/p.png", origin)).toEqual({
			kind: "external",
			href: "https://tracker.example/p.png",
		});

		for (const bad of [
			"",
			"   ",
			`data:image/svg+xml;base64,${SVG_B64}`,
			"data:image/svg+xml,<svg/>",
			`data:text/html;base64,${HTML_B64}`,
			"data:image/png,",
			"data:image/png",
			"javascript:alert(1)",
			"JAVASCRIPT:alert(1)",
			"vbscript:msgbox(1)",
			"file:///etc/passwd",
			"blob:https://pika.example/uuid",
			"java\tscript:alert(1)",
			"https://pika.example/\nfoo",
			"/\\tracker.example/p.png",
			"\\\\tracker.example/p.png",
			"http:relative.png",
		]) {
			expect(classifyImageSrc(bad, origin).kind, `expected blocked for ${JSON.stringify(bad)}`).toBe("blocked");
		}
	});

	it("classifies inline image content blocks consistently", () => {
		expect(classifyImageContent({ mimeType: "image/png", data: PNG_B64 })).toEqual({
			kind: "allowed",
			src: `data:image/png;base64,${PNG_B64}`,
		});
		expect(classifyImageContent({ mimeType: "image/svg+xml", data: SVG_B64 }).kind).toBe("blocked");
		expect(
			classifyImageContent({ mimeType: "image/svg+xml", data: "", src: "/api/v1/sessions/s1/entries/1/image/0" }).kind,
		).toBe("blocked");
		expect(
			classifyImageContent({ mimeType: "image/png", data: "", src: "https://tracker.example/pixel.png" }, "https://pika.example"),
		).toEqual({
			kind: "external",
			href: "https://tracker.example/pixel.png",
		});
	});
});

describe("Markdown image hardening", () => {
	it("renders same-origin relative images with referrerPolicy=no-referrer", () => {
		const { container } = render(<Markdown text={'![Screenshot](/api/v1/sessions/s1/images/0 "Build result")'} />);
		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("/api/v1/sessions/s1/images/0");
		expect(img?.getAttribute("alt")).toBe("Screenshot");
		expect(img?.getAttribute("title")).toBe("Build result");
		expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(img?.getAttribute("loading")).toBe("lazy");
	});

	it("renders same-origin absolute URLs with referrerPolicy=no-referrer", () => {
		const sameOriginUrl = `${window.location.origin}/api/v1/sessions/s1/images/0`;
		const { container } = render(<Markdown text={`![Same origin](${sameOriginUrl})`} />);
		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe(sameOriginUrl);
		expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
	});

	it("blocks external http(s) and protocol-relative images and renders a safe fallback link", () => {
		const { container } = render(
			<Markdown
				text={[
					"![Tracking pixel](https://tracker.example/pixel.png)",
					"",
					"![](//tracker.example/p.png)",
				].join("\n")}
			/>,
		);
		expect(container.querySelectorAll("img")).toHaveLength(0);
		const links = [...container.querySelectorAll<HTMLAnchorElement>("a[data-blocked-external-image]")];
		expect(links).toHaveLength(2);

		expect(links[0].getAttribute("href")).toBe("https://tracker.example/pixel.png");
		expect(links[0].getAttribute("target")).toBe("_blank");
		expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
		expect(links[0].textContent).toContain("Tracking pixel");

		expect(links[1].getAttribute("href")).toMatch(/^https?:\/\/tracker\.example\/p\.png$/);
		expect(links[1].getAttribute("target")).toBe("_blank");
		expect(links[1].getAttribute("rel")).toBe("noopener noreferrer");
		expect(links[1].textContent).toContain("tracker.example/p.png");
	});

	it("allows raster data:image/png URLs and blocks data:image/svg+xml, data:text/html, javascript:, and file: URLs", () => {
		const { container } = render(
			<Markdown
				text={[
					`![PNG](data:image/png;base64,${PNG_B64})`,
					"",
					`![SVG](data:image/svg+xml;base64,${SVG_B64})`,
					"",
					`![HTML](data:text/html;base64,${HTML_B64})`,
					"",
					"![XSS](javascript:alert(1))",
					"",
					"![Local](file:///etc/passwd)",
				].join("\n")}
			/>,
		);

		const imgs = [...container.querySelectorAll("img")];
		expect(imgs).toHaveLength(1);
		expect(imgs[0].getAttribute("src")).toBe(`data:image/png;base64,${PNG_B64}`);
		expect(imgs[0].getAttribute("alt")).toBe("PNG");
		expect(imgs[0].getAttribute("referrerpolicy")).toBe("no-referrer");

		expect(container.querySelectorAll("a")).toHaveLength(0);
		const blocked = [...container.querySelectorAll("[data-blocked-image]")];
		expect(blocked).toHaveLength(4);
		expect(blocked.map((el) => el.textContent)).toEqual([
			"[Blocked image: SVG]",
			"[Blocked image: HTML]",
			"[Blocked image: XSS]",
			"[Blocked image: Local]",
		]);
	});
});

describe("TimelineItemView inline image hardening", () => {
	function renderUserImages(images: ImageContent[]) {
		const raw = userMessage("attached");
		return renderInSession(
			<TimelineItemView
				item={{
					kind: "user",
					key: "1",
					seq: 1,
					entry: entry(1, raw),
					content: [{ type: "text", text: "attached" }, ...images],
				}}
			/>,
		);
	}

	it("renders allowlisted raster base64 and same-origin src images with referrerPolicy=no-referrer", () => {
		const { container } = renderUserImages([
			{ type: "image", mimeType: "image/png", data: PNG_B64 },
			{ type: "image", mimeType: "image/webp", data: "", src: "/api/v1/sessions/s1/entries/1/image/1" },
		]);
		const imgs = [...container.querySelectorAll("img")];
		expect(imgs).toHaveLength(2);
		expect(imgs[0].getAttribute("src")).toBe(`data:image/png;base64,${PNG_B64}`);
		expect(imgs[0].getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(imgs[1].getAttribute("src")).toBe("/api/v1/sessions/s1/entries/1/image/1");
		expect(imgs[1].getAttribute("referrerpolicy")).toBe("no-referrer");
	});

	it("blocks image/svg+xml, text/html, and untrusted external src images", () => {
		const { container } = renderUserImages([
			{ type: "image", mimeType: "image/svg+xml", data: SVG_B64 },
			{ type: "image", mimeType: "text/html", data: HTML_B64 },
			{ type: "image", mimeType: "image/svg+xml", data: "", src: "/api/v1/sessions/s1/entries/1/image/2" },
			{ type: "image", mimeType: "image/png", data: "", src: "https://tracker.example/pixel.png" },
		]);
		expect(container.querySelectorAll("img")).toHaveLength(0);

		const blocked = [...container.querySelectorAll("[data-blocked-image]")];
		expect(blocked).toHaveLength(3);
		expect(blocked[0].textContent).toContain("image/svg+xml");
		expect(blocked[1].textContent).toContain("text/html");
		expect(blocked[2].textContent).toContain("image/svg+xml");

		const externalLinks = [...container.querySelectorAll<HTMLAnchorElement>("a[data-blocked-external-image]")];
		expect(externalLinks).toHaveLength(1);
		expect(externalLinks[0].getAttribute("href")).toBe("https://tracker.example/pixel.png");
		expect(externalLinks[0].getAttribute("rel")).toBe("noopener noreferrer");
	});
});

describe("tools/shared ResultImages hardening", () => {
	function makeResult(images: ImageContent[]): ToolResultMessage {
		return toolResultMessage("call_img", "read", "ok", { images }).message as ToolResultMessage;
	}

	it("renders allowlisted raster base64 and same-origin src images with referrerPolicy=no-referrer", () => {
		const { container } = render(
			<ResultImages
				result={makeResult([
					{ type: "image", mimeType: "image/jpeg", data: PNG_B64 },
					{ type: "image", mimeType: "image/avif", data: PNG_B64 },
					{ type: "image", mimeType: "image/png", data: "", src: "/api/v1/sessions/s1/entries/2/image/2" },
				])}
			/>,
		);
		const imgs = [...container.querySelectorAll("img")];
		expect(imgs).toHaveLength(3);
		expect(imgs[0].getAttribute("src")).toBe(`data:image/jpeg;base64,${PNG_B64}`);
		expect(imgs[1].getAttribute("src")).toBe(`data:image/avif;base64,${PNG_B64}`);
		expect(imgs[2].getAttribute("src")).toBe("/api/v1/sessions/s1/entries/2/image/2");
		for (const img of imgs) {
			expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
		}
	});

	it("blocks image/svg+xml, text/html, javascript: src, backslash smuggling, and external src images", () => {
		const { container } = render(
			<ResultImages
				result={makeResult([
					{ type: "image", mimeType: "image/svg+xml", data: SVG_B64 },
					{ type: "image", mimeType: "text/html", data: HTML_B64 },
					{ type: "image", mimeType: "image/png", data: "", src: "javascript:alert(1)" },
					{ type: "image", mimeType: "image/png", data: "", src: "/\\tracker.example/tool.png" },
					{ type: "image", mimeType: "image/png", data: "", src: "https://tracker.example/tool.png" },
				])}
			/>,
		);
		expect(container.querySelectorAll("img")).toHaveLength(0);

		const blocked = [...container.querySelectorAll("[data-blocked-image]")];
		expect(blocked).toHaveLength(4);
		expect(blocked[0].textContent).toContain("image/svg+xml");
		expect(blocked[1].textContent).toContain("text/html");

		const externalLinks = [...container.querySelectorAll<HTMLAnchorElement>("a[data-blocked-external-image]")];
		expect(externalLinks).toHaveLength(1);
		expect(externalLinks[0].getAttribute("href")).toBe("https://tracker.example/tool.png");
		expect(externalLinks[0].getAttribute("rel")).toBe("noopener noreferrer");
	});
});
