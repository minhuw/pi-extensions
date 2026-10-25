import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "pika-theme";

function storedTheme(): Theme | null {
	try {
		const value = localStorage.getItem(THEME_STORAGE_KEY);
		return value === "light" || value === "dark" ? value : null;
	} catch {
		return null;
	}
}

function systemTheme(): Theme {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function initialTheme(): Theme {
	return storedTheme() ?? systemTheme();
}

/** Applies the theme to `<html data-theme>`; follows the system until the user picks one. */
export function useTheme(): { theme: Theme; toggle: () => void } {
	const [theme, setTheme] = useState<Theme>(initialTheme);

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);

	useEffect(() => {
		if (storedTheme() || typeof window.matchMedia !== "function") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			if (!storedTheme()) setTheme(media.matches ? "dark" : "light");
		};
		media.addEventListener?.("change", onChange);
		return () => media.removeEventListener?.("change", onChange);
	}, []);

	const toggle = useCallback(() => {
		setTheme((current) => {
			const next: Theme = current === "dark" ? "light" : "dark";
			try {
				localStorage.setItem(THEME_STORAGE_KEY, next);
			} catch {
				// Storage can be unavailable in private windows; the toggle still applies.
			}
			return next;
		});
	}, []);

	return { theme, toggle };
}
