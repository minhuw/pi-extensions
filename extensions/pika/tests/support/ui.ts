import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { LogViewer } from "../../log-viewer.ts";

export const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
export const colorTheme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
export const styledTheme = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;

export const LOG_KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
	enter: "\r",
	esc: "\x1b",
} as const;

export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** A UI context that records notifications and footer statuses; every other method is a no-op. */
export class RecordingUI {
	readonly notes: { message: string; type?: string }[] = [];
	/** The current statuses set, by key; a cleared one is gone. */
	readonly statuses = new Map<string, string>();
	/** Every `setStatus` call, in order. */
	readonly statusHistory: [string, string | undefined][] = [];
	get last() { return this.notes.at(-1); }
	get messages() { return this.notes.map((note) => note.message); }
	status(key = "pika-memory"): string | undefined { return this.statuses.get(key); }
	context(): ExtensionUIContext {
		const methods: Partial<ExtensionUIContext> = {
			notify: (message, type) => { this.notes.push({ message, type }); },
			setStatus: (key, text) => {
				this.statusHistory.push([key, text]);
				if (text === undefined) this.statuses.delete(key);
				else this.statuses.set(key, text);
			},
		};
		return new Proxy(methods, {
			get: (target, name) => name in target ? target[name as keyof ExtensionUIContext] : name === "then" ? undefined : () => undefined,
		}) as ExtensionUIContext;
	}
}

export interface LogUIOptions {
	rows?: number;
	theme?: Theme;
	keybindings?: unknown;
	requestRender?: () => void;
}

/** A UI that records notifications and opens `ui.custom` components on a fake terminal. */
export class LogUI extends RecordingUI {
	viewer: LogViewer | undefined;
	options: { overlay?: boolean; overlayOptions?: () => unknown } | undefined;
	renderRequests = 0;
	readonly tui: { mode: "regular"; terminal: { rows: number }; requestRender: () => void };
	private readonly theme: Theme;
	private readonly keybindings: unknown;

	constructor(options: LogUIOptions = {}) {
		super();
		this.theme = options.theme ?? plainTheme;
		this.keybindings = options.keybindings;
		const onRender = options.requestRender;
		this.tui = {
			mode: "regular",
			terminal: { rows: options.rows ?? 40 },
			requestRender: onRender ?? (() => { this.renderRequests++; }),
		};
	}

	override context(): ExtensionUIContext {
		const base = super.context();
		const custom = (factory: (...args: unknown[]) => LogViewer, options?: LogUI["options"]) => new Promise((resolve) => {
			this.options = options;
			this.viewer = factory(this.tui, this.theme, this.keybindings, resolve);
		});
		return new Proxy(base, { get: (target, name) => name === "custom" ? custom : Reflect.get(target, name) });
	}

	press(...keys: string[]): void {
		for (const key of keys) this.viewer!.handleInput(key);
	}

	lines(width = 100): string[] {
		return this.viewer!.render(width).map((line) => stripAnsi(line).trimEnd());
	}
}

/** How long a custom component may stay open after its keys before the scripted UI gives up. */
const CUSTOM_WAIT_MS = 10_000;

/** A UI context whose dialogs answer from scripts and which records what pika showed. */
export class ScriptedUI {
	readonly notes: { message: string; type?: string }[] = [];
	readonly prompts: { title: string; placeholder?: string }[] = [];
	readonly selects: { title: string; options: string[] }[] = [];
	/** Every line a custom component rendered, after each key and each render it requested. */
	readonly rendered: string[] = [];
	/** Answers to `input`, in order; undefined cancels. */
	inputs: (string | undefined)[] = [];
	/** Answers to `select`, in order; undefined cancels. */
	choices: (string | undefined)[] = [];
	/** Keys typed into each `custom` component, in order. */
	keys: string[][] = [];
	/** Components disposed after they finished. */
	disposed = 0;
	/** Custom components that never finished; the scripted UI rejected them. */
	unfinished = 0;

	get messages(): string[] { return this.notes.map((note) => note.message); }
	get last(): { message: string; type?: string } | undefined { return this.notes.at(-1); }

	context(): ExtensionUIContext {
		const methods: Partial<ExtensionUIContext> = {
			notify: (message, type) => { this.notes.push({ message, type }); },
			input: async (title, placeholder) => {
				this.prompts.push({ title, placeholder });
				if (!this.inputs.length) throw new Error(`unexpected prompt: ${title}`);
				return this.inputs.shift();
			},
			select: async (title, options) => {
				this.selects.push({ title, options });
				if (!this.choices.length) throw new Error(`unexpected select: ${title}`);
				return this.choices.shift();
			},
			custom: (async (factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: unknown) => void) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>) => {
				const keys = this.keys.shift();
				if (!keys) throw new Error("unexpected custom component");
				let component: (Component & { dispose?(): void }) | undefined;
				let finish!: (result: { value: unknown }) => void;
				const finished = new Promise<{ value: unknown }>((resolve) => { finish = resolve; });
				let result: { value: unknown } | undefined;
				const tui = { requestRender: () => { if (component && !result) this.rendered.push(...component.render(60)); } };
				component = await factory(tui, plainTheme, {}, (value) => { if (!result) { result = { value }; finish(result); } });
				this.rendered.push(...component.render(60));
				for (const key of keys) {
					component.handleInput?.(key);
					this.rendered.push(...component.render(60));
				}
				// A component may also finish later, for example when a pairing is decided.
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { this.unfinished++; reject(new Error("the custom component did not finish")); }, CUSTOM_WAIT_MS); });
				try {
					return (await Promise.race([finished, timeout])).value;
				} finally {
					clearTimeout(timer);
					if (component.dispose) { component.dispose(); this.disposed++; }
				}
			}) as ExtensionUIContext["custom"],
		};
		// Everything else is a no-op, as in Pi's UI-less context.
		return new Proxy(methods, {
			get: (target, name) => name in target ? target[name as keyof ExtensionUIContext] : name === "then" ? undefined : () => undefined,
		}) as ExtensionUIContext;
	}
}
