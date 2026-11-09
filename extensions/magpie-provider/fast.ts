import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MagpieModel } from "./model-aliases.ts";

const FAST_ENTRY = "magpie-fast";

function fastEnabled(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== FAST_ENTRY) continue;
		const data = entry.data;
		if (data && typeof data === "object" && "enabled" in data && typeof data.enabled === "boolean") return data.enabled;
	}
	return false;
}

/** Require both the active selection and the current catalog to support Fast. */
function currentFastModel(ctx: ExtensionContext): MagpieModel | undefined {
	const selected = ctx.model;
	if (!selected || selected.provider !== "magpie" || selected.api !== "openai-responses") return undefined;
	const current = ctx.modelRegistry.getAll().find(model => model.provider === selected.provider && model.id === selected.id) as MagpieModel | undefined;
	if (!current || current.api !== selected.api || !current.magpieServiceTiers?.includes("priority")) return undefined;
	return current;
}

export function registerMagpieFast(pi: ExtensionAPI): void {
	pi.registerCommand("fast", {
		description: "Toggle Fast for supported Magpie Responses models in this session",
		async handler(args, ctx) {
			const action = args.trim().toLowerCase();
			const enabled = fastEnabled(ctx);
			if (action === "status") {
				ctx.ui.notify(enabled
					? currentFastModel(ctx) ? "Fast is on for this Magpie model." : "Fast is on, but the selected model does not advertise a supported Fast tier."
					: "Fast is off.", "info");
				return;
			}
			if (!["", "on", "off", "toggle"].includes(action)) {
				ctx.ui.notify("Usage: /fast [on|off|toggle|status]", "warning");
				return;
			}
			const next = action === "on" ? true : action === "off" ? false : !enabled;
			if (next && !currentFastModel(ctx)) {
				ctx.ui.notify("Fast requires a Magpie Responses model whose current catalog advertises priority.", "warning");
				return;
			}
			if (next !== enabled) pi.appendEntry(FAST_ENTRY, { enabled: next });
			ctx.ui.notify(next
				? "Fast is on for supported Magpie Responses models in this session. Usage may increase."
				: "Fast is off for this session.", "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastEnabled(ctx)) return;
		const model = currentFastModel(ctx);
		if (!model || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		const payload = event.payload as Record<string, unknown>;
		// Aliases dispatch to their physical route; don't alter a different model's request.
		if (payload.model !== (model.magpieAliasTarget ?? model.id)) return;
		return { ...payload, service_tier: "priority" };
	});
}
