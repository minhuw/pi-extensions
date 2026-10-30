import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { magpieModelName } from "./model-identity.ts";
import type { MagpieApi } from "./streams.ts";

export interface MagpieRouteMetadata {
	magpieRoute?: { canonicalId: string; owner?: string; group: boolean };
	magpieAliasTarget?: string;
}
export type MagpieModel = Model<MagpieApi> & MagpieRouteMetadata;
export interface MagpieAliasMessageMetadata { magpiePhysicalModel?: string }

/** Keep Pi's selection identity for recovery while recording the exact physical route. */
export function markMagpieAliasMessage(message: AssistantMessage, model: Model<any>): AssistantMessage & MagpieAliasMessageMetadata {
	const target = (model as MagpieRouteMetadata).magpieAliasTarget;
	return typeof target === "string" ? { ...message, model: model.id, magpiePhysicalModel: target } : message;
}

/** Restore physical IDs before SDK serialization so signed thinking and tool IDs replay unchanged. */
export function magpieRequestContext<T extends { messages: readonly unknown[] }>(context: T): T {
	let changed = false;
	const messages = context.messages.map(message => {
		if (!message || typeof message !== "object") return message;
		const row = message as Record<string, unknown>;
		if (row.role !== "assistant" || row.provider !== "magpie" || typeof row.magpiePhysicalModel !== "string") return message;
		changed = true;
		return { ...row, model: row.magpiePhysicalModel };
	});
	return changed ? { ...context, messages } as T : context;
}

type RawRow = Record<string, unknown> & { id: string };
function owner(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) ? value : undefined;
}
function metadata({ id: _id, ...rest }: RawRow): Record<string, unknown> { return rest; }
function knownGroup(id: string): boolean { return /^(?:auto|group)\//.test(id); }

/** Preserve advertised IDs; only exact raw metadata clones establish shortened routes. */
export function addMagpieModelAliases(models: readonly Model<MagpieApi>[], entries: readonly unknown[]): MagpieModel[] {
	const advertised = new Set(models.map(model => model.id));
	const rows = new Map<string, RawRow>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const row = entry as RawRow;
		if (typeof row.id === "string" && advertised.has(row.id) && !rows.has(row.id)) rows.set(row.id, row);
	}
	const groups = [...rows.values()].filter(row => knownGroup(row.id));
	const routes = new Map<string, NonNullable<MagpieRouteMetadata["magpieRoute"]>>();
	for (const model of models) {
		const row = rows.get(model.id);
		const route = { canonicalId: model.id, owner: owner(row?.owned_by), group: knownGroup(model.id) };
		if (row && !route.group) {
			// A group's owned_by describes its first member, not its routing identity.
			const matches = groups.filter(group => group.id.endsWith(`/${row.id}`) && isDeepStrictEqual(metadata(group), metadata(row)));
			if (matches.length) {
				route.group = true;
				if (matches.length === 1) route.canonicalId = matches[0].id;
			}
		}
		routes.set(model.id, route);
	}
	const result: MagpieModel[] = models.map(model => {
		const route = { ...routes.get(model.id)! };
		let row = rows.get(model.id);
		const visited = new Set<string>();
		while (row && !route.group && route.owner && !visited.has(row.id) && visited.size < rows.size) {
			visited.add(row.id);
			const target = rows.get(`${route.owner}/${row.id}`);
			if (!target || !isDeepStrictEqual(metadata(row), metadata(target))) break;
			const targetRoute = routes.get(target.id)!;
			route.canonicalId = targetRoute.canonicalId;
			route.group = targetRoute.group;
			row = target;
		}
		return { ...model, magpieRoute: route };
	});
	const families = new Map<string, MagpieModel[]>();
	for (const model of result) {
		const name = magpieModelName(model.id);
		if (!name || !/^claude-/.test(name) || model.magpieRoute!.group) continue;
		const family = families.get(name) ?? [];
		family.push(model);
		families.set(name, family);
	}
	for (const [name, family] of families) {
		if (advertised.has(name) || family.some(model => !model.magpieRoute!.owner)) continue;
		const canonicalIds = new Set(family.map(model => model.magpieRoute!.canonicalId));
		if (canonicalIds.size !== 1) continue;
		const canonicalId = family[0].magpieRoute!.canonicalId;
		const source = result.find(model => model.id === canonicalId);
		const route = source?.magpieRoute;
		if (!source || !route || route.group || !route.owner || !canonicalId.startsWith(`${route.owner}/`) ||
			family.some(model => model.magpieRoute!.owner !== route.owner)) continue;
		result.push({ ...source, id: name, name, magpieRoute: { ...route }, magpieAliasTarget: canonicalId });
	}
	return result;
}

export function resolveMagpieAlias<T extends Model<any>>(model: T): T {
	const target = (model as T & MagpieRouteMetadata).magpieAliasTarget;
	return typeof target === "string" ? { ...model, id: target } : model;
}

/** Fail closed when a saved local short selection would silently change its physical source. */
export function assertMagpieAliasRoute(model: Model<any>, catalog: readonly Model<any>[], messages: readonly unknown[]): void {
	const alias = model as Model<any> & MagpieRouteMetadata;
	if (typeof alias.magpieAliasTarget !== "string") return;
	const targetId = alias.magpieAliasTarget;
	const fail = () => { throw new Error("Magpie's short Claude alias no longer has the same unambiguous source. Start a new session or select an explicit provider route."); };
	const name = magpieModelName(alias.id);
	const target = catalog.find(row => row.id === targetId && (row as MagpieRouteMetadata).magpieAliasTarget === undefined) as MagpieModel | undefined;
	if (!name || !alias.magpieRoute || alias.magpieRoute.group || alias.magpieRoute.canonicalId !== targetId ||
		!owner(alias.magpieRoute.owner) || !target?.magpieRoute || target.magpieRoute.group ||
		target.magpieRoute.canonicalId !== targetId || target.magpieRoute.owner !== alias.magpieRoute.owner) fail();
	for (const row of catalog as readonly MagpieModel[]) {
		if (row.magpieAliasTarget !== undefined || magpieModelName(row.id) !== name || row.magpieRoute?.group) continue;
		if (row.magpieRoute?.canonicalId !== targetId || row.magpieRoute.owner !== alias.magpieRoute!.owner) fail();
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		const prior = message as Record<string, unknown>;
		if (prior.role !== "assistant" || prior.provider !== "magpie" || typeof prior.model !== "string" || magpieModelName(prior.model) !== name) continue;
		// Pi can synthesize failures before the provider records a physical route.
		// These short-ID entries carry no source evidence; keep looking backwards.
		if (prior.model === alias.id && typeof prior.magpiePhysicalModel !== "string" &&
			(prior.stopReason === "error" || prior.stopReason === "aborted")) continue;
		const physicalId = typeof prior.magpiePhysicalModel === "string" ? prior.magpiePhysicalModel : prior.model;
		if (physicalId !== targetId) fail();
		break;
	}
}
