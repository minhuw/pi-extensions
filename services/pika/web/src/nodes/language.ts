import { baseName } from "./files";

/** A language as Monaco's registry lists it (`monaco.languages.getLanguages()`). */
export interface LanguageInfo {
	id: string;
	extensions?: string[];
	filenames?: string[];
}

/**
 * The language for a path: an exact file name first (`Dockerfile`), then the longest matching extension, so
 * `.d.ts` beats `.ts`; `plaintext` otherwise. Case-insensitive, like the extensions Monaco registers.
 */
export function languageFor(path: string, languages: readonly LanguageInfo[]): string {
	const name = baseName(path).toLowerCase();
	for (const language of languages) if (language.filenames?.some((file) => file.toLowerCase() === name)) return language.id;
	let best: { length: number; id: string } | undefined;
	for (const language of languages) {
		for (const extension of language.extensions ?? []) {
			const lower = extension.toLowerCase();
			if (name.endsWith(lower) && name.length > lower.length && (!best || lower.length > best.length)) best = { length: lower.length, id: language.id };
		}
	}
	return best?.id ?? "plaintext";
}
