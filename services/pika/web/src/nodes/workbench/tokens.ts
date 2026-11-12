import type { Theme } from "../../lib/theme";

/**
 * The Workbench design system's name, in one place (`services/pika/DESIGN.workbench.md`). Its CSS lives in
 * `workbench.css` under `[data-workbench]` with the `--wb-` prefix.
 */
export const WORKBENCH = "Workbench";

/** The root element's attribute: everything inside it takes the Workbench tokens. */
export const WORKBENCH_ROOT = { "data-workbench": "" } as const;

/**
 * The tokens the terminal and Monaco take as literals, as `workbench.css` sets them (a test compares the two). Only
 * what a canvas or a Monaco theme needs is here; the page reads the CSS.
 */
export const WB_TOKENS = {
	light: { ground: "#fcfcfd", chrome: "#f1f3f5", line: "#dde1e6", ink: "#161a1f", ink2: "#4f5863", accent: "#5a46c8" },
	dark: { ground: "#111417", chrome: "#171a1e", line: "#262b31", ink: "#e4e7eb", ink2: "#a6aeb8", accent: "#a596ff" },
} as const satisfies Record<Theme, Record<string, string>>;

/** `hex` over `base` at `alpha`, as `#rrggbb`: the terminal's search decorations accept no transparency. */
export function blend(hex: string, base: string, alpha: number): string {
	const channel = (value: string, at: number) => parseInt(value.slice(at, at + 2), 16);
	return `#${[1, 3, 5]
		.map((at) => Math.round(channel(hex, at) * alpha + channel(base, at) * (1 - alpha)))
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")}`;
}
