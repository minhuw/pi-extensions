import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import type { SpawnSyncReturns } from "node:child_process"

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024

type RunGitCommonOptions = {
  allowFailure?: boolean
  allowStatus?: readonly number[]
  maxBuffer?: number
  input?: string | Buffer
  failureFormatter?: (args: readonly string[], stderr: string, stdout: string) => string
  failureBufferFormatter?: (args: readonly string[], stderr: Buffer, stdout: Buffer) => string
  spawnErrorFormatter?: (error: Error) => string
}

export type RunGitTextOptions = RunGitCommonOptions & {
  encoding?: "utf8"
}

export type RunGitBufferOptions = RunGitCommonOptions & {
  encoding: null
}

export function fail(message: string): never {
  throw new Error(message)
}

export function runGit(repoRoot: string, args: string[], options?: RunGitTextOptions): SpawnSyncReturns<string>
export function runGit(repoRoot: string, args: string[], options: RunGitBufferOptions): SpawnSyncReturns<Buffer>
export function runGit(
  repoRoot: string,
  args: string[],
  options: RunGitTextOptions | RunGitBufferOptions = {},
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const {
    allowFailure = false,
    allowStatus = [],
    maxBuffer = DEFAULT_MAX_BUFFER,
    input,
  } = options
  const encoding = options.encoding === undefined ? "utf8" : options.encoding
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding,
    maxBuffer,
    ...(input === undefined ? {} : { input }),
  } as any) as SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>

  if (result.error) {
    fail(options.spawnErrorFormatter?.(result.error) ?? `Cannot run git: ${result.error.message}`)
  }
  if (result.status !== 0 && !allowFailure && (result.status === null || !allowStatus.includes(result.status))) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr || ""
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout || ""
    const message = options.encoding === null && options.failureBufferFormatter
      ? options.failureBufferFormatter(
        args,
        Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || "", "utf8"),
        Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "", "utf8"),
      )
      : options.failureFormatter
        ? options.failureFormatter(args, stderr, stdout)
        : `git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`
    fail(message)
  }
  return result
}

export function isInside(parent: string, candidate: string, { allowEqual = true }: { allowEqual?: boolean } = {}): boolean {
  const relative = path.relative(parent, candidate)
  if (relative === "") return allowEqual
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function realpathIfPresent(candidate: string): string {
  try { return fs.realpathSync(candidate) }
  catch { return path.resolve(candidate) }
}
