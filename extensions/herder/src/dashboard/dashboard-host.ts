import { spawn } from "node:child_process"
import process from "node:process"

const COMMAND_OUTPUT_LIMIT = 16 * 1024
const COMMAND_TIMEOUT_MS = 5000

export interface DashboardEnvironment {
  kind: "orca" | "vscode" | "terminal"
  remote: boolean
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
  forwardedUrl: string | null
  error: string | null
}

type Environment = NodeJS.ProcessEnv
type RunCommand = (command: string, args: string[], options?: { env?: Environment; timeoutMs?: number }) => Promise<HostCommandResult>

function present(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function detectDashboardEnvironment(env: Environment = process.env): DashboardEnvironment {
  const terminal = String(env.TERM_PROGRAM ?? "").toLowerCase()
  const orca = terminal === "orca"
    || present(env.ORCA_WORKTREE_ID)
    || present(env.ORCA_PANE_KEY)
    || present(env.ORCA_TERMINAL_HANDLE)
  if (orca) {
    return {
      kind: "orca",
      remote: present(env.ORCA_ENVIRONMENT)
        || present(env.ORCA_PAIRING_CODE)
        || present(env.ORCA_CLI_COMMAND)
        || present(env.SSH_CONNECTION),
    }
  }

  const vscode = terminal === "vscode"
    || present(env.VSCODE_IPC_HOOK_CLI)
    || present(env.VSCODE_REMOTE_NAME)
    || present(env.REMOTE_CONTAINERS)
    || present(env.CODESPACES)
  if (vscode) {
    return {
      kind: "vscode",
      remote: present(env.VSCODE_REMOTE_NAME)
        || present(env.REMOTE_CONTAINERS)
        || present(env.CODESPACES)
        || present(env.SSH_CONNECTION)
        || present(env.WSL_DISTRO_NAME),
    }
  }
  return { kind: "terminal", remote: false }
}

export function resolveVSCodeProxyUrl(localUrl: string, env: Environment = process.env): string | null {
  const template = env.VSCODE_PROXY_URI
  if (!present(template)) return null
  const port = new URL(localUrl).port
  if (!port || !/(?:\{\{port\}\}|\$\{port\})/.test(template)) return null
  const candidate = template
    .replaceAll("{{port}}", port)
    .replaceAll("${port}", port)
  try {
    const url = new URL(candidate)
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

export function resolveOrcaCommand(env: Environment = process.env, platform = process.platform): string {
  if (present(env.ORCA_CLI_COMMAND)) return env.ORCA_CLI_COMMAND
  if (present(env.ORCA_DEV_REPO_ROOT)) return "orca-dev"
  if (platform === "linux" && String(env.TERM_PROGRAM ?? "").toLowerCase() !== "orca") return "orca-ide"
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
  allowHost?: (host: string) => void
}): Promise<DashboardHostAccess> {
  const env = input.env ?? process.env
  const environment = detectDashboardEnvironment(env)
  const runCommand = input.runCommand ?? runHostCommand
  if (environment.kind === "terminal") {
    return { environment, attempted: false, opened: false, targetUrl: input.url, forwardedUrl: null, error: null }
  }

  if (environment.kind === "orca") {
    const targetUrl = input.url
    const command = resolveOrcaCommand(env, input.platform ?? process.platform)
    const result = await runCommand(command, ["tab", "create", "--url", targetUrl, "--json"], { env })
    return {
      environment,
      attempted: true,
      opened: result.ok,
      targetUrl,
      forwardedUrl: null,
      error: result.ok ? null : compactError(result),
    }
  }

  const forwardedUrl = resolveVSCodeProxyUrl(input.url, env)
  if (forwardedUrl && input.allowHost) input.allowHost(new URL(forwardedUrl).host)
  const targetUrl = forwardedUrl ?? input.url.replace("127.0.0.1", "localhost")
  const result = await runCommand("code", ["--open-url", targetUrl], { env })
  return {
    environment,
    attempted: true,
    opened: result.ok,
    targetUrl,
    forwardedUrl,
    error: result.ok ? null : compactError(result),
  }
}

export function describeDashboardHostAccess(access: DashboardHostAccess): string[] {
  if (!access.attempted) return []
  if (access.environment.kind === "orca") {
    return [access.opened
      ? "Host integration: opened in Orca's workspace browser"
      : `Host integration: Orca browser unavailable (${access.error})`]
  }
  const label = access.environment.remote ? "VS Code Remote" : "VS Code"
  const lines = [access.opened
    ? `Host integration: opened through ${label}`
    : `Host integration: ${label} forwarding unavailable (${access.error})`]
  if (access.forwardedUrl) lines.push(`Forwarded URL: ${access.forwardedUrl}`)
  return lines
}
