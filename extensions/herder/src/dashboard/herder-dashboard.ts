#!/usr/bin/env node

import fs from "node:fs"
import http from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { buildDashboardState } from "./dashboard-state.ts"
import { describeDashboardHostAccess, enableDashboardHostAccess } from "./dashboard-host.ts"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.resolve(SCRIPT_DIR, "../../assets/dashboard")
const LOOPBACK_HOST = "127.0.0.1"
const DEFAULT_PORT = 4173
const STATE_CACHE_MS = 1000
const ASSETS = new Map<string, { file: string; type: string }>([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/dashboard.css", { file: "dashboard.css", type: "text/css; charset=utf-8" }],
  ["/dashboard.js", { file: "dashboard.js", type: "text/javascript; charset=utf-8" }],
])

export interface DashboardOptions {
  planDir: string
  planName: string | null
  port: number
  snapshot: boolean
  pretty: boolean
  hostIntegration: boolean
  help: boolean
}
interface DashboardHandlerInput {
  planDir?: string
  planName?: string | null
  stateProvider?: () => unknown
}
interface DashboardServerInput extends DashboardHandlerInput { port?: number }
interface DashboardServerResult {
  host: string
  port: number
  url: string
  server: Server
  allowHost: (value: unknown) => void
  close: () => Promise<void>
}

function fail(message: string): never {
  throw new Error(message)
}

function takeValue(args: string[], index: number, name: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`)
  return value
}

export function parseDashboardArguments(argv: string[]): DashboardOptions {
  const options: DashboardOptions = {
    planDir: "herder-plans",
    planName: null,
    port: DEFAULT_PORT,
    snapshot: false,
    pretty: false,
    hostIntegration: true,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--snapshot") options.snapshot = true
    else if (argument === "--pretty") options.pretty = true
    else if (argument === "--no-host-integration") options.hostIntegration = false
    else if (["--help", "-h"].includes(argument)) options.help = true
    else if (["--plan-dir", "--plan-name", "--port"].includes(argument)) {
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === "--plan-dir") options.planDir = value
      else if (argument === "--plan-name") options.planName = value
      else {
        if (!/^\d+$/.test(value)) fail("--port must be an integer from 0 through 65535")
        options.port = Number.parseInt(value, 10)
        if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) {
          fail("--port must be an integer from 0 through 65535")
        }
      }
    } else {
      fail(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function usage(): string {
  return [
    "Usage:",
    "  herder-dashboard [--plan-dir <path>] [--plan-name <name>] [--port <0..65535>] [--no-host-integration]",
    "  herder-dashboard --snapshot [--plan-dir <path>] [--plan-name <name>] [--pretty]",
    "",
    `The server binds only to ${LOOPBACK_HOST}. Use --port 0 to select an available port.`,
  ].join("\n")
}

function securityHeaders(contentType: string, cacheControl = "no-store"): Record<string, string> {
  return {
    "Cache-Control": cacheControl,
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  }
}

function canonicalHost(value: unknown): string | null {
  try {
    return new URL(`http://${String(value ?? "")}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

function acceptsLoopbackHost(value: unknown, allowedHosts: Set<string>): boolean {
  const host = canonicalHost(value)
  return host !== null && (["127.0.0.1", "localhost", "[::1]"].includes(host) || allowedHosts.has(host))
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
  method: string,
  cacheControl = "no-store",
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body)
  response.writeHead(status, {
    ...securityHeaders(contentType, cacheControl),
    "Content-Length": payload.length,
  })
  if (method === "HEAD") response.end()
  else response.end(payload)
}

function readAssets(): Map<string, { file: string; type: string; content: Buffer }> {
  return new Map([...ASSETS.entries()].map(([route, asset]) => {
    const file = path.join(ASSET_DIR, asset.file)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`Dashboard asset is missing: ${file}`)
    return [route, { ...asset, content: fs.readFileSync(file) }]
  }))
}

export function createDashboardHandler(input: DashboardHandlerInput = {}) {
  const planDir = path.resolve(input.planDir ?? "herder-plans")
  const planName = input.planName ?? null
  const stateProvider = input.stateProvider ?? (() => buildDashboardState({ planDir, planName }))
  const allowedHosts = new Set<string>()
  const assets = readAssets()
  let cachedStateBody = ""
  let stateExpiresAt = 0
  const stateBody = (): string => {
    const now = Date.now()
    if (cachedStateBody && now < stateExpiresAt) return cachedStateBody
    cachedStateBody = `${JSON.stringify(stateProvider())}\n`
    stateExpiresAt = now + STATE_CACHE_MS
    return cachedStateBody
  }
  stateBody()

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const method = request.method ?? "GET"
    if (!acceptsLoopbackHost(request.headers.host, allowedHosts)) {
      send(response, 421, JSON.stringify({ error: "invalid-host" }), "application/json; charset=utf-8", method)
      return
    }
    if (!new Set(["GET", "HEAD"]).has(method)) {
      response.setHeader("Allow", "GET, HEAD")
      send(response, 405, JSON.stringify({ error: "method-not-allowed" }), "application/json; charset=utf-8", method)
      return
    }
    let pathname
    try {
      pathname = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`).pathname
    } catch {
      send(response, 400, JSON.stringify({ error: "invalid-request-url" }), "application/json; charset=utf-8", method)
      return
    }
    if (pathname === "/api/state") {
      try {
        send(response, 200, stateBody(), "application/json; charset=utf-8", method)
      } catch (error) {
        send(response, 503, `${JSON.stringify({ error: "snapshot-unavailable", message: error instanceof Error ? error.message : String(error) })}\n`, "application/json; charset=utf-8", method)
      }
      return
    }
    if (pathname === "/api/health") {
      send(response, 200, `${JSON.stringify({ ok: true, readOnly: true })}\n`, "application/json; charset=utf-8", method)
      return
    }
    const asset = assets.get(pathname)
    if (asset) {
      send(response, 200, asset.content, asset.type, method, "no-cache")
      return
    }
    send(response, 404, JSON.stringify({ error: "not-found" }), "application/json; charset=utf-8", method)
  }

  const allowHost = (value: unknown): void => {
    const host = canonicalHost(value)
    if (host) allowedHosts.add(host)
  }
  return { handle, allowHost }
}

export async function createDashboardServer(input: DashboardServerInput = {}): Promise<DashboardServerResult> {
  const port = input.port ?? DEFAULT_PORT
  const dashboard = createDashboardHandler(input)
  const server = http.createServer(dashboard.handle)

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, LOOPBACK_HOST, resolve)
  })
  const address = server.address() as AddressInfo | string | null
  if (!address || typeof address === "string") {
    server.close()
    fail("Dashboard server did not receive a TCP address")
  }
  const url = `http://${LOOPBACK_HOST}:${address.port}/`
  return {
    host: LOOPBACK_HOST,
    port: address.port,
    url,
    server,
    allowHost: dashboard.allowHost,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function main(argv: string[]): Promise<void> {
  const options = parseDashboardArguments(argv)
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (options.snapshot) {
    const state = buildDashboardState(options)
    process.stdout.write(`${JSON.stringify(state, null, options.pretty ? 2 : 0)}\n`)
    return
  }
  const dashboard = await createDashboardServer(options)
  const stop = async () => {
    await dashboard.close()
    process.exitCode = 0
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  process.stdout.write([
    "Herder Dashboard — read-only local observer",
    `URL: ${dashboard.url}`,
    `Plan directory: ${path.resolve(options.planDir)}`,
    "Press Ctrl+C to stop.",
  ].join("\n"))
  if (options.hostIntegration) {
    const access = await enableDashboardHostAccess({ url: dashboard.url })
    for (const line of describeDashboardHostAccess(access)) process.stdout.write(`\n${line}`)
  }
  process.stdout.write("\n")
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`herder-dashboard: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
