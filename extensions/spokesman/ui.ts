import type { Usage } from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	type CustomEntry,
	type EntryRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	MouseRegion,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { SpokesmanMode } from "./filter.ts";

export interface SpokesmanRewriteData {
	targetEntryId?: string;
	originalText: string;
	rewrittenText: string;
	originalModel: string;
	spokesmanModel: string;
	spokesmanProvider: string;
	mode: SpokesmanMode;
	signals: string[];
	usage?: Usage;
	provider?: string;
	durationMs?: number;
	timestamp: number;
}

export function hasNerdFonts(): boolean {
	return (process.env.STATUSLINE_NERD_FONTS ?? process.env.FOOTER_NERD_FONTS) !== "0";
}

export function formatSpokesmanSeparator(
	theme: Theme,
	spokesmanModel: string,
	nerdFonts = hasNerdFonts(),
	width = 72,
): string {
	const targetWidth = Math.max(1, width);
	const ruleTarget = Math.max(24, targetWidth);
	const icon = nerdFonts ? "\u{F05CB} " : "";
	const prefix = theme.fg("borderMuted", "─── ");
	const label = `${theme.fg("accent", `${icon}Spokesman`)}${theme.fg("dim", " · ")}${theme.fg("muted", spokesmanModel)}`;
	const head = `${prefix}${label}`;
	const headWidth = visibleWidth(head);
	const remaining = Math.max(0, ruleTarget - headWidth - 1);
	const tail = remaining > 0 ? ` ${theme.fg("borderMuted", "─".repeat(remaining))}` : "";
	return truncateToWidth(`${head}${tail}`, targetWidth);
}

function buildMarkdownTheme(theme: Theme): MarkdownTheme {
	const bold = (text: string) => (typeof theme.bold === "function" ? theme.bold(text) : text);
	const italic = (text: string) => (typeof theme.italic === "function" ? theme.italic(text) : text);
	const underline = (text: string) =>
		typeof theme.underline === "function" ? theme.underline(text) : text;
	const strikethrough = (text: string) =>
		typeof theme.strikethrough === "function" ? theme.strikethrough(text) : text;

	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold,
		italic,
		underline,
		strikethrough,
		highlightCode: (code, lang) => {
			try {
				const globalMdTheme = getMarkdownTheme();
				if (globalMdTheme.highlightCode) {
					return globalMdTheme.highlightCode(code, lang);
				}
			} catch {}
			return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
		},
	};
}

class SpokesmanSeparatorLine implements Component {
	private readonly theme: Theme;
	private readonly spokesmanModel: string;
	private readonly outputPad: number;

	constructor(theme: Theme, spokesmanModel: string, outputPad: number) {
		this.theme = theme;
		this.spokesmanModel = spokesmanModel;
		this.outputPad = outputPad;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const pad = " ".repeat(Math.max(0, this.outputPad));
		const innerWidth = Math.max(1, safeWidth - this.outputPad * 2);
		const line = formatSpokesmanSeparator(
			this.theme,
			this.spokesmanModel,
			hasNerdFonts(),
			innerWidth,
		);
		return [truncateToWidth(`${pad}${line}`, safeWidth)];
	}
}

export function createSpokesmanEntryRenderer(
	outputPad = 1,
	isSuperseded?: (entryId: string) => boolean,
) {
	const expandedOverrides = new Map<string, boolean>();
	const lastOptionsExpanded = new Map<string, boolean>();

	return (
		entry: CustomEntry<SpokesmanRewriteData>,
		options: EntryRenderOptions,
		theme: Theme,
	): Component | undefined => {
		const data = entry.data;
		if (!data || typeof data.rewrittenText !== "string" || isSuperseded?.(entry.id)) {
			return undefined;
		}
		const rewriteData: SpokesmanRewriteData = data;

		if (lastOptionsExpanded.get(entry.id) !== options.expanded) {
			lastOptionsExpanded.set(entry.id, options.expanded);
			expandedOverrides.delete(entry.id);
		}

		const mdTheme = buildMarkdownTheme(theme);
		const italicText = (text: string) =>
			typeof theme.italic === "function" ? theme.italic(text) : text;

		class SpokesmanEntryCard extends Container {
			constructor() {
				super();
				this.rebuild();
			}

			override invalidate(): void {
				super.invalidate();
				this.rebuild();
			}

			rebuild(): void {
				this.clear();
				if (isSuperseded?.(entry.id)) {
					return;
				}
				const isExpanded = expandedOverrides.get(entry.id) ?? options.expanded;

				let foldContent: Component;
				if (!isExpanded) {
					const summary =
						italicText(
							theme.fg(
								"thinkingText",
								`▸ Original response (${rewriteData.originalModel})...`,
							),
						) + theme.fg("dim", " (click to expand)");
					foldContent = new Text(summary, outputPad, 0);
				} else {
					const expandedContainer = new Container();
					const header = italicText(
						theme.fg(
							"thinkingText",
							`▾ Original response (${rewriteData.originalModel}):`,
						),
					);
					expandedContainer.addChild(new Text(header, outputPad, 0));
					expandedContainer.addChild(
						new Markdown(rewriteData.originalText.trim(), outputPad, 0, mdTheme, {
							color: (text) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					foldContent = expandedContainer;
				}

				const foldRegion = new MouseRegion(foldContent, (event) => {
					if (event.type !== "click" || event.button !== "left") {
						return undefined;
					}
					const current = expandedOverrides.get(entry.id) ?? options.expanded;
					expandedOverrides.set(entry.id, !current);
					this.rebuild();
					return { handled: true, render: true };
				});

				this.addChild(foldRegion);
				this.addChild(new Spacer(1));
				this.addChild(
					new SpokesmanSeparatorLine(theme, rewriteData.spokesmanModel, outputPad),
				);
				this.addChild(new Spacer(1));
				this.addChild(
					new Markdown(rewriteData.rewrittenText.trim(), outputPad, 0, mdTheme),
				);
			}
		}

		return new SpokesmanEntryCard();
	};
}
