import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { MagpieApi } from "./streams.ts";

export interface MagpieCatalog {
	models: Model<MagpieApi>[];
	generation: number;
}
export type MagpieCatalogs = (origin: string, apiKey: string | undefined, provenance: string | undefined) => MagpieCatalog;

export function emptyMagpieCatalog(): MagpieCatalog { return { models: [], generation: 0 }; }

// Pi loads extensions with separate module caches. Share only catalog data, never
// providers or callbacks that belong to a particular extension session. Weak
// references let catalogs disappear when their last provider is released.
const key = Symbol.for("pi-extensions.magpie.catalogs.v1");
export function sharedMagpieCatalogs(agentDir: string): MagpieCatalogs {
	const global = globalThis as typeof globalThis & { [key]?: Map<string, WeakRef<MagpieCatalog>> };
	const catalogs = global[key] ??= new Map();
	const scope = resolve(agentDir);
	return (origin, apiKey, provenance) => {
		const identity = createHash("sha256").update(JSON.stringify([scope, origin, apiKey, provenance])).digest("hex");
		let catalog = catalogs.get(identity)?.deref();
		if (!catalog) {
			for (const [id, reference] of catalogs) if (!reference.deref()) catalogs.delete(id);
			catalog = emptyMagpieCatalog();
			catalogs.set(identity, new WeakRef(catalog));
		}
		return catalog;
	};
}
