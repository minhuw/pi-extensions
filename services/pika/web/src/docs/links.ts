import type { DocPage } from "./types";

const repository = "https://github.com/minhuw/pi-extensions";
const rawRepository = "https://raw.githubusercontent.com/minhuw/pi-extensions/master";

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export function sourceHref(source: string): string {
	return `${repository}/blob/master/${encodePath(source)}`;
}

function external(href: string, image = false): string | undefined {
	// Reject control characters and backslashes before browser URL normalization.
	if (/[\u0000-\u001f\u007f\\]/.test(href)) return "";
	if (/^https?:\/\//i.test(href)) return href;
	if (!image && /^mailto:/i.test(href)) return href;
	if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return "";
	return undefined;
}

function repositoryTarget(href: string, source: string): { path: string; suffix: string; directory: boolean } | undefined {
	const boundary = href.search(/[?#]/);
	const pathname = boundary < 0 ? href : href.slice(0, boundary);
	const suffix = boundary < 0 ? "" : href.slice(boundary);
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}
	if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return undefined;
	const segments = decoded.startsWith("/") ? [] : source.split("/").slice(0, -1);
	for (const segment of decoded.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (!segments.length) return undefined;
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return { path: segments.join("/"), suffix, directory: /(?:\/|^|\/)\.{0,2}$/.test(decoded) };
}

/** Router destinations deliberately omit the deployment's basename. */
export function resolveDocHref(href: string, source: string, pages: DocPage[]): string {
	const value = href.trim();
	const absolute = external(value);
	if (absolute !== undefined) return absolute;
	if (value.startsWith("#")) return value;
	if (!value || value.startsWith("?")) {
		const current = pages.find((page) => page.source === source);
		return current ? `/docs/${current.slug}${value}` : `${sourceHref(source)}${value}`;
	}
	const target = repositoryTarget(value, source);
	if (!target) return "";
	const page = pages.find((candidate) => candidate.source === target.path
		|| candidate.source === `${target.path ? `${target.path}/` : ""}README.md`);
	if (page) return `/docs/${page.slug}${target.suffix}`;
	return `${repository}/${target.directory ? "tree" : "blob"}/master/${encodePath(target.path)}${target.suffix}`;
}

export function resolveDocImage(src: string, source: string): string {
	const value = src.trim();
	const absolute = external(value, true);
	if (absolute !== undefined) return absolute;
	if (!value || value.startsWith("#") || value.startsWith("?")) return "";
	const target = repositoryTarget(value, source);
	return target ? `${rawRepository}/${encodePath(target.path)}${target.suffix}` : "";
}
