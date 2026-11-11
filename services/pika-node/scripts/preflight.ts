/** Native preflight: node-pty loads and runs /bin/sh -c "exit 0" in a PTY. Exits non-zero otherwise. */
import { createRequire } from "node:module";
import { ensureSpawnHelper } from "../src/spawn.ts";

ensureSpawnHelper();
const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const timer = setTimeout(() => { console.error("pika-node preflight: the PTY probe did not exit within 10 s"); process.exit(1); }, 10_000);
pty.spawn("/bin/sh", ["-c", "exit 0"], { cols: 80, rows: 24 }).onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (exitCode !== 0) { console.error(`pika-node preflight: the PTY probe exited ${exitCode}`); process.exit(1); }
    console.log("pika-node preflight: node-pty OK");
});
