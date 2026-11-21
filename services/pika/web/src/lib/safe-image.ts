export const SAFE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/x-icon",
	"image/vnd.microsoft.icon",
]);

export type ImageSrcClassification =
	| { kind: "allowed"; src: string }
	| { kind: "external"; href: string }
	| { kind: "blocked"; reason: string };

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HTTP_SCHEME_RE = /^https?:/i;
const HTTP_ORIGIN_RE = /^https?:\/\//i;
const DATA_SCHEME_RE = /^data:/i;
const SENTINEL_ORIGIN = "https://same-origin.invalid";

export function normalizeImageMimeType(mimeType: string | undefined): string | null {
	if (typeof mimeType !== "string") return null;
	const semi = mimeType.indexOf(";");
	const base = (semi === -1 ? mimeType : mimeType.slice(0, semi)).trim().toLowerCase();
	return SAFE_IMAGE_MIME_TYPES.has(base) ? base : null;
}

export function safeDataImageSrc(mimeType: string | undefined, data: string): string | null {
	const safeMime = normalizeImageMimeType(mimeType);
	if (!safeMime || typeof data !== "string") return null;
	const trimmed = data.trim();
	if (!trimmed) return null;
	return `data:${safeMime};base64,${trimmed}`;
}

function resolveBaseOrigin(baseOrigin?: string): string | null {
	const candidate = baseOrigin ?? (typeof window !== "undefined" ? window.location.origin : undefined);
	if (!candidate || candidate === "null") return null;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

export function classifyImageSrc(src: string | undefined, baseOrigin?: string): ImageSrcClassification {
	if (typeof src !== "string") return { kind: "blocked", reason: "empty" };
	const trimmed = src.trim();
	if (!trimmed) return { kind: "blocked", reason: "empty" };
	if (CONTROL_CHAR_RE.test(trimmed)) return { kind: "blocked", reason: "control-chars" };

	if (DATA_SCHEME_RE.test(trimmed)) {
		const comma = trimmed.indexOf(",");
		if (comma === -1) return { kind: "blocked", reason: "invalid-data-url" };
		const meta = trimmed.slice(5, comma);
		if (!normalizeImageMimeType(meta)) return { kind: "blocked", reason: "disallowed-mime" };
		if (trimmed.slice(comma + 1).trim().length === 0) return { kind: "blocked", reason: "empty-data-url" };
		return { kind: "allowed", src: trimmed };
	}

	const effectiveOrigin = resolveBaseOrigin(baseOrigin);

	if (trimmed.startsWith("//")) {
		try {
			const resolved = new URL(trimmed, effectiveOrigin ?? SENTINEL_ORIGIN);
			if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
				return { kind: "blocked", reason: "disallowed-scheme" };
			}
			if (effectiveOrigin && resolved.origin === effectiveOrigin) {
				return { kind: "allowed", src: trimmed };
			}
			if (!effectiveOrigin && resolved.origin === SENTINEL_ORIGIN) {
				return { kind: "blocked", reason: "invalid-url" };
			}
			return { kind: "external", href: resolved.href };
		} catch {
			return { kind: "blocked", reason: "invalid-url" };
		}
	}

	if (HTTP_SCHEME_RE.test(trimmed)) {
		if (!HTTP_ORIGIN_RE.test(trimmed)) return { kind: "blocked", reason: "invalid-url" };
		try {
			const resolved = new URL(trimmed);
			if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
				return { kind: "blocked", reason: "disallowed-scheme" };
			}
			if (effectiveOrigin && resolved.origin === effectiveOrigin) {
				return { kind: "allowed", src: trimmed };
			}
			return { kind: "external", href: resolved.href };
		} catch {
			return { kind: "blocked", reason: "invalid-url" };
		}
	}

	if (SCHEME_RE.test(trimmed)) {
		return { kind: "blocked", reason: "disallowed-scheme" };
	}

	// Relative path (e.g. `/api/...`, `./img.png`, `../img.png`, `images/a.png`).
	// Resolve against a base origin to catch backslash authority smuggling like `/\evil.example/x.png`.
	const base = effectiveOrigin ?? SENTINEL_ORIGIN;
	try {
		const resolved = new URL(trimmed, base);
		if (resolved.origin !== base) {
			return { kind: "blocked", reason: "invalid-relative-url" };
		}
		return { kind: "allowed", src: trimmed };
	} catch {
		return { kind: "blocked", reason: "invalid-url" };
	}
}

export function classifyImageContent(
	image: { src?: string; data?: string; mimeType?: string },
	baseOrigin?: string,
): ImageSrcClassification {
	const hasMime = typeof image.mimeType === "string" && image.mimeType.trim().length > 0;
	if (hasMime && !normalizeImageMimeType(image.mimeType)) {
		return { kind: "blocked", reason: "disallowed-mime" };
	}
	if (typeof image.src === "string" && image.src.trim().length > 0) {
		return classifyImageSrc(image.src, baseOrigin);
	}
	if (typeof image.data === "string" && image.data.trim().length > 0) {
		const dataSrc = safeDataImageSrc(image.mimeType, image.data);
		return dataSrc ? { kind: "allowed", src: dataSrc } : { kind: "blocked", reason: "disallowed-mime" };
	}
	return { kind: "blocked", reason: "empty" };
}
