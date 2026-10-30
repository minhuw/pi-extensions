import { createRequire } from "node:module";
// Use the exact TypeScript loader installed by the Pi SDK, as its extension runtime does.
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti") as { createJiti: (url: string) => { import: (file: string) => Promise<unknown> } };
const { LiveOwner } = await createJiti(import.meta.url).import("../../src/live.ts") as typeof import("../../src/live.ts");
const [root, binary, session] = process.argv.slice(2);
const owner = new LiveOwner(session!, (live) => {
	if (["polling", "paused"].includes(live.phase)) process.send?.({ view: live.view(), saved: live.saved() });
}, { binary, env: { IMPECCABLE_LIVE_FIXTURE: root } });
process.on("message", async (message) => {
	if (message === "crash") process.exit(0);
	if (message === "stop") { await owner.pause("child stop", true); process.exit(0); }
});
owner.start(root!, [], false);
