import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

export const HERDER_CLEANUP_ENTRY = "herder-cleanup-v2";

const MAX_ITEMS = 32;
const MAX_ITEM_LENGTH = 64;

export type CleanupTranscriptMode = "standard" | "include-failed" | "deep" | "force";
export type CleanupTranscriptPreview = "eligible" | "preview-only" | "blocked" | "cancelled";
export type CleanupTranscriptIntegration = "preserved" | "removed" | "blocked" | "unknown";

export interface CleanupTranscriptEntry {
	version: 2;
	mode: CleanupTranscriptMode;
	deep: boolean;
	preview: CleanupTranscriptPreview;
	executed: boolean;
	plannedRefs: string[];
	removedRefs: string[];
	integration: CleanupTranscriptIntegration;
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
	plannedRefs?: readonly string[];
	removedRefs?: readonly string[];
	integration?: CleanupTranscriptIntegration;
	removed?: readonly string[];
	skipped?: readonly string[];
	blockers?: readonly string[];
}): CleanupTranscriptEntry {
	return {
		version: 2,
		mode: input.mode,
		deep: input.mode === "deep",
		preview: input.preview,
		executed: Boolean(input.executed),
		plannedRefs: boundedItems(input.plannedRefs),
		removedRefs: boundedItems(input.removedRefs),
		integration: input.integration ?? "unknown",
		removed: boundedItems(input.removed),
		skipped: boundedItems(input.skipped),
		blockers: boundedItems(input.blockers),
	};
}

function renderList(values: readonly string[]): string {
	return values.length ? values.join(", ") : "none";
}

export function cleanupTranscriptDisplay(entry: CleanupTranscriptEntry, theme: Theme): string {
	const force = entry.mode === "force";
	const deep = entry.deep;
	const state = entry.executed ? theme.fg("success", "executed") : theme.fg("warning", entry.preview);
	if (!deep && !force) {
		return [
			theme.bold("Herder cleanup"),
			theme.fg("dim", `  ${entry.mode} · ${state}`),
			`  removed: ${renderList(entry.removed)}`,
			`  skipped: ${renderList(entry.skipped)}`,
			`  blockers: ${renderList(entry.blockers)}`,
		].join("\n");
	}
	const label = force ? "force" : "deep";
	return [
		theme.bold("Herder cleanup"),
		theme.fg("dim", `  ${label} · ${state}`),
		`  planned refs: ${renderList(entry.plannedRefs)}`,
		`  removed refs: ${renderList(entry.removedRefs)}`,
		`  integration: ${entry.integration}`,
		`  removed: ${renderList(entry.removed)}`,
		`  skipped: ${renderList(entry.skipped)}`,
		`  blockers: ${renderList(entry.blockers)}`,
	].join("\n");
}

function renderer(entry: { data?: CleanupTranscriptEntry }, theme: Theme) {
	const data = entry.data;
	if (!data) return new Text(theme.fg("warning", "Herder cleanup entry unavailable"), 0, 0);
	const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
	box.addChild(new Text(cleanupTranscriptDisplay(data, theme), 0, 0));
	return box;
}

export function registerCleanupTranscriptRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<CleanupTranscriptEntry>(HERDER_CLEANUP_ENTRY, (entry, _options, theme) => renderer(entry, theme));
}
