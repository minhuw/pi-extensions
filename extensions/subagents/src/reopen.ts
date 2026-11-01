/**
 * reopen.ts — validation for `subagents:rpc:reopen`, which opens and replays a
 * caller-named session file. The file must be a persisted Subagents child
 * session: an existing regular `.jsonl` file under the child session root
 * (`resolveChildSessionRoot`), whose header names a `parentSession`.
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";

/** Longest first line read while looking for the session header. */
const MAX_HEADER_BYTES = 1024 * 1024;

function readFirstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (total < MAX_HEADER_BYTES) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        break;
      }
      chunks.push(Buffer.from(chunk));
      total += read;
    }
    return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * Validate a caller-supplied session file for reopening against `root`.
 * Returns its real path; throws an Error with a caller-facing message.
 */
export function validateReopenSessionFile(sessionFile: unknown, root: string): string {
  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) {
    throw new Error(`sessionFile must be an absolute path: ${JSON.stringify(sessionFile) ?? String(sessionFile)}`);
  }
  let stat;
  try {
    stat = statSync(sessionFile);
  } catch {
    throw new Error(`sessionFile does not exist: "${sessionFile}"`);
  }
  if (!stat.isFile()) throw new Error(`sessionFile is not a regular file: "${sessionFile}"`);
  if (extname(sessionFile) !== ".jsonl") throw new Error(`sessionFile is not a .jsonl file: "${sessionFile}"`);

  // Real paths on both sides: a symlink cannot smuggle a file in from outside,
  // and a symlinked root (macOS /tmp) still contains its own files.
  const realFile = realpathSync(sessionFile);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = resolve(root);
  }
  if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
    throw new Error(`sessionFile is outside the subagent session directory "${realRoot}": "${sessionFile}"`);
  }

  let header: unknown;
  try {
    header = JSON.parse(readFirstLine(realFile));
  } catch {
    header = undefined;
  }
  if (typeof header !== "object" || header === null || (header as { type?: unknown }).type !== "session") {
    throw new Error(`sessionFile does not start with a Pi session header: "${sessionFile}"`);
  }
  const parent = (header as { parentSession?: unknown }).parentSession;
  if (typeof parent !== "string" || parent.length === 0) {
    throw new Error(`sessionFile is not a child session (its header has no parentSession): "${sessionFile}"`);
  }
  return realFile;
}
