import type { TerminalInfo } from "./contract";

const BRACKET_START = "\x1b[200~";
const BRACKET_END = "\x1b[201~";
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
/** Characters no POSIX shell, fish included, treats specially. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A path as one shell word: as it is when it is safe, else in single quotes (`'` as `'\''`). */
export function shellQuote(path: string): string {
	if (SHELL_SAFE.test(path)) return path;
	return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Whether pi itself reads the pane's input: its program status (OSC 7501 `app=pi`, dropped when pi leaves the
 * foreground), or its bridge's open socket.
 */
export function runsPi(terminal: Pick<TerminalInfo, "status" | "exited">): boolean {
	return !terminal.exited && (terminal.status?.program?.app === "pi" || terminal.status?.bridgeConnected === true);
}

export interface PasteTarget {
	/** The PTY has bracketed paste mode on (DECSET 2004), as the output stream set it in this window's terminal. */
	bracketed: boolean;
	/** pi reads the paste: paths go in as they are, one per line, as its own clipboard file paste inserts them. */
	pi: boolean;
}

/**
 * The text that puts `paths` on the pane's input line. pi gets the bare paths (it quotes nothing and reads a path with
 * spaces as one); a shell gets each path as one shell word. Either way a space follows, so the next word can be typed
 * at once. With bracketed paste on, the text is framed as a paste, so a shell inserts it rather than running it and
 * pi takes it as one paste. A path with control characters is refused: framed, it could end the paste early.
 */
export function pasteText(paths: readonly string[], target: PasteTarget): string {
	if (paths.length === 0) return "";
	const bad = paths.find((path) => CONTROLS.test(path));
	if (bad !== undefined) throw new Error(`A path holds control characters: ${JSON.stringify(bad)}`);
	const text = `${target.pi ? paths.join("\n") : paths.map(shellQuote).join(" ")} `;
	return target.bracketed ? `${BRACKET_START}${text}${BRACKET_END}` : text;
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" };

/**
 * The first image on the clipboard, as pi's read tool takes it (PNG, JPEG, GIF, WebP, or BMP, detected from its
 * bytes), with a name like pi's own clipboard paste gives one. Undefined when the clipboard holds no such image.
 */
export function clipboardImage(data: DataTransfer | null, now = new Date()): { blob: Blob; name: string } | undefined {
	if (!data) return undefined;
	for (const item of Array.from(data.items)) {
		if (item.kind !== "file") continue;
		const type = item.type.split(";")[0]!.trim().toLowerCase();
		const extension = IMAGE_EXTENSIONS[type];
		if (!extension) continue;
		const blob = item.getAsFile();
		if (!blob) continue;
		const stamp = now.toISOString().replace(/\.\d+Z$/, "").replaceAll(":", "-").replace("T", "-");
		return { blob, name: `pasted-${stamp}.${extension}` };
	}
	return undefined;
}
