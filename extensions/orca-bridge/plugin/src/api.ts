import type { ActivityView } from "./protocol.ts";
export {};

declare module "orca" {
	interface PluginRequests {
		"activity.list": { input: Record<string, never>; output: ActivityView };
	}
	interface PluginPanelEvents {
		"activity.changed": { revision: number };
	}
}
