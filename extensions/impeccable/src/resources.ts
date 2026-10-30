import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resource locations for the installed Impeccable skill.
 *
 * Everything resolves from this module's `import.meta.url`, so the paths stay
 * correct regardless of the user's cwd or where the package is installed. The
 * module lives at `<extension-root>/src/resources.ts`; the extension root is one
 * directory up, and the skill distribution is at `<extension-root>/skills/impeccable`.
 */

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(sourceDir, "..");

/** The pinned engine version; must match `skills/impeccable/scripts/VERSION`. */
export const ENGINE_VERSION = "0.1.18";

/** Absolute path of the installed skill directory (`<skill-base-dir>`). */
export function getSkillDir(): string {
	return path.join(extensionRoot, "skills", "impeccable");
}

/** Absolute path of the skill's `scripts/` directory. */
export function getScriptsDir(): string {
	return path.join(getSkillDir(), "scripts");
}

/** Absolute path of the vendored engine checksum manifest. */
export function getChecksumsPath(): string {
	return path.join(getScriptsDir(), "engine-checksums.txt");
}

/** Absolute path of the vendored VERSION file. */
export function getVersionPath(): string {
	return path.join(getScriptsDir(), "VERSION");
}

/**
 * Absolute path of the skill launcher. The engine is spawned directly, but
 * upstream's engine reads `IMPECCABLE_SELF` to name the command it prints in
 * its directives, so we point it at the real installed launcher: the `.cmd`
 * wrapper on Windows and the POSIX `sh` launcher everywhere else.
 */
export function getLauncherPath(): string {
	return path.join(getScriptsDir(), process.platform === "win32" ? "impeccable.cmd" : "impeccable");
}
