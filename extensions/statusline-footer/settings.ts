import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type FooterMode = "full" | "compact" | "off";

export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

function isFooterMode(value: unknown): value is FooterMode {
	return value === "full" || value === "compact" || value === "off";
}

export function footerSettingsPath(): string {
	return path.join(getAgentDir(), "statusline-footer.json");
}

export function loadFooterMode(): FooterMode {
	try {
		const parsed = JSON.parse(readFileSync(footerSettingsPath(), "utf8")) as { mode?: unknown } | null;
		if (parsed && typeof parsed === "object" && isFooterMode(parsed.mode)) {
			return parsed.mode;
		}
	} catch {
		// Missing file, invalid JSON, or unreadable path: fall back to default.
	}
	return "full";
}

export async function saveFooterMode(mode: FooterMode): Promise<void> {
	const filePath = footerSettingsPath();
	const temporary = `${filePath}.${randomUUID()}.tmp`;
	await mkdir(path.dirname(filePath), { recursive: true });
	try {
		await writeFile(temporary, `${JSON.stringify({ mode })}\n`, { flag: "wx", mode: 0o600 });
		await rename(temporary, filePath);
	} finally {
		await rm(temporary, { force: true });
	}
}

interface CompactionSettings {
	enabled?: boolean;
	reserveTokens?: number;
	modelOverrides?: Record<string, { reserveTokens?: number }>;
}

export function compactionThresholdPct(pi: ExtensionAPI, ctx: ExtensionContext): number | undefined {
	const model = ctx.model;
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? model?.contextWindow;
	if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return undefined;
	}

	let settings: unknown;
	try {
		settings = (pi as { getSettings?: () => unknown }).getSettings?.();
	} catch {
		settings = undefined;
	}

	const compaction = (settings as Record<string, unknown> | undefined)?.compaction as
		| CompactionSettings
		| undefined;

	if (compaction?.enabled === false) {
		return undefined;
	}

	const modelKey = model ? `${model.provider}/${model.id}` : undefined;
	const override = modelKey ? compaction?.modelOverrides?.[modelKey]?.reserveTokens : undefined;
	const reserve =
		typeof override === "number" && Number.isFinite(override) && override > 0
			? override
			: typeof compaction?.reserveTokens === "number"
					&& Number.isFinite(compaction.reserveTokens)
					&& compaction.reserveTokens > 0
				? compaction.reserveTokens
				: DEFAULT_COMPACTION_RESERVE_TOKENS;

	if (reserve >= contextWindow) {
		return undefined;
	}

	return ((contextWindow - reserve) / contextWindow) * 100;
}
