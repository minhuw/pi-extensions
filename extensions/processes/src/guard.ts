// Blocks `bash` tool calls that background a process (a job-control `&`, or nohup/setsid/disown as a command word):
// such jobs outlive the call unobserved, so they belong in process_start. The scanner approximates shell syntax:
// quotes, backslash escapes, comments, heredoc bodies, arithmetic, `${...}`, and redirections such as `2>&1` and `&>`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_REASON =
	'Do not background in bash. Run the command in the foreground (it moves to the background on its own if it keeps running) or use process_start (kind "task" for one-shot jobs).';

const DETACHERS = new Set(["nohup", "setsid", "disown"]);
/** Words after which the next word is still in command position. */
const PREFIXES = new Set(["!", "{", "then", "do", "else", "elif", "if", "while", "until", "time", "exec", "command", "builtin", "sudo", "env", "nice"]);
const WORD_BREAK = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

/** The backgrounding construct in `command` ("&", "nohup", ...), or undefined. */
export function findBackgrounding(command: string): string | undefined {
	const s = command;
	let i = 0;
	let commandPosition = true;
	let word = "";
	const heredocs: { delimiter: string; stripTabs: boolean }[] = [];

	const endWord = (): string | undefined => {
		if (!word) return undefined;
		const current = word;
		word = "";
		if (!commandPosition) return undefined;
		const name = current.slice(current.lastIndexOf("/") + 1);
		if (DETACHERS.has(name)) return name;
		// Assignments (`FOO=1 cmd`) and prefix keywords keep the next word in command position.
		if (!PREFIXES.has(current) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(current)) commandPosition = false;
		return undefined;
	};
	/** Index just past the `close` that balances the `open` already consumed, counting nested pairs. */
	const skipBalanced = (from: number, open: string, close: string): number => {
		let depth = 1;
		let j = from;
		while (j < s.length && depth > 0) {
			if (s[j] === "\\") j++;
			else if (s.startsWith(open, j)) depth++;
			else if (s.startsWith(close, j)) {
				depth--;
				if (depth === 0) return j + close.length;
			}
			j++;
		}
		return s.length;
	};
	const skipQuoted = (from: number, quote: string): number => {
		let j = from;
		while (j < s.length && s[j] !== quote) {
			if (quote === '"' && s[j] === "\\") j++;
			j++;
		}
		return j + 1;
	};
	const readHeredocDelimiter = (from: number): number => {
		let j = from;
		const stripTabs = s[j] === "-";
		if (stripTabs) j++;
		while (s[j] === " " || s[j] === "\t") j++;
		let delimiter = "";
		while (j < s.length && !WORD_BREAK.has(s[j]!)) {
			const c = s[j]!;
			if (c === "'" || c === '"') {
				const end = skipQuoted(j + 1, c);
				delimiter += s.slice(j + 1, end - 1);
				j = end;
			} else {
				if (c !== "\\") delimiter += c;
				j++;
			}
		}
		if (delimiter) heredocs.push({ delimiter, stripTabs });
		return j;
	};
	/** At a newline with pending heredocs: index just past their bodies. */
	const skipHeredocBodies = (from: number): number => {
		let j = from;
		for (const { delimiter, stripTabs } of heredocs.splice(0)) {
			while (j < s.length) {
				const end = s.indexOf("\n", j);
				const line = s.slice(j, end === -1 ? s.length : end);
				j = end === -1 ? s.length : end + 1;
				if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
			}
		}
		return j;
	};

	while (i < s.length) {
		const c = s[i]!;
		if (c === "\\") {
			// A line continuation joins lines; any other escape is part of the word.
			if (s[i + 1] !== "\n") word += s.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === "'" || c === '"') {
			const end = skipQuoted(i + 1, c);
			word += s.slice(i, end);
			i = end;
			continue;
		}
		if (c === "#" && !word) {
			const end = s.indexOf("\n", i);
			i = end === -1 ? s.length : end;
			continue;
		}
		if (c === "$" && s.startsWith("$((", i)) {
			i = skipBalanced(i + 3, "((", "))");
			word += "$";
			continue;
		}
		if (c === "$" && s[i + 1] === "{") {
			i = skipBalanced(i + 2, "{", "}");
			word += "$";
			continue;
		}
		if (c === "`") {
			// Backquoted substitution: scan its body as commands.
			const found = endWord();
			if (found) return found;
			commandPosition = true;
			i++;
			continue;
		}
		if (c === "$" && s[i + 1] === "(") {
			const found = endWord();
			if (found) return found;
			commandPosition = true;
			i += 2;
			continue;
		}
		if (!WORD_BREAK.has(c)) {
			word += c;
			i++;
			continue;
		}

		const found = endWord();
		if (found) return found;
		if (c === " " || c === "\t") {
			i++;
		} else if (c === "\n") {
			commandPosition = true;
			i = heredocs.length > 0 ? skipHeredocBodies(i + 1) : i + 1;
		} else if (c === ";" && (s[i + 1] === ";" || s[i + 1] === "&")) {
			// `case` terminators `;;`, `;&`, `;;&`
			i += s[i + 1] === ";" && s[i + 2] === "&" ? 3 : 2;
			commandPosition = true;
		} else if (c === ";" || c === "(" || c === ")") {
			if (c === "(" && s[i + 1] === "(" && commandPosition) {
				i = skipBalanced(i + 2, "((", "))");
				commandPosition = false;
				continue;
			}
			commandPosition = c !== ")";
			i++;
		} else if (c === "|") {
			// `|`, `||`, `|&`
			i += s[i + 1] === "|" || s[i + 1] === "&" ? 2 : 1;
			commandPosition = true;
		} else if (c === "<" || c === ">") {
			if (s.startsWith("<<<", i)) {
				i += 3;
			} else if (s.startsWith("<<", i)) {
				i = readHeredocDelimiter(i + 2);
			} else {
				// `>`, `>>`, `<`, `<>`, `>|`, and descriptor duplication `>&2`, `<&0`.
				i++;
				while (s[i] === ">" || s[i] === "<" || s[i] === "|") i++;
				if (s[i] === "&") i++;
			}
		} else if (c === "&") {
			if (s[i + 1] === "&") {
				i += 2;
				commandPosition = true;
			} else if (s[i + 1] === ">") {
				// `&>file`, `&>>file`
				i += s[i + 2] === ">" ? 3 : 2;
			} else {
				return "&";
			}
		}
	}
	return endWord();
}

export function registerBashGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;
		return findBackgrounding(command) ? { block: true, reason: BACKGROUND_REASON } : undefined;
	});
}
