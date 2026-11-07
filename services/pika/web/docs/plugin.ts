import { normalizePath, type Plugin } from "vite";
import { loadDocsData, sourcePaths } from "./content";

export const DOCS_MODULE_ID = "virtual:pi-docs";
const resolvedId = `\0${DOCS_MODULE_ID}`;

/** Reads only the explicit public sources; the browser receives a serialized data module. */
export function docsContent(): Plugin {
	const watched = new Set(sourcePaths.map(normalizePath));
	return {
		name: "pi-docs-content",
		resolveId(id) {
			if (id === DOCS_MODULE_ID) return resolvedId;
		},
		async load(id) {
			if (id !== resolvedId) return;
			for (const path of sourcePaths) this.addWatchFile(path);
			return `export default ${JSON.stringify(await loadDocsData())};`;
		},
		configureServer(server) {
			server.watcher.add(sourcePaths);
			server.watcher.on("all", (event, path) => {
				if (!["add", "change", "unlink"].includes(event) || !watched.has(normalizePath(path))) return;
				const module = server.moduleGraph.getModuleById(resolvedId);
				if (module) server.moduleGraph.invalidateModule(module);
				server.ws.send({ type: "full-reload", path: "*" });
			});
		},
	};
}
