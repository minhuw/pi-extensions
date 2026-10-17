import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNativeCompaction } from "../shared/native-compaction/lifecycle.ts";
import { loadConfig } from "./config.ts";

export default function cliproxyNativeCompactionExtension(pi: ExtensionAPI): void {
	registerNativeCompaction(pi, {
		loadConfig: (ctx) => loadConfig(ctx.cwd, ctx.isProjectTrusted()),
		ownsProvider: (id, config) => id === config.providerId && id !== "magpie",
		command: "cliproxyapi-native-compaction",
		label: "CLIProxyAPI",
	});
}
