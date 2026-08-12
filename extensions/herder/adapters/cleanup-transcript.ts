import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

export const HERDER_CLEANUP_ENTRY = "herder-cleanup-v1";

const MAX_ITEMS = 32;
const MAX_ITEM_LENGTH = 64;

export type CleanupTranscriptMode = "standard" | "include-failed" | "deep";
export type CleanupTranscriptPreview = "eligible" | "preview-only" | "blocked" | "cancelled";
export type CleanupTranscriptIntegration = "preserved" | "removed" | "blocked" | "unknown";

export interface CleanupTranscriptEntry {
	version: 1;
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

function boundedHandoffTarget(value: string | null | undefined): string | null {
	if (!value) return null;
	const target = String(value).trim();
	if (target.length > MAX_ITEM_LENGTH || /[\\/]/.test(target) || /^[0-9a-f]{7,64}$/i.test(target)) return null;
	return /^[a-z0-9][a-z0-9._-]*$/i.test(target) ? target : null;
}

export function createCleanupTranscriptEntry(input: {
	mode: CleanupTranscriptMode;
	deep?: boolean;
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
		version: 1,
		mode: input.mode,
		deep: Boolean(input.deep),
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
	const state = entry.executed ? theme.fg("success", "executed") : theme.fg("warning", entry.preview);
	if (!entry.deep) {
		return [
			theme.bold("Herder cleanup"),
			theme.fg("dim", `  ${entry.mode} · ${state}`),
			`  removed: ${renderList(entry.removed)}`,
			`  skipped: ${renderList(entry.skipped)}`,
			`  blockers: ${renderList(entry.blockers)}`,
		].join("\n");
	}
	return [
		theme.bold("Herder cleanup"),
		theme.fg("dim", `  deep · ${state}`),
		`  planned refs: ${renderList(entry.plannedRefs)}`,
		`  removed refs: ${renderList(entry.removedRefs)}`,
		`  integration: ${entry.integration}`,
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
