#!/usr/bin/env node

import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises"
import path from "node:path"
import { isInside } from "./primitives.ts"
import process from "node:process"
import { performance } from "node:perf_hooks"

interface GateArguments {
  cwd: string
  root: string
  label: string
  logDir: string
  pretty: boolean
  timeoutMs: number
  command: string[]
}

interface GateResult {
  ok: boolean
  label: string
  commandSha256: string
  cwd: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  logPath: string
  logBytes: number
  logSha256: string
  timedOut: boolean
  error?: string
}

function parseArguments(argv: string[]): GateArguments {
  const options: { cwd: string | null; root: string | null; label: string | null; logDir: string | null; pretty: boolean; timeoutMs: number } = {
    cwd: null,
    root: null,
    label: null,
    logDir: null,
    pretty: false,
    timeoutMs: 30 * 60 * 1_000,
  }
  let index = 0
  for (; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") {
      index += 1
      break
    }
    if (argument === "--pretty") {
      options.pretty = true
      continue
    }
    if (["--cwd", "--root", "--label", "--log-dir", "--timeout-ms"].includes(argument)) {
      const value = argv[index + 1]
      if (!value || value === "--") throw new Error(`${argument} requires a value`)
      index += 1
      if (argument === "--cwd") options.cwd = value
      else if (argument === "--root") options.root = value
      else if (argument === "--label") options.label = value
      else if (argument === "--log-dir") options.logDir = value
      else {
        options.timeoutMs = Number(value)
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 2 * 60 * 60 * 1_000) {
          throw new Error("--timeout-ms must be between 1000 and 7200000")
        }
      }
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }

  const command = argv.slice(index)
  if (!options.cwd) throw new Error("--cwd is required")
  if (!options.logDir) throw new Error("--log-dir is required")
  if (!options.label) throw new Error("--label is required")
  if (command.length === 0) throw new Error("a command is required after --")
  return {
    cwd: options.cwd,
    root: options.root ?? options.cwd,
    logDir: options.logDir,
    pretty: options.pretty,
    timeoutMs: options.timeoutMs,
    label: safeLabel(options.label),
    command,
  }
}

const localeVariables = [
  "LANG",
  "LANGUAGE",
  "LC_ADDRESS",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NAME",
  "LC_NUMERIC",
  "LC_PAPER",
  "LC_TELEPHONE",
  "LC_TIME",
] as const

const windowsLaunchVariables = ["ComSpec", "PATHEXT", "SystemRoot", "WINDIR"] as const

function environmentName(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name
}

function setEnvironmentValue(environment: NodeJS.ProcessEnv, name: string, value: string): void {
  const normalizedName = environmentName(name)
  for (const existingName of Object.keys(environment)) {
    if (environmentName(existingName) === normalizedName) delete environment[existingName]
  }
  environment[name] = value
}

function gateEnvironment(environmentRoot: string): NodeJS.ProcessEnv {
  const retainedNames = process.platform === "win32"
    ? ["PATH", ...localeVariables, ...windowsLaunchVariables]
    : ["PATH", ...localeVariables]
  const allowedNames = new Set(retainedNames.map(environmentName))
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedNames.has(environmentName(name))) environment[name] = value
  }

  const temp = path.join(environmentRoot, "temp")
  const isolatedValues: Record<string, string> = {
    HOME: environmentRoot,
    XDG_CONFIG_HOME: path.join(environmentRoot, "config"),
    XDG_CACHE_HOME: path.join(environmentRoot, "cache"),
    XDG_DATA_HOME: path.join(environmentRoot, "data"),
    XDG_STATE_HOME: path.join(environmentRoot, "state"),
    XDG_RUNTIME_DIR: path.join(environmentRoot, "runtime"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
  }
  if (process.platform === "darwin") isolatedValues.CFFIXED_USER_HOME = environmentRoot
  if (process.platform === "win32") {
    const windowsHome = path.parse(environmentRoot)
    const homePath = path.relative(windowsHome.root, environmentRoot)
    isolatedValues.USERPROFILE = environmentRoot
    isolatedValues.APPDATA = path.join(environmentRoot, "appdata")
    isolatedValues.LOCALAPPDATA = path.join(environmentRoot, "localappdata")
    isolatedValues.HOMEDRIVE = windowsHome.root
    isolatedValues.HOMEPATH = homePath ? `${path.sep}${homePath}` : path.sep
  }
  for (const [name, value] of Object.entries(isolatedValues)) setEnvironmentValue(environment, name, value)
  return environment
}

async function createGateEnvironmentRoot(logDir: string): Promise<string> {
  const environmentRoot = await mkdtemp(path.join(logDir, ".gate-env-"))
  try {
    await Promise.all([
      "config",
      "cache",
      "data",
      "state",
      "runtime",
      "temp",
      "appdata",
      "localappdata",
    ].map((directory) => mkdir(path.join(environmentRoot, directory), { mode: 0o700 })))
    return environmentRoot
  } catch (error) {
    await rm(environmentRoot, { recursive: true, force: true })
    throw error
  }
}

function safeLabel(label: string): string {
  const normalized = label.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!normalized) throw new Error("--label must contain a letter, number, dot, underscore, or hyphen")
  return normalized.slice(0, 80)
}

async function resolveFuturePath(candidate: string): Promise<string> {
  let existing = candidate
  const missing = []
  while (true) {
    try {
      return path.join(await realpath(existing), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(existing)
      if (parent === existing) throw error
      missing.push(path.basename(existing))
      existing = parent
    }
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolve)
  })
  return hash.digest("hex")
}

function print(result: unknown, pretty = false): void {
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function cleanupGateEnvironmentRoot(environmentRoot: string): Promise<string | null> {
  try {
    await chmod(environmentRoot, 0o700)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    return errorMessage(error)
  }
  try {
    await rm(environmentRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

async function main(): Promise<void> {
  let parsed: GateArguments
  try {
    parsed = parseArguments(process.argv.slice(2))
  } catch (error) {
    print({ ok: false, phase: "arguments", error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
    return
  }

  const cwd = path.resolve(parsed.cwd)
  const root = path.resolve(parsed.root)
  const logDir = path.resolve(parsed.logDir)
  try {
    const rootStatus = await stat(root)
    if (!rootStatus.isDirectory()) throw new Error(`expected worktree root is not a directory: ${root}`)
    const cwdStatus = await stat(cwd)
    if (!cwdStatus.isDirectory()) throw new Error(`working directory is not a directory: ${cwd}`)
    const canonicalRoot = await realpath(root)
    if (isInside(canonicalRoot, await resolveFuturePath(logDir))) throw new Error("--log-dir must be outside the command worktree")
    await mkdir(logDir, { recursive: true })
    if (isInside(canonicalRoot, await realpath(logDir))) throw new Error("--log-dir must be outside the command worktree")
  } catch (error) {
    print({ ok: false, phase: "setup", error: error instanceof Error ? error.message : String(error) }, parsed.pretty)
    process.exitCode = 1
    return
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const logPath = path.join(logDir, `${parsed.label}-${stamp}-${randomUUID().slice(0, 8)}.log`)
  const logHandle = await open(logPath, "wx", 0o600)
  const started = performance.now()
  let environmentRoot: string | null = null
  let logClosed = false
  let cleanupError: string | null = null
  let childExitCode: number | null = null
  let childSignal: NodeJS.Signals | null = null
  let spawnError: Error | null = null
  let timedOut = false
  let spawnCwd = cwd
  let result: GateResult | null = null

  try {
    environmentRoot = await createGateEnvironmentRoot(logDir)
    try {
      const canonicalRoot = await realpath(root)
      spawnCwd = await realpath(cwd)
      if (!isInside(canonicalRoot, spawnCwd)) throw new Error(`working directory resolves outside expected worktree: ${spawnCwd}`)
      await new Promise<void>((resolve) => {
        const child = spawn(parsed.command[0]!, parsed.command.slice(1), {
          cwd: spawnCwd,
          env: gateEnvironment(environmentRoot!),
          detached: process.platform !== "win32",
          stdio: ["ignore", logHandle.fd, logHandle.fd],
        })
        let killTimer: NodeJS.Timeout | undefined
        const timeout = setTimeout(() => {
          timedOut = true
          try {
            if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
            else child.kill("SIGTERM")
          } catch {}
          killTimer = setTimeout(() => {
            try {
              if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
              else child.kill("SIGKILL")
            } catch {}
          }, 5_000)
          killTimer.unref()
        }, parsed.timeoutMs)
        timeout.unref()
        child.once("error", (error) => {
          spawnError = error
        })
        child.once("close", (code, signal) => {
          clearTimeout(timeout)
          if (killTimer) clearTimeout(killTimer)
          childExitCode = code
          childSignal = signal
          resolve()
        })
      })
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error))
    }

    await logHandle.close()
    logClosed = true
    const durationMs = Math.round(performance.now() - started)
    const logStatus = await stat(logPath)
    const ok = !spawnError && !timedOut && childExitCode === 0
    result = {
      ok,
      label: parsed.label,
      commandSha256: createHash("sha256").update(JSON.stringify(parsed.command)).digest("hex"),
      cwd: spawnCwd,
      exitCode: childExitCode,
      signal: childSignal,
      durationMs,
      logPath,
      logBytes: logStatus.size,
      logSha256: await sha256(logPath),
      timedOut,
    }
    if (timedOut) result.error = `command exceeded ${parsed.timeoutMs} ms`
    else if (spawnError) result.error = errorMessage(spawnError)
  } finally {
    if (!logClosed) {
      try {
        await logHandle.close()
        logClosed = true
      } catch (error) {
        cleanupError = errorMessage(error)
      }
    }
    if (environmentRoot) {
      const environmentError = await cleanupGateEnvironmentRoot(environmentRoot)
      if (environmentError) cleanupError = cleanupError ? `${cleanupError}; ${environmentError}` : environmentError
    }
  }

  if (!result) throw new Error("gate evidence was not finalized")
  if (cleanupError) {
    result.ok = false
    const message = `gate environment cleanup failed: ${cleanupError}`
    result.error = result.error ? `${result.error}; ${message}` : message
  }
  print(result, parsed.pretty)
  process.exitCode = result.ok ? 0 : 1
}

try {
  await main()
} catch (error) {
  print({ ok: false, phase: "runner", error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}
