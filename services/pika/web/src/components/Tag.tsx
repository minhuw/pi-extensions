import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

/** Notion's select colors, light and dark. */
const COLORS = {
	gray: "bg-[#e3e2e0] text-[#32302c] dark:bg-[#5a5a5a] dark:text-white/85",
	brown: "bg-[#eee0da] text-[#442a1e] dark:bg-[#603b2c] dark:text-white/85",
	orange: "bg-[#fadec9] text-[#49290e] dark:bg-[#854c1d] dark:text-white/85",
	yellow: "bg-[#fdecc8] text-[#402c1b] dark:bg-[#89632a] dark:text-white/85",
	green: "bg-[#dbeddb] text-[#1c3829] dark:bg-[#2b593f] dark:text-white/85",
	blue: "bg-[#d3e5ef] text-[#183347] dark:bg-[#28456c] dark:text-white/85",
	purple: "bg-[#e8deee] text-[#412454] dark:bg-[#492f64] dark:text-white/85",
	pink: "bg-[#f5e0e9] text-[#4c2337] dark:bg-[#69314c] dark:text-white/85",
	red: "bg-[#ffe2dd] text-[#5d1715] dark:bg-[#6e3630] dark:text-white/85",
} as const;

export type TagColor = keyof typeof COLORS;

export function tagColorClasses(color: TagColor): string {
	return COLORS[color];
}

// Red is left out: it reads as an error.
const HASHED: TagColor[] = ["blue", "green", "purple", "orange", "pink", "brown", "yellow"];

/** The same color for the same name every time, as Notion gives each select option its own. */
export function colorOf(name: string): TagColor {
	let hash = 0;
	for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
	return HASHED[hash % HASHED.length];
}

/** A model's vendor color: Anthropic orange, OpenAI green, Google blue, DeepSeek purple. */
export function modelColor(model: string): TagColor {
	const name = model.toLowerCase();
	if (name.includes("claude")) return "orange";
	if (/^(gpt|o\d|codex|chatgpt)/.test(name)) return "green";
	if (name.includes("gemini")) return "blue";
	if (name.includes("deepseek")) return "purple";
	if (/qwen|kimi|glm|moonshot/.test(name)) return "pink";
	return "gray";
}

/** A Notion-style select tag. */
export function Tag({ color = "gray", icon, title, mono, children }: { color?: TagColor; icon?: IconName; title?: string; mono?: boolean; children: ReactNode }) {
	return (
		<span
			className={cx(
				"inline-flex h-5 max-w-[240px] shrink-0 items-center gap-1 rounded-[4px] px-1.5 leading-none whitespace-nowrap",
				mono ? "mono text-[11px]" : "text-[11.5px]",
				COLORS[color],
			)}
			title={title}
		>
			{icon && <Icon name={icon} size={11} className="shrink-0 opacity-70" />}
			<span className="truncate">{children}</span>
		</span>
	);
}
