import { fail, runGit } from "./primitives.ts"

export interface WorktreeRecord {
  path: string
  branch: string
  locked: boolean
  lockReason: string | null
}

export interface WorktreeInventoryRecord extends WorktreeRecord {
  head: string
  detached: boolean
}

export interface BranchRecord {
  branch: string
  head: string
  relative: string
}

/** Parse Git's porcelain worktree output with all fields needed by read-only consumers. */
export function parseWorktreeInventory(output: string, nulDelimited: boolean): WorktreeInventoryRecord[] {
  const records: WorktreeInventoryRecord[] = []
  const rawRecords = nulDelimited
    ? output.split("\0\0")
    : output.split(/(?:\r?\n){2,}/)
  for (const rawRecord of rawRecords.filter((record) => record.trim())) {
    const record: WorktreeInventoryRecord = {
      path: "",
      head: "",
      branch: "",
      detached: false,
      locked: false,
      lockReason: null,
    }
    const fields = nulDelimited ? rawRecord.split("\0") : rawRecord.split(/\r?\n/)
    for (const field of fields.filter(Boolean)) {
      if (field.startsWith("worktree ")) record.path = field.slice("worktree ".length)
      else if (field.startsWith("HEAD ")) record.head = field.slice("HEAD ".length)
      else if (field.startsWith("branch refs/heads/")) record.branch = field.slice("branch refs/heads/".length)
      else if (field === "detached") record.detached = true
      else if (field === "locked" || field.startsWith("locked ")) {
        record.locked = true
        record.lockReason = field.slice("locked".length).trim()
      }
    }
    records.push(record)
  }
  return records
}

function legacyWorktreeRecord(record: WorktreeInventoryRecord): WorktreeRecord {
  return {
    path: record.path,
    branch: record.branch,
    locked: record.locked,
    lockReason: record.lockReason,
  }
}

/** Parse Git's porcelain worktree output into the legacy destructive-caller shape. */
export function parseWorktreeRecords(output: string, nulDelimited: boolean): WorktreeRecord[] {
  return parseWorktreeInventory(output, nulDelimited).map(legacyWorktreeRecord)
}

/** List all worktree inventory records, retaining malformed/pathless records for callers to classify. */
export function listWorktreeInventory(repoRoot: string): WorktreeInventoryRecord[] {
  const nulResult = runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"], { allowFailure: true })
  if (nulResult.status === 0) return parseWorktreeInventory(nulResult.stdout, true)

  // Git 2.34 and older do not support `git worktree list -z`.
  return parseWorktreeInventory(runGit(repoRoot, ["worktree", "list", "--porcelain"]).stdout, false)
}

/** List all raw worktree records in the legacy destructive-caller shape. */
export function listWorktrees(repoRoot: string): WorktreeRecord[] {
  return listWorktreeInventory(repoRoot).map(legacyWorktreeRecord)
}

/** List the Herder branch namespace while rejecting malformed ref rows. */
export function listHerderBranches(repoRoot: string, planName: string): BranchRecord[] {
  const prefix = `herder/${planName}/`
  const output = runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:lstrip=2)%09%(objectname)",
    `refs/heads/${prefix}`,
  ]).stdout
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t")
    if (separator === -1) fail(`Cannot parse Git branch record: ${JSON.stringify(line)}`)
    const branch = line.slice(0, separator)
    return { branch, head: line.slice(separator + 1), relative: branch.slice(prefix.length) }
  })
}
