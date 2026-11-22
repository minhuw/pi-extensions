import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = join(root, "extensions/pika-node-bridge");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; pi: { extensions: string[] } };

it("loads next to the Orca bridge and wires test:pika-node-bridge", () => {
	const extensions = manifest.pi.extensions;
	expect(extensions.indexOf("./extensions/pika-node-bridge/index.ts")).toBe(extensions.indexOf("./extensions/orca-bridge/index.ts") + 1);
	expect(manifest.scripts["test:pika-node-bridge"]).toBe("vitest run extensions/pika-node-bridge");
});

it("imports at runtime only Node, the Pi SDK types, and its own files", () => {
	const files = readdirSync(directory).filter(file => file.endsWith(".ts"));
	expect(files.sort()).toEqual(["activity.ts", "compatibility.ts", "index.ts", "navigation.ts", "protocol.ts", "status.ts", "transport.ts"]);
	for (const file of files) {
		const source = readFileSync(join(directory, file), "utf8");
		for (const [, typeOnly, specifier] of source.matchAll(/^import (type )?[^;]*? from "([^"]+)";/gms)) {
			if (specifier!.startsWith("node:") || /^\.\/[a-z]+\.ts$/.test(specifier!)) continue;
			expect(specifier, `${file} imports ${specifier}`).toBe("@earendil-works/pi-coding-agent");
			expect(typeOnly, `${file} imports the Pi SDK for types only`).toBe("type ");
		}
	}
});

it("documents every bridge command in README.md", () => {
	const readme = readFileSync(join(directory, "README.md"), "utf8");
	for (const command of ["pika-node-status", "pika-open", "pika-diff"]) {
		expect(readme, `README.md should document /${command}`).toContain(`/${command}`);
	}
});
