import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Writes a POSIX shell fake engine, chmod +x, and returns its path. */
export async function writeFakeEngine(dir: string, name: string, body: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	await writeFile(file, body, { mode: 0o755 });
	await chmod(file, 0o755);
	return file;
}

/** A fake engine that echoes argv, the upstream env context, and cwd, then exits 0. */
export const ECHO_ENGINE = `#!/bin/sh
echo "ARGV:$*"
printf '<%s>\\n' "$@"
printf 'ENV:<%s>\\n' "$IMPECCABLE_TEST_LITERAL"
echo "SKILL_DIR:$IMPECCABLE_SKILL_DIR"
echo "SELF:$IMPECCABLE_SELF"
echo "PWD:$(pwd)"
exit 0
`;
