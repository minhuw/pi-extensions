import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { BUTTON, Callout, cx } from "../components/ui";
import type { Theme } from "../lib/theme";
import { AttachStream, type ScreenOp } from "./attach";
import type { NodeChannel } from "./channel";
import { LIMITS, type TerminalInfo } from "./contract";
import { splitInput } from "./input";
import { swallowQueries } from "./queries";
import { SizeOwner } from "./size";

/** The page's ground and ink, so the terminal reads as part of it in either theme. */
const THEMES: Record<Theme, ITheme> = {
	light: { background: "#ffffff", foreground: "#0b0b0b", cursor: "#0b0b0b", cursorAccent: "#ffffff", selectionBackground: "rgba(11, 11, 11, 0.18)" },
	dark: { background: "#121212", foreground: "#ededed", cursor: "#ededed", cursorAccent: "#121212", selectionBackground: "rgba(237, 237, 237, 0.24)" },
};

/** `webgl`, or why the DOM renderer draws instead (xterm 6 has no canvas renderer). */
type Renderer = "webgl" | "no-webgl" | "webgl-failed" | "context-lost";

function webgl2Available(): boolean {
	try {
		return document.createElement("canvas").getContext("webgl2") !== null;
	} catch {
		return false;
	}
}

const clamp = (value: number, max: number): number => Math.max(1, Math.min(max, Math.floor(value)));

interface SizeView {
	cols: number;
	rows: number;
	owned: boolean;
	canFitHere: boolean;
	/** A `term.resized` has said who owns the size. */
	told: boolean;
}

/**
 * One node terminal in xterm.js (NODE.md, "Terminals"). It attaches on mount and again on a sequence gap, swallows
 * every terminal query (the daemon answers them), and renders at the PTY's size: this window claims the size on typing
 * or "Fit here", and otherwise shows the size another window set, letterboxed.
 */
export function TerminalView({
	channel,
	terminal,
	theme,
	onKill,
}: {
	channel: NodeChannel;
	terminal: TerminalInfo;
	theme: Theme;
	onKill: () => void;
}) {
	const { terminalId } = terminal;
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const ownerRef = useRef<SizeOwner | null>(null);
	const [renderer, setRenderer] = useState<Renderer>();
	const [phase, setPhase] = useState<{ kind: "attaching" | "live" } | { kind: "failed"; message: string }>({ kind: "attaching" });
	const [size, setSize] = useState<SizeView>({ cols: terminal.cols, rows: terminal.rows, owned: false, canFitHere: false, told: false });
	const exited = terminal.exited !== undefined;
	const initialTheme = useRef(theme);
	const initialSize = useRef({ cols: terminal.cols, rows: terminal.rows });

	useEffect(() => {
		const element = host.current!;
		const term = new Terminal({
			cols: initialSize.current.cols,
			rows: initialSize.current.rows,
			// The same scrollback as the daemon's headless screen; window reports stay off, as there.
			scrollback: 1000,
			fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
			fontSize: 13,
			cursorBlink: true,
			theme: THEMES[initialTheme.current],
		});
		// Before anything is written: a query answered here would reach pi as a second reply.
		const swallowing = swallowQueries(term);
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(element);
		termRef.current = term;

		if (!webgl2Available()) setRenderer("no-webgl");
		else {
			try {
				const webgl = new WebglAddon();
				webgl.onContextLoss(() => {
					webgl.dispose();
					setRenderer("context-lost");
				});
				term.loadAddon(webgl);
				setRenderer("webgl");
			} catch {
				setRenderer("webgl-failed");
			}
		}

		let disposed = false;
		let attachToken = 0;
		const stream = new AttachStream();
		const owner = new SizeOwner(initialSize.current, (notice) => {
			channel.notify({ type: "term.resize", terminalId, ...notice }).catch(() => {});
		});
		ownerRef.current = owner;
		let told = false;
		const publish = () => setSize({ ...owner.size, owned: owner.owned, canFitHere: owner.canFitHere, told });

		const measure = () => {
			const proposed = fit.proposeDimensions();
			if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
			owner.fitChanged({ cols: clamp(proposed.cols, LIMITS.maxCols), rows: clamp(proposed.rows, LIMITS.maxRows) });
			publish();
		};

		const apply = (ops: ScreenOp[]) => {
			for (const op of ops) {
				if (op.op === "reset") {
					term.reset();
					term.resize(op.cols, op.rows);
				} else if (op.op === "write") term.write(op.data);
				else attach();
			}
		};

		const attach = () => {
			const token = ++attachToken;
			stream.begin();
			setPhase({ kind: "attaching" });
			channel.request("term.attach", { terminalId }).then(
				(result) => {
					if (disposed || token !== attachToken) return;
					owner.attached(result.terminal);
					told = false;
					apply(stream.snapshot(result.snapshot));
					setPhase({ kind: "live" });
					measure();
					publish();
				},
				(error: unknown) => {
					if (disposed || token !== attachToken) return;
					setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
				},
			);
		};

		const offEvents = channel.onEvent((event) => {
			if (!("terminalId" in event) || event.terminalId !== terminalId) return;
			if (event.type === "term.output") apply(stream.output(event.seq, event.data));
			else if (event.type === "term.snapshot") apply(stream.snapshot(event.snapshot));
			else if (event.type === "term.resized") {
				owner.resized(event);
				told = true;
				term.resize(event.cols, event.rows);
				publish();
			}
		});

		const onData = term.onData((data) => {
			owner.input();
			for (const chunk of splitInput(data)) channel.notify({ type: "term.input", terminalId, data: chunk }).catch(() => {});
			publish();
		});

		let measureTimer: ReturnType<typeof setTimeout> | undefined;
		const observer = new ResizeObserver(() => {
			clearTimeout(measureTimer);
			measureTimer = setTimeout(measure, 80);
		});
		observer.observe(element);

		// Subscribed first, so output from the attach on is buffered.
		attach();

		return () => {
			disposed = true;
			clearTimeout(measureTimer);
			observer.disconnect();
			offEvents();
			onData.dispose();
			channel.request("term.detach", { terminalId }).catch(() => {});
			swallowing.dispose();
			term.dispose();
			termRef.current = null;
			ownerRef.current = null;
		};
	}, [channel, terminalId]);

	useEffect(() => {
		if (termRef.current) termRef.current.options.theme = THEMES[theme];
	}, [theme]);

	useEffect(() => {
		if (termRef.current) termRef.current.options.disableStdin = exited;
	}, [exited]);

	const fitHere = () => {
		ownerRef.current?.fitHere();
		termRef.current?.focus();
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-terminal-view={terminalId}>
			<div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3 text-[12.5px] text-muted">
				<span className="tabular-nums" data-terminal-size="">
					{size.cols}×{size.rows}
				</span>
				{size.told && <span data-size-owner={size.owned ? "here" : "elsewhere"}>{size.owned ? "Sized by this window" : "Sized by another window"}</span>}
				{size.canFitHere && (
					<button type="button" className={cx(BUTTON.quiet, "h-7 px-2")} onClick={fitHere} data-fit-here="">
						Fit here
					</button>
				)}
				{renderer && renderer !== "webgl" && (
					<span className="text-ink" data-renderer="dom" title="xterm.js draws with DOM elements, which is slower for heavy output">
						{renderer === "no-webgl"
							? "WebGL is unavailable here; drawing with the DOM renderer"
							: renderer === "context-lost"
								? "The WebGL context was lost; drawing with the DOM renderer"
								: "WebGL failed to start; drawing with the DOM renderer"}
					</span>
				)}
				{phase.kind === "attaching" && <span role="status">Attaching…</span>}
				<button type="button" className={cx(BUTTON.quiet, "ml-auto h-7 px-2")} onClick={onKill} data-kill-terminal="">
					{exited ? "Remove" : "Kill"}
				</button>
			</div>
			{exited && (
				<div className="shrink-0 border-b border-line bg-soft px-3 py-1.5 text-[12.5px]" data-terminal-exited="">
					Exited
					{terminal.exited!.code !== null ? ` with code ${terminal.exited!.code}` : ""}
					{terminal.exited!.signal ? ` by ${terminal.exited!.signal}` : ""}. Its last screen stays until you remove it.
				</div>
			)}
			{phase.kind === "failed" && (
				<div className="shrink-0 p-3">
					<Callout tone="red" title="Could not attach">
						{phase.message}
					</Callout>
				</div>
			)}
			{/* No padding here: the fit addon measures this element. A non-owner's grid is smaller or larger than it, letterboxed or scrolled. */}
			<div ref={host} className="min-h-0 flex-1 overflow-auto bg-page" data-terminal-host="" />
		</div>
	);
}
