import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import provider from "./src/index.ts";
import tps from "./src/tps.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await provider(pi);
	tps(pi);
}
