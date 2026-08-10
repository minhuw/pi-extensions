import assert from "node:assert/strict"
import type { IncomingMessage, ServerResponse } from "node:http"
import test from "node:test"
import { createDashboardHandler } from "../../../src/dashboard/herder-dashboard.ts"

type FakeResponse = ServerResponse & {
  statusCode: number
  headers: Record<string, string | number>
  body: string
}

function response(): FakeResponse {
  const headers: Record<string, string | number> = {}
  const output: {
    statusCode: number
    headers: Record<string, string | number>
    body: string
    destroyed: boolean
    writableEnded: boolean
    setHeader: (name: string, value: string | number) => void
    writeHead: (status: number, values: Record<string, string | number>) => void
    end: (body?: string | Buffer) => void
  } = {
    statusCode: 0,
    headers,
    body: "",
    destroyed: false,
    writableEnded: false,
    setHeader(name, value): void {
      headers[name.toLowerCase()] = value
    },
    writeHead(status, values): void {
      output.statusCode = status
      for (const [name, value] of Object.entries(values)) headers[name.toLowerCase()] = value
    },
    end(body): void {
      output.body = body === undefined ? "" : Buffer.from(body).toString("utf8")
      output.writableEnded = true
    },
  }
  return output as unknown as FakeResponse
}

function request(url: string): IncomingMessage {
  return { method: "GET", headers: { host: "127.0.0.1" }, url } as IncomingMessage
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

test("same revision coalesces concurrent projections and reuses the exact body", async () => {
  let revision = 7
  let builds = 0
  const releases: Array<(body: string) => void> = []
  const dashboard = createDashboardHandler({
    revisionProvider: () => revision,
    stateBodyProvider: () => {
      builds += 1
      const body = `{"revision":${revision},"build":${builds}}\n`
      return new Promise<string>((resolve) => releases.push(() => resolve(body)))
    },
  })

  const firstResponse = response()
  const secondResponse = response()
  const first = dashboard.handle(request("/api/state"), firstResponse)
  const second = dashboard.handle(request("/api/state"), secondResponse)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(builds, 1)
  releases.shift()!("ignored")
  await Promise.all([first, second])
  assert.equal(firstResponse.body, '{"revision":7,"build":1}\n')
  assert.equal(secondResponse.body, firstResponse.body)

  const thirdResponse = response()
  await dashboard.handle(request("/api/state"), thirdResponse)
  assert.equal(builds, 1)
  assert.equal(thirdResponse.body, firstResponse.body)
})

test("revision rollover during a projection discards the stale body and retries", async () => {
  let revision = 1
  let builds = 0
  const releases: Array<(body: string) => void> = []
  const dashboard = createDashboardHandler({
    revisionProvider: () => revision,
    stateBodyProvider: () => {
      builds += 1
      const body = `{"revision":${revision},"build":${builds}}\n`
      return new Promise<string>((resolve) => releases.push(() => resolve(body)))
    },
  })

  const firstResponse = response()
  const secondResponse = response()
  const first = dashboard.handle(request("/api/state"), firstResponse)
  const second = dashboard.handle(request("/api/state"), secondResponse)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(builds, 1)

  revision = 2
  releases.shift()!("stale")
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(builds, 2)
  releases.shift()!("current")
  await Promise.all([first, second])
  assert.equal(firstResponse.body, '{"revision":2,"build":2}\n')
  assert.equal(secondResponse.body, firstResponse.body)
})

test("no-revision fallback uses the injected clock and remains instance-local", async () => {
  let now = 0
  let firstBuilds = 0
  let secondBuilds = 0
  const first = createDashboardHandler({
    clock: () => now,
    stateBodyProvider: () => {
      firstBuilds += 1
      return `{"instance":"first","build":${firstBuilds}}\n`
    },
  })
  const second = createDashboardHandler({
    clock: () => now,
    stateBodyProvider: () => {
      secondBuilds += 1
      return `{"instance":"second","build":${secondBuilds}}\n`
    },
  })

  assert.equal(firstBuilds, 0)
  const firstBody = response()
  await first.handle(request("/api/state"), firstBody)
  assert.equal(firstBuilds, 1)
  const cachedBody = response()
  await first.handle(request("/api/state"), cachedBody)
  assert.equal(firstBuilds, 1)
  assert.equal(cachedBody.body, firstBody.body)

  now = 999
  await first.handle(request("/api/state"), response())
  assert.equal(firstBuilds, 1)
  now = 1000
  const refreshedBody = response()
  await first.handle(request("/api/state"), refreshedBody)
  assert.equal(firstBuilds, 2)
  assert.notEqual(refreshedBody.body, firstBody.body)

  const secondBody = response()
  await second.handle(request("/api/state"), secondBody)
  assert.equal(secondBuilds, 1)
  assert.match(secondBody.body, /"instance":"second"/)
})

test("slow no-revision projections are accepted and coalesced", async () => {
  let now = 0
  let builds = 0
  const dashboard = createDashboardHandler({
    clock: () => now,
    stateBodyProvider: () => {
      builds += 1
      now += 1000
      return `{"build":${builds}}\n`
    },
  })

  const firstResponse = response()
  const secondResponse = response()
  await Promise.all([
    dashboard.handle(request("/api/state"), firstResponse),
    dashboard.handle(request("/api/state"), secondResponse),
  ])
  assert.equal(builds, 1)
  assert.equal(firstResponse.body, '{"build":1}\n')
  assert.equal(secondResponse.body, firstResponse.body)

  now = 1999
  await dashboard.handle(request("/api/state"), response())
  assert.equal(builds, 1)

  now = 2000
  const refreshedResponse = response()
  await dashboard.handle(request("/api/state"), refreshedResponse)
  assert.equal(builds, 2)
  assert.equal(refreshedResponse.body, '{"build":2}\n')
})

test("health is served while a dashboard projection is awaiting its worker", async () => {
  const started = deferred<void>()
  const projection = deferred<string>()
  const dashboard = createDashboardHandler({
    stateBodyProvider: () => {
      started.resolve()
      return projection.promise
    },
  })

  const stateResponse = response()
  const state = dashboard.handle(request("/api/state"), stateResponse)
  await started.promise

  const healthResponse = response()
  await dashboard.handle(request("/api/health"), healthResponse)
  assert.equal(healthResponse.statusCode, 200)
  assert.deepEqual(JSON.parse(healthResponse.body), { ok: true, readOnly: true })

  projection.resolve('{"ok":true}\n')
  await state
  assert.equal(stateResponse.body, '{"ok":true}\n')
})
