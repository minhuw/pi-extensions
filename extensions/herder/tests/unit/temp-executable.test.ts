import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import test from "node:test"
import { withTemporaryExecutableOnPath } from "../support/temp-executable.ts"

test("creates a temporary executable on PATH and cleans it up", () => {
  const originalPath = process.env.PATH
  let directory: string | undefined
  const script = "#!/bin/sh\nprintf 'temporary executable\\n'\n"

  const result = withTemporaryExecutableOnPath({ prefix: "herder-temp-executable-normal-", script }, () => {
    directory = process.env.PATH?.split(path.delimiter)[0]
    assert.ok(directory)
    const executable = path.join(directory, "git")
    assert.equal(fs.readFileSync(executable, "utf8"), script)
    assert.equal(fs.statSync(executable).mode & 0o777, 0o755)
    assert.equal(
      process.env.PATH,
      originalPath === undefined ? directory : `${directory}${path.delimiter}${originalPath}`,
    )
    return "callback result"
  })

  assert.equal(result, "callback result")
  assert.equal(process.env.PATH, originalPath)
  assert.ok(directory)
  assert.equal(fs.existsSync(directory), false)
})

test("restores PATH and removes the executable when the callback throws", () => {
  const originalPath = process.env.PATH
  let directory: string | undefined
  const error = new Error("callback failed")

  assert.throws(
    () => withTemporaryExecutableOnPath({
      prefix: "herder-temp-executable-throwing-",
      name: "custom-git",
      script: "#!/bin/sh\nexit 1\n",
    }, () => {
      directory = process.env.PATH?.split(path.delimiter)[0]
      assert.ok(directory)
      assert.equal(fs.existsSync(path.join(directory, "custom-git")), true)
      throw error
    }),
    error,
  )

  assert.equal(process.env.PATH, originalPath)
  assert.ok(directory)
  assert.equal(fs.existsSync(directory), false)
})

test("restores PATH absence after a temporary executable callback", () => {
  const originalPath = process.env.PATH
  let directory: string | undefined
  try {
    delete process.env.PATH
    const result = withTemporaryExecutableOnPath({
      prefix: "herder-temp-executable-absent-",
      script: "#!/bin/sh\nexit 0\n",
    }, () => {
      directory = process.env.PATH?.split(path.delimiter)[0]
      assert.ok(directory)
      assert.equal(process.env.PATH, directory)
      return true
    })

    assert.equal(result, true)
    assert.equal("PATH" in process.env, false)
    assert.ok(directory)
    assert.equal(fs.existsSync(directory), false)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})
