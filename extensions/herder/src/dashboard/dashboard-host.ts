import { spawn } from "node:child_process"
import process from "node:process"

const COMMAND_OUTPUT_LIMIT = 16 * 1024
const COMMAND_TIMEOUT_MS = 5000

export interface DashboardEnvironment {
  kind: "orca" | "terminal"
}

export interface HostCommandResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  error: string | null
}

export interface DashboardHostAccess {
  environment: DashboardEnvironment
  attempted: boolean
  opened: boolean
  targetUrl: string
  error: string | null
}

type Environment = NodeJS.ProcessEnv
type RunCommand = (command: string, args: string[], options?: { env?: Environment; timeoutMs?: number }) => Promise<HostCommandResult>

function present(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function dashboardOpeningDisabled(env: Environment): boolean {
  return present(env.NODE_TEST_CONTEXT) && env.HERDER_ALLOW_TEST_DASHBOARD_OPEN !== "1"
}

export function detectDashboardEnvironment(env: Environment = process.env): DashboardEnvironment {
  const terminal = String(env.TERM_PROGRAM ?? "").toLowerCase()
  const orca = terminal === "orca"
    || present(env.ORCA_PI_STATUS_OWNED)
    || present(env.ORCA_WORKTREE_ID)
    || present(env.ORCA_PANE_KEY)
    || present(env.ORCA_TERMINAL_HANDLE)
    || present(env.ORCA_ENVIRONMENT)
    || present(env.ORCA_PAIRING_CODE)
    || present(env.ORCA_CLI_COMMAND)
    || present(env.ORCA_DEV_REPO_ROOT)
  return { kind: orca ? "orca" : "terminal" }
}

export function resolveOrcaCommand(env: Environment = process.env, platform = process.platform): string {
  if (present(env.ORCA_CLI_COMMAND)) return env.ORCA_CLI_COMMAND
  if (present(env.ORCA_DEV_REPO_ROOT)) return "orca-dev"
  if (platform === "linux" && detectDashboardEnvironment(env).kind !== "orca") return "orca-ide"
  return "orca"
}

export function runHostCommand(command: string, args: string[], options: { env?: Environment; timeoutMs?: number } = {}): Promise<HostCommandResult> {
  const env = options.env ?? process.env
  return new Promise<HostCommandResult>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let stdout = ""
    let stderr = ""
    const finish = (result: HostCommandResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, code: null, stdout, stderr, error: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout!.setEncoding("utf8")
    child.stderr!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => {
      if (stdout.length < COMMAND_OUTPUT_LIMIT) stdout += chunk.slice(0, COMMAND_OUTPUT_LIMIT - stdout.length)
    })
    child.stderr!.on("data", (chunk: string) => {
      if (stderr.length < COMMAND_OUTPUT_LIMIT) stderr += chunk.slice(0, COMMAND_OUTPUT_LIMIT - stderr.length)
    })
    timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, code: null, stdout, stderr, error: "host command timed out" })
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    child.once("error", (error) => finish({ ok: false, code: null, stdout, stderr, error: error.message }))
    child.once("close", (code) => finish({
      ok: code === 0,
      code,
      stdout,
      stderr,
      error: code === 0 ? null : (stderr.trim() || `command exited ${code}`),
    }))
  })
}

function compactError(result: HostCommandResult): string {
  return String(result.error ?? "host command failed").replace(/\s+/g, " ").trim().slice(0, 240)
}

export async function enableDashboardHostAccess(input: {
  url: string
  env?: Environment
  platform?: NodeJS.Platform
  runCommand?: RunCommand
}): Promise<DashboardHostAccess> {
  const env = input.env ?? process.env
  const environment = detectDashboardEnvironment(env)
  if (dashboardOpeningDisabled(env) || environment.kind === "terminal") {
    return { environment, attempted: false, opened: false, targetUrl: input.url, error: null }
  }

  const command = resolveOrcaCommand(env, input.platform ?? process.platform)
  const result = await (input.runCommand ?? runHostCommand)(command, ["tab", "create", "--url", input.url, "--json"], { env })
  return {
    environment,
    attempted: true,
    opened: result.ok,
    targetUrl: input.url,
    error: result.ok ? null : compactError(result),
  }
}

export function describeDashboardHostAccess(access: DashboardHostAccess): string[] {
  if (!access.attempted) return []
  return [access.opened
    ? "Host integration: opened in Orca's workspace browser"
    : `Host integration: Orca browser unavailable (${access.error})`]
}
