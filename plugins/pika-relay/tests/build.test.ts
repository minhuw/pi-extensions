import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { DIST, PLUGIN } from "./support.ts";

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
    });
}

it("keeps the committed dist/ identical to a fresh build", () => {
    const out = mkdtempSync(join(tmpdir(), "pcr-build-"));
    try {
        execFileSync(process.execPath, [join(PLUGIN, "scripts/build.mjs"), "--out", out]);
        const built = files(out).map((path) => relative(out, path)).sort();
        const committed = files(DIST).map((path) => relative(DIST, path)).sort();
        expect(committed).toEqual(built);
        for (const path of built) {
            expect(readFileSync(join(DIST, path), "utf8"), `dist/${path} is stale; run npm run build:codex-relay`).toBe(readFileSync(join(out, path), "utf8"));
        }
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
});

it("emits dist/ that imports only node: built-ins and its own files", () => {
    for (const path of files(DIST).filter((file) => file.endsWith(".js"))) {
        const specifiers = [...readFileSync(path, "utf8").matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]!);
        for (const specifier of specifiers) expect(specifier, relative(DIST, path)).toMatch(/^(node:|\.\.?\/.*\.js$)/);
    }
});

it("declares manifests that point at existing files", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, ".codex-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("pika-relay");
    const mcp = JSON.parse(readFileSync(join(PLUGIN, manifest.mcpServers), "utf8"));
    expect(mcp.mcpServers.pika_relay.args).toEqual(["./dist/mcp.js"]);
    expect(statSync(join(PLUGIN, "dist/mcp.js")).isFile()).toBe(true);
    const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8")).hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    for (const [event, entries] of Object.entries(hooks) as [string, { hooks: { command: string }[] }[]][]) {
        expect(entries[0]!.hooks[0]!.command).toBe(`node "\${PLUGIN_ROOT}/dist/hook.js" ${event}`);
    }
    const marketplace = JSON.parse(readFileSync(join(PLUGIN, "../../.agents/plugins/marketplace.json"), "utf8"));
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "pika-relay", source: { source: "local", path: "./plugins/pika-relay" } })]);
    expect(statSync(join(PLUGIN, "skills/pika-relay/SKILL.md")).isFile()).toBe(true);
    const { version } = JSON.parse(readFileSync(join(PLUGIN, ".codex-plugin/plugin.json"), "utf8"));
    expect(readFileSync(join(DIST, "tools.js"), "utf8")).toContain(`PLUGIN_VERSION = "${version}"`);
});
