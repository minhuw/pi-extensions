import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

export const HERDER_CLEANUP_ENTRY = "herder-cleanup-v1";

const MAX_ITEMS = 32;
const MAX_ITEM_LENGTH = 64;

export type CleanupTranscriptMode = "standard" | "include-failed";
export type CleanupTranscriptPreview = "eligible" | "preview-only" | "blocked" | "cancelled";

export interface CleanupTranscriptEntry {
	version: 1;
	mode: CleanupTranscriptMode;
	preview: CleanupTranscriptPreview;
	executed: boolean;
	removed: string[];
	skipped: string[];
	blockers: string[];
}

function boundedItems(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? [])
		.map((value) => String(value).trim())
		.filter((value) => /^[a-z0-9][a-z0-9-]{0,48}(?::[a-z0-9-]{1,32})?$/i.test(value))
		.map((value) => value.slice(0, MAX_ITEM_LENGTH)))]
		.slice(0, MAX_ITEMS);
}

export function createCleanupTranscriptEntry(input: {
	mode: CleanupTranscriptMode;
	preview: CleanupTranscriptPreview;
	executed: boolean;
	removed?: readonly string[];
	skipped?: readonly string[];
	blockers?: readonly string[];
}): CleanupTranscriptEntry {
	return {
		version: 1,
		mode: input.mode,
		preview: input.preview,
		executed: Boolean(input.executed),
		removed: boundedItems(input.removed),
		skipped: boundedItems(input.skipped),
		blockers: boundedItems(input.blockers),
	};
}

function renderList(values: readonly string[]): string {
	return values.length ? values.join(", ") : "none";
}

export function cleanupTranscriptDisplay(entry: CleanupTranscriptEntry, theme: Theme): string {
	const state = entry.executed ? theme.fg("success", "executed") : theme.fg("warning", entry.preview);
	return [
		theme.bold("Herder cleanup"),
		theme.fg("dim", `  ${entry.mode} · ${state}`),
		`  removed: ${renderList(entry.removed)}`,
		`  skipped: ${renderList(entry.skipped)}`,
		`  blockers: ${renderList(entry.blockers)}`,
	].join("\n");
}

export function registerCleanupTranscriptRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<CleanupTranscriptEntry>(HERDER_CLEANUP_ENTRY, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return new Text(theme.fg("warning", "Herder cleanup entry unavailable"), 0, 0);
		const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
		box.addChild(new Text(cleanupTranscriptDisplay(data, theme), 0, 0));
		return box;
	});
}
