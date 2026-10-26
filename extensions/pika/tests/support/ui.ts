import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

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
