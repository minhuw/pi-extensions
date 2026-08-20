import { fail, runGit } from "./primitives.ts"

export interface WorktreeRecord {
  path: string
  branch: string
  locked: boolean
}

export interface BranchRecord {
  branch: string
  head: string
  relative: string
}

/** Parse Git's porcelain worktree output without applying an ownership policy. */
export function parseWorktreeRecords(output: string, nulDelimited: boolean): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  const rawRecords = nulDelimited
    ? output.split("\0\0")
    : output.split(/(?:\r?\n){2,}/)
  for (const rawRecord of rawRecords.filter((record) => record.trim())) {
    const record: WorktreeRecord = { path: "", branch: "", locked: false }
    const fields = nulDelimited ? rawRecord.split("\0") : rawRecord.split(/\r?\n/)
    for (const field of fields.filter(Boolean)) {
      if (field.startsWith("worktree ")) record.path = field.slice("worktree ".length)
      else if (field.startsWith("branch refs/heads/")) record.branch = field.slice("branch refs/heads/".length)
      else if (field === "locked" || field.startsWith("locked ")) record.locked = true
    }
    records.push(record)
  }
  return records
}

/** List all raw worktree records, retaining malformed/pathless records for callers to classify. */
export function listWorktrees(repoRoot: string): WorktreeRecord[] {
  const nulResult = runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"], { allowFailure: true })
  if (nulResult.status === 0) return parseWorktreeRecords(nulResult.stdout, true)

  // Git 2.34 and older do not support `git worktree list -z`.
  return parseWorktreeRecords(runGit(repoRoot, ["worktree", "list", "--porcelain"]).stdout, false)
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
