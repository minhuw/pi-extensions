// Test-only preload for Playwright 1.56.1's installer and downloader children.
// Its bundled streaming ZIP extractor stalls on Node 26 (reproduced with both
// official macOS Chromium archives; the same bytes extract on Node 24).
// Preserve the pinned CLI's official downloads, revision selection and markers;
// replace only extraction, in this isolated child process, with POSIX unzip.
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
if (Number(process.versions.node.split(".")[0]) >= 26 && process.platform !== "win32") {
	// The pinned CLI also uses the recursive rmdir API removed in Node 26.
	const originalRmdir = fs.rmdir;
	fs.rmdir = (file, options) => options?.recursive ? fs.rm(file, { recursive: true, force: true }) : originalRmdir(file, options);
	const bundlePath = path.join(path.dirname(require.resolve("playwright-core")), "lib", "zipBundle.js");
	const bundle = require(bundlePath);
	require.cache[bundlePath].exports = {
		...bundle,
		async extract(archive, options) {
			if (!options?.dir || !path.isAbsolute(options.dir)) throw new Error("Managed browser extraction requires an absolute private destination.");
			await fs.mkdir(options.dir, { recursive: true, mode: 0o700 });
			try { await promisify(execFile)("unzip", ["-oq", archive, "-d", options.dir], { timeout: 60_000, maxBuffer: 128 * 1024 }); }
			catch (error) { throw new Error(`Playwright 1.56.1 extraction on Node 26 requires POSIX unzip; install unzip or run with Node 22/24 LTS. ${String(error)}`); }
		},
	};
}
