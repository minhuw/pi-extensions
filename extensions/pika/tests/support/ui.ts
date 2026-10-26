import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

/** A UI context whose dialogs answer from scripts and which records what pika showed. */
export class ScriptedUI {
	readonly notes: { message: string; type?: string }[] = [];
	readonly prompts: { title: string; placeholder?: string }[] = [];
	/** Every line a custom component rendered, after each key. */
	readonly rendered: string[] = [];
	/** Answers to `input`, in order; undefined cancels. */
	inputs: (string | undefined)[] = [];
	/** Keys typed into each `custom` component, in order. */
	keys: string[][] = [];

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
			custom: (async (factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: unknown) => void) => Component | Promise<Component>) => {
				const keys = this.keys.shift();
				if (!keys) throw new Error("unexpected custom component");
				let result: { value: unknown } | undefined;
				const component = await factory({ requestRender: () => {} }, plainTheme, {}, (value) => { result = { value }; });
				this.rendered.push(...component.render(60));
				for (const key of keys) {
					component.handleInput?.(key);
					this.rendered.push(...component.render(60));
				}
				if (!result) throw new Error("the custom component did not finish");
				return result.value;
			}) as ExtensionUIContext["custom"],
		};
		// Everything else is a no-op, as in Pi's UI-less context.
		return new Proxy(methods, {
			get: (target, name) => name in target ? target[name as keyof ExtensionUIContext] : name === "then" ? undefined : () => undefined,
		}) as ExtensionUIContext;
	}
}
