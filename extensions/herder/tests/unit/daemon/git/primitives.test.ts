import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fail, isInside, realpathIfPresent, runGit, takeValue } from "../../../../src/daemon/git/primitives.ts"

function temporaryRepository(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-git-primitives-"))
  const repo = path.join(root, "repo")
  fs.mkdirSync(repo)
  runGit(repo, ["init", "-q"])
  return { root, repo }
}

test("isInside handles containment edges and strict descendants", () => {
  const root = path.join(os.tmpdir(), "herder-primitives-root")
  assert.equal(isInside(root, root), true)
  assert.equal(isInside(root, path.join(root, "child")), true)
  assert.equal(isInside(root, path.join(root, "..")), false)
  assert.equal(isInside(root, path.join(root, "..", "escape")), false)
  assert.equal(isInside(root, `${root}-sibling`), false)
  assert.equal(isInside(root, root, { allowEqual: false }), false)
})

test("takeValue rejects missing and flag values", () => {
  assert.equal(takeValue(["--name", "value"], 0, "--name"), "value")
  assert.throws(() => takeValue(["--name"], 0, "--name"), /--name requires a value/)
  assert.throws(() => takeValue(["--name", "--other"], 0, "--name"), /--name requires a value/)
})

test("realpathIfPresent falls back for missing paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-git-primitives-path-"))
  try {
    const existing = path.join(root, "existing")
    fs.mkdirSync(existing)
    assert.equal(realpathIfPresent(existing), fs.realpathSync(existing))
    const missing = path.join(root, "missing", "child")
    assert.equal(realpathIfPresent(missing), path.resolve(missing))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("fail preserves the supplied error message", () => {
  assert.throws(() => fail("primitive failure"), { message: "primitive failure" })
})

test("runGit returns UTF-8 output and rejects failures by default", () => {
  const { root, repo } = temporaryRepository()
  try {
    const result = runGit(repo, ["rev-parse", "--is-inside-work-tree"])
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), "true")
    assert.throws(
      () => runGit(repo, ["rev-parse", "--verify", "refs/heads/missing"]),
      /git rev-parse --verify refs\/heads\/missing failed:/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("runGit supports allowFailure and allowStatus", () => {
  const { root, repo } = temporaryRepository()
  try {
    const allowedFailure = runGit(repo, ["rev-parse", "--verify", "refs/heads/missing"], { allowFailure: true })
    assert.equal(allowedFailure.status, 128)
    const allowedStatus = runGit(repo, ["rev-parse", "--verify", "refs/heads/missing"], { allowStatus: [128] })
    assert.equal(allowedStatus.status, 128)
    assert.throws(
      () => runGit(repo, ["rev-parse", "--verify", "refs/heads/missing"], { allowStatus: [1] }),
      /git rev-parse --verify refs\/heads\/missing failed:/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("runGit supports call-site failure formatting for text and Buffer output", () => {
  const { root, repo } = temporaryRepository()
  const bin = path.join(root, "bin")
  const fakeGit = path.join(bin, "git")
  fs.mkdirSync(bin)
  fs.writeFileSync(fakeGit, "#!/bin/sh\nprintf 'STDERR-PART' >&2\nprintf 'STDOUT-PART'\nexit 7\n")
  fs.chmodSync(fakeGit, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`
  try {
    assert.throws(
      () => runGit(repo, ["fake"], {
        failureFormatter: (_args, stderr, stdout) => (stderr || stdout || "git failed").trim(),
      }),
      { message: "STDERR-PART" },
    )
    assert.throws(
      () => runGit(repo, ["fake"], {
        encoding: null,
        failureFormatter: (_args, stderr, stdout) => (stderr + stdout).trim(),
      }),
      { message: "STDERR-PARTSTDOUT-PART" },
    )
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("runGit can preserve raw Buffer ordering for failure formatting", () => {
  const { root, repo } = temporaryRepository()
  const bin = path.join(root, "bin")
  const fakeGit = path.join(bin, "git")
  fs.mkdirSync(bin)
  fs.writeFileSync(fakeGit, "#!/bin/sh\nprintf '\\342' >&2\nprintf '\\202\\254'\nexit 7\n")
  fs.chmodSync(fakeGit, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`
  try {
    assert.throws(
      () => runGit(repo, ["fake"], {
        encoding: null,
        failureBufferFormatter: (_args, stderr, stdout) => Buffer.concat([stderr, stdout]).toString("utf8").trim(),
      }),
      { message: "€" },
    )
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("runGit can preserve raw spawn errors for a call site", () => {
  const { root, repo } = temporaryRepository()
  const originalPath = process.env.PATH
  process.env.PATH = path.join(root, "missing-bin")
  try {
    assert.throws(
      () => runGit(repo, ["fake"], { spawnErrorFormatter: (error) => error.message }),
      { message: "spawnSync git ENOENT" },
    )
    assert.throws(
      () => runGit(repo, ["fake"]),
      { message: "Cannot run git: spawnSync git ENOENT" },
    )
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("runGit preserves stdin and supports Buffer output", () => {
  const { root, repo } = temporaryRepository()
  try {
    const object = runGit(repo, ["hash-object", "--stdin"], { input: "primitive input\n" }).stdout.trim()
    assert.match(object, /^[0-9a-f]{40}$/)
    const buffered = runGit(repo, ["rev-parse", "--is-inside-work-tree"], { encoding: null })
    assert.equal(Buffer.isBuffer(buffered.stdout), true)
    assert.equal(buffered.stdout.toString("utf8").trim(), "true")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
