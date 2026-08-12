import { spawnSync } from "node:child_process"
import { sha256, stableJson } from "../../shared/protocol.ts"

export interface ApprovalCore {
  runId: string
  planId: string
  generation: number
  round: number
  reviewerActionId: string
  decisionActionId: string
  decisionRole: "plan-reviewer" | "plan-judge"
  assignmentSha256: string
  approvedBase: string
  approvedHead: string
  approvedTree: string
  reviewResultSha256: string
  decisionResultSha256: string
}

export interface CompletionProofPayload extends ApprovalCore {
  schemaVersion: 1
  approvalProofSha256: string
  integratedHead: string
}

export type CompletionProofInput = ApprovalCore & {
  approvalProofSha256?: string
  integratedHead: string
}

function approvalCore(payload: ApprovalCore): ApprovalCore {
  return {
    runId: payload.runId,
    planId: payload.planId,
    generation: payload.generation,
    round: payload.round,
    reviewerActionId: payload.reviewerActionId,
    decisionActionId: payload.decisionActionId,
    decisionRole: payload.decisionRole,
    assignmentSha256: payload.assignmentSha256,
    approvedBase: payload.approvedBase,
    approvedHead: payload.approvedHead,
    approvedTree: payload.approvedTree,
    reviewResultSha256: payload.reviewResultSha256,
    decisionResultSha256: payload.decisionResultSha256,
  }
}

function validatePayload(payload: CompletionProofPayload, object: string): void {
  if (!payload || payload.schemaVersion !== 1 || payload.integratedHead !== object) throw new Error("completion proof identity does not match its commit")
  if (!/^\d{3,}$/.test(payload.planId || "") || !Number.isSafeInteger(payload.generation) || payload.generation < 1
    || !Number.isSafeInteger(payload.round) || payload.round < 1 || payload.round > 6
    || !["plan-reviewer", "plan-judge"].includes(payload.decisionRole)
    || !payload.runId || !payload.reviewerActionId || !payload.decisionActionId) {
    throw new Error("completion proof has invalid approval identity")
  }
  for (const field of ["assignmentSha256", "reviewResultSha256", "decisionResultSha256", "approvalProofSha256"]) {
    if (!/^[0-9a-f]{64}$/.test(payload[field as keyof CompletionProofPayload] as string || "")) throw new Error(`completion proof has invalid ${field}`)
  }
  for (const field of ["approvedBase", "approvedHead", "approvedTree", "integratedHead"]) {
    if (!/^[0-9a-f]{40,64}$/.test(payload[field as keyof CompletionProofPayload] as string || "")) throw new Error(`completion proof has invalid ${field}`)
  }
  if (sha256(stableJson(approvalCore(payload))) !== payload.approvalProofSha256) {
    throw new Error("completion approval proof hash changed")
  }
}

export function buildCompletionProofPayload(input: CompletionProofInput): CompletionProofPayload {
  const core = approvalCore(input)
  const payload: CompletionProofPayload = {
    schemaVersion: 1,
    ...core,
    approvalProofSha256: input.approvalProofSha256 || sha256(stableJson(core)),
    integratedHead: input.integratedHead,
  }
  validatePayload(payload, payload.integratedHead)
  return payload
}

export function writeCompletionProof(repoRoot: string, ref: string, payload: CompletionProofPayload, tagName = "herder-completion") {
  validatePayload(payload, payload.integratedHead)
  const tag = [
    `object ${payload.integratedHead}`,
    "type commit",
    `tag ${tagName}`,
    `tagger Herder Run Manager <herder@localhost> ${Math.floor(Date.now() / 1000)} +0000`,
    "",
    "HERDER_COMPLETION_V1",
    stableJson(payload),
    "",
  ].join("\n")
  const object = git(repoRoot, ["mktag"], tag)
  git(repoRoot, ["update-ref", ref, object, "0000000000000000000000000000000000000000"])
  return { ref, object, payload }
}

function git(repoRoot: string, args: string[], input = ""): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", input })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git failed").trim())
  return result.stdout.trim()
}

export function inspectCompletionProof(repoRoot: string, ref: string):
  | { ok: true; ref: string; object: string; payload: CompletionProofPayload }
  | { ok: false; ref: string; error: string } {
  try {
    if (git(repoRoot, ["cat-file", "-t", ref]) !== "tag") throw new Error("completion ref is not an approval-bearing tag")
    const content = git(repoRoot, ["cat-file", "-p", ref])
    const separator = content.indexOf("\n\n")
    if (separator === -1) throw new Error("completion tag has no proof payload")
    const headers = new Map(content.slice(0, separator).split("\n").map((line) => {
      const split = line.indexOf(" ")
      return split === -1 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)]
    }))
    const object = headers.get("object")
    if (headers.get("type") !== "commit" || !/^[0-9a-f]{40,64}$/.test(object || "")) {
      throw new Error("completion tag does not point to a commit")
    }
    const prefix = "HERDER_COMPLETION_V1\n"
    const message = content.slice(separator + 2)
    if (!message.startsWith(prefix)) throw new Error("completion tag has an unknown proof format")
    const payload = JSON.parse(message.slice(prefix.length)) as CompletionProofPayload
    validatePayload(payload, object!)
    return { ok: true, ref, object: object!, payload }
  } catch (error) {
    return { ok: false, ref, error: error instanceof Error ? error.message : String(error) }
  }
}
