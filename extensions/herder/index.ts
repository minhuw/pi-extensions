import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerder } from "./src/adapter/extension.ts";
import { createRuntime } from "./src/adapter/runtime.ts";

export default function herderExtension(pi: ExtensionAPI): void {
	registerHerder(pi, { createRuntime });
}
