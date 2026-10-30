import { atomicWrite, optionalText, readConfigs, saveConfig, withGitExcludeMutation, withManagedFileMutation } from "../../src/project.ts";

const [root, mode] = process.argv.slice(2) as [string, string];
const release = () => new Promise<void>((resolve) => process.once("message", () => resolve()));
try {
	const config = (await readConfigs(root))[0]!;
	if (mode.endsWith("exclude")) {
		process.send?.({ phase: "snapshot" });
		if (mode === "append-exclude") await release();
		await withGitExcludeMutation(root, undefined, async (file) => {
			if (!file) throw new Error("Expected Git exclude file");
			const text = await optionalText(file);
			process.send?.({ phase: "locked" });
			if (mode === "hold-exclude") await release();
			await atomicWrite(file, `${text ?? ""}${mode}\n`);
		});
	} else if (mode === "hold") {
		await withManagedFileMutation(config.file, undefined, async (physical) => {
			process.send?.({ phase: "locked" });
			await release();
			await atomicWrite(physical, JSON.stringify({ ...config.value, product: { keep: 2 } }));
		});
	} else {
		process.send?.({ phase: "snapshot" });
		await release();
		await saveConfig(config, { ...config.value, hook: { enabled: true } });
	}
	process.send?.({ phase: "done", ok: true });
} catch (error) { process.send?.({ phase: "done", ok: false, error: String(error) }); }
process.disconnect?.();
