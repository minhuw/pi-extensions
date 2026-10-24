import { magpieModelName } from "./model-identity.ts";
import type { MagpieRouteMetadata } from "./model-aliases.ts";

interface PickerModel extends MagpieRouteMetadata {
	id: string;
	name: string;
	api: string;
}

function nativeApi(api: string): boolean {
	return api === "openai-responses" || api === "anthropic-messages";
}

function compareRoutes(left: PickerModel, right: PickerModel): number {
	return left.id.split("/").length - right.id.split("/").length ||
		Number(nativeApi(right.api)) - Number(nativeApi(left.api)) ||
		left.id.length - right.id.length;
}

/** Collapse proven aliases of one source; equally named sources and groups remain distinct. */
export function selectMagpiePickerModels<T extends PickerModel>(models: readonly T[], preserveScope = false): T[] {
	// Keep the complete catalog for exact-ID, wildcard and display-name scopes.
	if (preserveScope) return [...models];
	const sources = new Map<string, Set<string>>();
	for (const model of models) {
		if (model.magpieRoute?.group) continue;
		const name = magpieModelName(model.id) ?? model.id;
		const ids = sources.get(name) ?? new Set<string>();
		ids.add(model.magpieRoute?.canonicalId ?? model.id);
		sources.set(name, ids);
	}
	const selected = new Map<string, T>();
	for (const model of models) {
		const name = magpieModelName(model.id) ?? model.id;
		const canonicalId = model.magpieRoute?.canonicalId ?? model.id;
		const qualified = model.magpieRoute?.group || (sources.get(name)?.size ?? 0) > 1;
		const previous = selected.get(canonicalId);
		// Preserve explicit source/group IDs when a short name could hide a choice.
		const canonicalPreference = qualified && previous
			? Number(previous.id === canonicalId) - Number(model.id === canonicalId) : 0;
		if (!previous || (canonicalPreference || compareRoutes(model, previous)) < 0) selected.set(canonicalId, model);
	}
	return Array.from(selected.values(), model => {
		const name = magpieModelName(model.id) ?? model.id;
		return { ...model, name: model.magpieRoute?.group || (sources.get(name)?.size ?? 0) > 1 ? model.id : name };
	});
}
