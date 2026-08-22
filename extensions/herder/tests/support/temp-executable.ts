import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

export interface TemporaryExecutableOptions {
  prefix: string
  name?: string
  script: string
}

export function withTemporaryExecutableOnPath<T>(
  { prefix, name = "git", script }: TemporaryExecutableOptions,
  callback: () => T,
): T {
  const originalPath = process.env.PATH
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const executable = path.join(directory, name)
  try {
    fs.writeFileSync(executable, script)
    fs.chmodSync(executable, 0o755)
    process.env.PATH = originalPath === undefined
      ? directory
      : `${directory}${path.delimiter}${originalPath}`
    return callback()
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
