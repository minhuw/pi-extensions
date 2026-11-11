import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAlwaysOn } from "./alwayson.ts";
import { registerBoom } from "./boom.ts";

/** `/boom` and `/alwayson`: two independent session-only delegation modes on one cache-safe switch. */
export default function delegationExtension(pi: ExtensionAPI): void {
	registerBoom(pi);
	registerAlwaysOn(pi);
}
