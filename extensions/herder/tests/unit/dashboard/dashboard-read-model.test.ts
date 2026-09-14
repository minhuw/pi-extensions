import assert from "node:assert/strict"
import { createHash } from "node:crypto"
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
  assert.equal(firstResponse.headers["x-herder-revision"], "7")
  assert.equal(secondResponse.headers.etag, firstResponse.headers.etag)
  assert.equal(secondResponse.body, firstResponse.body)
  assert.equal(secondResponse.headers["x-herder-revision"], "7")

  const thirdResponse = response()
  await dashboard.handle(request("/api/state"), thirdResponse)
  assert.equal(builds, 1)
  assert.equal(thirdResponse.body, firstResponse.body)
  assert.equal(thirdResponse.headers["x-herder-revision"], "7")
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
  const conditional = request("/api/state")
  conditional.headers["if-none-match"] = `"${createHash("sha256").update('{"revision":1,"build":1}\n').digest("hex")}"`
  const first = dashboard.handle(conditional, firstResponse)
  const second = dashboard.handle(request("/api/state"), secondResponse)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(builds, 1)

  revision = 2
  releases.shift()!("stale")
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(builds, 2)
  releases.shift()!("current")
  await Promise.all([first, second])
  assert.equal(firstResponse.statusCode, 200)
  assert.notEqual(firstResponse.headers.etag, conditional.headers["if-none-match"])
  assert.equal(firstResponse.body, '{"revision":2,"build":2}\n')
  assert.equal(firstResponse.headers["x-herder-revision"], "2")
  assert.equal(secondResponse.headers.etag, firstResponse.headers.etag)
  assert.equal(secondResponse.body, firstResponse.body)
  assert.equal(secondResponse.headers["x-herder-revision"], "2")
})

test("revision changes update the body and header together", async () => {
  let revision = 1
  let builds = 0
  const dashboard = createDashboardHandler({
    revisionProvider: () => revision,
    stateBodyProvider: () => {
      builds += 1
      return `{"revision":${revision},"build":${builds}}\n`
    },
  })

  const firstResponse = response()
  await dashboard.handle(request("/api/state"), firstResponse)
  assert.equal(firstResponse.body, '{"revision":1,"build":1}\n')
  assert.equal(firstResponse.headers["x-herder-revision"], "1")

  revision = 2
  const secondResponse = response()
  await dashboard.handle(request("/api/state"), secondResponse)
  assert.equal(secondResponse.body, '{"revision":2,"build":2}\n')
  assert.equal(secondResponse.headers["x-herder-revision"], "2")
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
  assert.equal(firstBody.headers["x-herder-revision"], undefined)
  const cachedBody = response()
  await first.handle(request("/api/state"), cachedBody)
  assert.equal(firstBuilds, 1)
  assert.equal(cachedBody.body, firstBody.body)
  assert.equal(cachedBody.headers["x-herder-revision"], undefined)

  now = 999
  const stillCached = response()
  await first.handle(request("/api/state"), stillCached)
  assert.equal(firstBuilds, 1)
  assert.equal(stillCached.headers["x-herder-revision"], undefined)
  now = 1000
  const refreshedBody = response()
  await first.handle(request("/api/state"), refreshedBody)
  assert.equal(firstBuilds, 2)
  assert.notEqual(refreshedBody.body, firstBody.body)
  assert.equal(refreshedBody.headers["x-herder-revision"], undefined)

  const secondBody = response()
  await second.handle(request("/api/state"), secondBody)
  assert.equal(secondBuilds, 1)
  assert.match(secondBody.body, /"instance":"second"/)
  assert.equal(secondBody.headers["x-herder-revision"], undefined)
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
  assert.equal(secondResponse.headers.etag, firstResponse.headers.etag)
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

test("conditional GET and HEAD use weak representation comparison and reject malformed lists", async () => {
  const dashboard = createDashboardHandler({ revisionProvider: () => 7, stateProvider: () => ({ ok: true }) })
  const initial = response()
  await dashboard.handle(request("/api/state"), initial)
  const etag = String(initial.headers.etag)
  assert.match(etag, /^"[a-f0-9]{64}"$/)
  for (const method of ["GET", "HEAD"]) {
    for (const condition of [etag, `W/${etag}`, `"other", W/${etag}`, `"comma,inside", ${etag}`, ` , ${etag}, `, "*"]) {
      const output = response()
      const input = request("/api/state")
      input.method = method
      input.headers["if-none-match"] = condition
      await dashboard.handle(input, output)
      assert.equal(output.statusCode, 304, condition)
      assert.equal(output.body, "")
      assert.equal(output.headers["content-length"], undefined)
      assert.equal(output.headers.etag, etag)
      assert.equal(output.headers["x-herder-revision"], "7")
      assert.equal(output.headers["cache-control"], "no-store")
      assert.equal(output.headers["x-frame-options"], "DENY")
    }
    for (const condition of ["", "*\n", '"other"', etag.slice(1, -1), `w/${etag}`, `${etag}, garbage`, `${etag}, *`, `${etag} trailing`, `${etag}\n`, `\u00a0${etag}`,  `"unterminated, ${etag}`, `"bad\nvalue", ${etag}`]) {
      const output = response()
      const input = request("/api/state")
      input.method = method
      input.headers["if-none-match"] = condition
      await dashboard.handle(input, output)
      assert.equal(output.statusCode, 200, condition)
      assert.equal(output.body, method === "HEAD" ? "" : initial.body)
      assert.equal(output.headers["content-length"], Buffer.byteLength(initial.body))
    }
  }
})

test("malformed empty-member lists do not stall validator handling", async () => {
  const dashboard = createDashboardHandler({ revisionProvider: () => 1, stateProvider: () => ({ ok: true }) })
  const initial = response()
  await dashboard.handle(request("/api/state"), initial)
  for (const prefix of ["", `${initial.headers.etag}, `]) {
    const input = request("/api/state")
    input.headers["if-none-match"] = `${prefix}${", ".repeat(24)}x`
    const output = response()
    const started = performance.now()
    await dashboard.handle(input, output)
    const elapsed = performance.now() - started
    assert.equal(output.statusCode, 200)
    assert.equal(output.body, initial.body)
    assert.ok(elapsed < 500, `malformed validator blocked handling for ${elapsed}ms`)
  }
})

test("validators identify bodies across equal-revision instances and failures cannot return 304", async () => {
  let revision = 1
  let fail = false
  const first = createDashboardHandler({ revisionProvider: () => revision, stateBodyProvider: () => {
    if (fail) throw new Error("offline")
    return '{"instance":1}\n'
  } })
  const initial = response()
  await first.handle(request("/api/state"), initial)
  const conditional = request("/api/state")
  conditional.headers["if-none-match"] = String(initial.headers.etag)
  const second = createDashboardHandler({ revisionProvider: () => 1, stateProvider: () => ({ instance: 2 }) })
  const changed = response()
  await second.handle(conditional, changed)
  assert.equal(changed.statusCode, 200)
  assert.notEqual(changed.headers.etag, initial.headers.etag)
  revision++
  fail = true
  for (const condition of [String(initial.headers.etag), "*"]) {
    conditional.headers["if-none-match"] = condition
    const unavailable = response()
    await first.handle(conditional, unavailable)
    assert.equal(unavailable.statusCode, 503)
    assert.equal(unavailable.headers.etag, undefined)
  }
  fail = false
  const recovered = response()
  await first.handle(conditional, recovered)
  assert.equal(recovered.statusCode, 304)
})

test("conditional fallback expires locally and refreshes before evaluating its validator", async () => {
  let now = 0
  let builds = 0
  const dashboard = createDashboardHandler({ clock: () => now, stateProvider: () => ({ build: ++builds }) })
  const initial = response()
  await dashboard.handle(request("/api/state"), initial)
  const input = request("/api/state")
  input.headers["if-none-match"] = String(initial.headers.etag)
  now = 999
  const cached = response()
  await dashboard.handle(input, cached)
  assert.equal(cached.statusCode, 304)
  assert.equal(builds, 1)
  now = 1000
  const refreshed = response()
  await dashboard.handle(input, refreshed)
  assert.equal(refreshed.statusCode, 200)
  assert.notEqual(refreshed.headers.etag, initial.headers.etag)
  assert.equal(builds, 2)
})
