/** Read an exact model name without interpreting gateway routing prefixes. */
export function magpieModelName(id: string): string | undefined {
	if (!id || /[\s\p{Cc}*?\[\]{}]/u.test(id)) return undefined;
	const segments = id.split("/");
	return segments.every(segment => segment.length > 0) ? segments[segments.length - 1] : undefined;
}
