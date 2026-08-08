const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const REFRESH_INTERVAL_MS = 2000
const ACTIVE_PHASES = new Set([
  "implementation",
  "review",
  "judge",
  "gates",
  "integration",
  "repair",
  "recovery",
  "coordination",
  "queued",
  "judge-queued",
])
const ATTENTION_PHASES = new Set(["blocked", "rejected", "repair", "judge-queued"])

const view = {
  state: null,
  selectedPlan: null,
  filter: "all",
  paused: false,
  fetching: false,
}

function byId(id) {
  return document.getElementById(id)
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NAMESPACE, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  return node
}

function replaceChildren(target, children) {
  target.replaceChildren(...children.filter(Boolean))
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US", { notation: Number(value) >= 10000 ? "compact" : "standard" }).format(value ?? 0)
}

function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return ""
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

function formatSnapshotTime(value) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return "Snapshot time unavailable"
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(time)}`
}

function humanize(value) {
  return String(value ?? "unknown").replaceAll("-", " ")
}

function shorten(value, length = 34) {
  const text = String(value ?? "")
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function phaseTone(phase) {
  if (phase === "blocked" || phase === "rejected") return "blocked"
  if (ACTIVE_PHASES.has(phase)) return "active"
  return "neutral"
}

function attemptTone(outcome) {
  const normalized = String(outcome ?? "").toUpperCase()
  if (normalized.includes("INTERRUPT")) return "interrupted"
  if (["FAILED", "REJECT", "REVISE", "BLOCK"].some((word) => normalized.includes(word))) return "bad"
  return "good"
}

function phaseMessage(plan) {
  if (plan.statusDetail) return plan.statusDetail
  if (plan.lease) {
    const task = plan.lease.task ? ` · ${plan.lease.task}` : ""
    return `${humanize(plan.lease.role)}${task}`
  }
  if (plan.phase === "waiting") return `Waiting: ${plan.unsatisfied.join(", ")}`
  if (plan.phase === "ready") return "Ready"
  if (plan.phase === "integration") return "Integration ready"
  if (plan.phase === "complete") return "Completion verified"
  if (plan.phase === "repair") return "Repair required"
  if (plan.phase === "judge-queued") return "Judge pending"
  return humanize(plan.phase)
}

function estimateLabel(milliseconds) {
  return milliseconds === null || milliseconds === undefined ? "" : `~${formatDuration(milliseconds)}`
}

function planEstimateLabel(state, plan) {
  if (["complete", "rejected"].includes(plan.phase)) return ""
  return estimateLabel(state.forecast.byPlan[plan.id]?.remainingMs)
}

function renderOverallProgress(state) {
  const forecast = state.forecast
  const total = state.planSet.counts.total
  byId("overall-progress-value").textContent = `${forecast.finished} / ${total} · ${forecast.percent}%`
  byId("overall-progress-fill").style.width = `${forecast.percent}%`
  const track = byId("overall-progress-track")
  track.setAttribute("aria-valuenow", String(forecast.percent))
  track.setAttribute("aria-valuetext", `${forecast.finished} of ${total} plans finished`)
  const metadata = []
  if (forecast.elapsedMs !== null) metadata.push(`Elapsed ${formatDuration(forecast.elapsedMs)}`)
  if (forecast.estimatedRemainingMs !== null) metadata.push(`Est. ${formatDuration(forecast.estimatedRemainingMs)} remaining`)
  byId("overall-progress-meta").textContent = metadata.join(" · ")
}

function planMatchesFilter(plan) {
  if (view.filter === "active") return ACTIVE_PHASES.has(plan.phase)
  if (view.filter === "attention") return ATTENTION_PHASES.has(plan.phase)
  if (view.filter === "finished") return ["complete", "rejected"].includes(plan.phase)
  return true
}

function planLevels(plans) {
  const byPlan = new Map(plans.map((plan) => [plan.id, plan]))
  const memo = new Map()
  const levelFor = (plan, visiting = new Set()) => {
    if (memo.has(plan.id)) return memo.get(plan.id)
    if (visiting.has(plan.id)) return 0
    const next = new Set(visiting).add(plan.id)
    const dependencies = plan.dependencies.map((id) => byPlan.get(id)).filter(Boolean)
    const level = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map((dependency) => levelFor(dependency, next)))
    memo.set(plan.id, level)
    return level
  }
  for (const plan of plans) levelFor(plan)
  return memo
}

function renderGraph(state) {
  const graph = byId("plan-graph")
  const empty = byId("graph-empty")
  const plans = state.plans.filter(planMatchesFilter)
  graph.replaceChildren()
  const graphTitle = svgElement("title", { id: "graph-title" })
  graphTitle.textContent = "Herder plan dependency graph"
  const graphDescription = svgElement("desc", { id: "graph-description" })
  graphDescription.textContent = "Plans are arranged from left to right by dependency depth."
  graph.append(graphTitle, graphDescription)
  empty.hidden = plans.length > 0
  graph.hidden = plans.length === 0
  byId("graph-caption").textContent = `${plans.length} / ${state.plans.length} shown`
  if (plans.length === 0) return

  const levels = planLevels(state.plans)
  const groups = new Map()
  for (const plan of plans) {
    const level = levels.get(plan.id) ?? 0
    const group = groups.get(level) ?? []
    group.push(plan)
    groups.set(level, group)
  }
  for (const group of groups.values()) group.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))

  const nodeWidth = 200
  const nodeHeight = 74
  const horizontalGap = 36
  const verticalGap = 24
  const paddingX = 24
  const paddingY = 28
  const maxLevel = Math.max(...plans.map((plan) => levels.get(plan.id) ?? 0))
  const maxRows = Math.max(...[...groups.values()].map((group) => group.length))
  const width = Math.max(760, paddingX * 2 + (maxLevel + 1) * nodeWidth + maxLevel * horizontalGap)
  const height = Math.max(400, paddingY * 2 + maxRows * nodeHeight + (maxRows - 1) * verticalGap)
  graph.setAttribute("viewBox", `0 0 ${width} ${height}`)
  graph.setAttribute("width", width)
  graph.setAttribute("height", height)

  const definitions = svgElement("defs")
  const marker = svgElement("marker", {
    id: "edge-arrow",
    viewBox: "0 0 8 8",
    refX: 7,
    refY: 4,
    markerWidth: 6,
    markerHeight: 6,
    orient: "auto-start-reverse",
  })
  marker.append(svgElement("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "var(--border-strong)" }))
  definitions.append(marker)
  graph.append(definitions)

  const positions = new Map()
  for (const [level, group] of groups) {
    const columnHeight = group.length * nodeHeight + (group.length - 1) * verticalGap
    const startY = Math.max(paddingY, (height - columnHeight) / 2)
    group.forEach((plan, row) => positions.set(plan.id, {
      x: paddingX + level * (nodeWidth + horizontalGap),
      y: startY + row * (nodeHeight + verticalGap),
    }))
  }

  const edgeLayer = svgElement("g", { "aria-hidden": "true" })
  const visible = new Set(plans.map((plan) => plan.id))
  for (const plan of plans) {
    const target = positions.get(plan.id)
    for (const dependency of plan.dependencies.filter((id) => visible.has(id))) {
      const source = positions.get(dependency)
      const startX = source.x + nodeWidth
      const startY = source.y + nodeHeight / 2
      const endX = target.x
      const endY = target.y + nodeHeight / 2
      const bend = Math.max(34, (endX - startX) * 0.48)
      edgeLayer.append(svgElement("path", {
        class: "graph-edge",
        d: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX - 5} ${endY}`,
        "marker-end": "url(#edge-arrow)",
      }))
    }
  }
  graph.append(edgeLayer)

  const nodeLayer = svgElement("g")
  for (const plan of plans) {
    const position = positions.get(plan.id)
    const group = svgElement("g", {
      class: `graph-node${plan.id === view.selectedPlan ? " is-selected" : ""}`,
      transform: `translate(${position.x} ${position.y})`,
      tabindex: 0,
      role: "button",
      "aria-label": `Plan ${plan.id}, ${plan.title}, ${humanize(plan.phase)}`,
      "data-phase": plan.phase,
      "data-plan-id": plan.id,
    })
    group.append(svgElement("rect", { width: nodeWidth, height: nodeHeight, rx: 4 }))
    const idText = svgElement("text", { class: "node-id", x: 14, y: 19 })
    idText.textContent = `PLAN ${plan.id}`
    const title = svgElement("text", { class: "node-title", x: 14, y: 40 })
    title.textContent = shorten(plan.title, 22)
    const dot = svgElement("circle", { class: "node-dot", cx: 15, cy: 58, r: 3 })
    const phase = svgElement("text", { class: "node-phase", x: 25, y: 61 })
    phase.textContent = humanize(plan.phase).toUpperCase()
    const eta = svgElement("text", { class: "node-eta", x: nodeWidth - 12, y: 61, "text-anchor": "end" })
    eta.textContent = planEstimateLabel(state, plan)
    group.append(idText, title, dot, phase, eta)
    const select = () => {
      view.selectedPlan = plan.id
      renderGraph(state)
      renderPlanDetail(state)
    }
    group.addEventListener("click", select)
    group.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault()
        select()
      }
    })
    nodeLayer.append(group)
  }
  graph.append(nodeLayer)
}

function detailFact(label, value) {
  const fact = element("div", "detail-fact")
  fact.append(element("span", null, label), element("strong", null, value))
  return fact
}

function renderAttempt(attempt) {
  const row = element("div", "attempt-row")
  const marker = element("span", "attempt-marker")
  marker.dataset.tone = attemptTone(attempt.outcome)
  const body = element("div")
  body.append(
    element("span", "attempt-role", humanize(attempt.role)),
    element("span", "attempt-meta", [
      `${attempt.model} / ${attempt.effort}`,
      attempt.serviceTier,
      formatDuration(attempt.durationMs),
      attempt.inputTokens !== null && attempt.outputTokens !== null
        ? `${formatCount(attempt.inputTokens + attempt.outputTokens)} tok`
        : "tokens unknown",
    ].filter(Boolean).join(" · ")),
  )
  const outcome = element("span", "outcome-chip", attempt.outcome)
  outcome.title = attempt.outcome
  row.append(marker, body, outcome)
  return row
}

function renderPlanDetail(state) {
  const panel = byId("plan-detail")
  const plan = state.plans.find((candidate) => candidate.id === view.selectedPlan)
  if (!plan) {
    const placeholder = element("div", "detail-placeholder")
    placeholder.append(element("span", "detail-index", "—"), element("p", null, "Select a plan."))
    replaceChildren(panel, [placeholder])
    return
  }

  const fragment = document.createDocumentFragment()
  const topline = element("div", "detail-topline")
  topline.append(element("span", "detail-number", `PLAN ${plan.id}`))
  const phase = element("span", "phase-chip", humanize(plan.phase))
  phase.dataset.tone = phaseTone(plan.phase)
  topline.append(phase)
  fragment.append(topline, element("h3", "detail-title", plan.title), element("p", "detail-message", phaseMessage(plan)))

  const facts = element("div", "detail-facts")
  facts.append(
    detailFact("Attempts", formatCount(plan.report.attempts)),
    detailFact("Rounds", formatCount(plan.report.rounds.length)),
    detailFact("Duration", formatDuration(plan.report.timing.attemptDurationMs)),
    detailFact("ETA", planEstimateLabel(state, plan)),
  )
  fragment.append(facts)

  const dependencySection = element("section", "detail-section")
  dependencySection.append(element("h3", null, "Dependencies"))
  const dependencies = element("div", "detail-dependencies")
  if (plan.dependencies.length === 0) dependencies.append(element("span", "dependency-chip", "None"))
  else {
    for (const id of plan.dependencies) {
      const chip = element("span", "dependency-chip", id)
      if (plan.unsatisfied.includes(id)) chip.title = "Unsatisfied dependency"
      dependencies.append(chip)
    }
  }
  dependencySection.append(dependencies)
  fragment.append(dependencySection)

  const roundsSection = element("section", "detail-section")
  roundsSection.append(element("h3", null, "Implementation / review loop"))
  const rounds = element("div", "round-list")
  if (plan.rounds.length === 0) rounds.append(element("p", "no-attempts", "No attempts."))
  for (const round of plan.rounds) {
    const card = element("article", "round-card")
    const header = element("div", "round-header")
    header.append(
      element("strong", null, round.round ? `ROUND ${round.round}` : "UNASSIGNED"),
      element("span", null, `${round.attempts.length} attempt${round.attempts.length === 1 ? "" : "s"}`),
    )
    card.append(header, ...round.attempts.map(renderAttempt))
    rounds.append(card)
  }
  roundsSection.append(rounds)
  fragment.append(roundsSection)
  panel.replaceChildren(fragment)
}

function integrationCell(label, headline, detail) {
  const cell = element("div", "integration-cell")
  cell.append(element("span", "integration-cell-label", label))
  const body = element("div")
  body.append(element("strong", null, headline), element("code", null, detail))
  cell.append(body)
  return cell
}

function renderIntegration(state) {
  const lane = byId("integration-lane")
  const branch = state.integration.branch
  const worktree = state.integration.worktree
  const completed = state.integration.completedPlans.length
  const total = state.planSet.counts.total
  const source = integrationCell(
    "Reviewed plans",
    `${state.integration.readyPlans.length} awaiting lock`,
    state.integration.readyPlans.length > 0 ? state.integration.readyPlans.join(", ") : "None",
  )

  const flowCell = element("div", "integration-cell")
  flowCell.append(element("span", "integration-cell-label", "Completion evidence"))
  const flow = element("div", "integration-flow")
  const steps = Math.max(3, Math.min(7, total || 3))
  for (let index = 0; index < steps; index += 1) {
    const finished = index < Math.round((completed / Math.max(total, 1)) * steps)
    const node = element("span", `flow-node${finished ? " is-complete" : ""}`)
    flow.append(node)
    if (index < steps - 1) flow.append(element("span", `flow-segment${finished ? " is-complete" : ""}`))
  }
  flowCell.append(flow)
  const flowMeta = element("div")
  flowMeta.append(element("strong", null, `${completed} / ${total} complete`), element("code", null, "Git refs · README"))
  flowCell.append(flowMeta)

  const lockHeadline = worktree?.locked ? "Lock held" : (worktree ? "Worktree idle" : "Not created")
  const target = integrationCell(
    "Integration worktree",
    lockHeadline,
    branch ? `${branch.name} @ ${branch.shortHead}` : "No branch",
  )
  replaceChildren(lane, [source, flowCell, target])
}

function renderFinished(state) {
  const finished = state.plans.filter((plan) => plan.phase === "complete")
  byId("finished-count").textContent = `${finished.length} terminal pipeline${finished.length === 1 ? "" : "s"}`
  const cards = finished.map((plan) => {
    const card = element("article", "finished-card")
    const top = element("div", "finished-card-top")
    top.append(element("span", "finished-card-id", `PLAN ${plan.id}`), element("span", "phase-chip", "Complete"))
    const stats = element("div", "finished-card-stats")
    const stat = (label, value) => {
      const item = element("div")
      item.append(element("span", null, label), element("strong", null, value))
      return item
    }
    stats.append(
      stat("Rounds", plan.report.rounds.length),
      stat("Attempts", plan.report.attempts),
      stat("Tokens", formatCount(plan.report.tokens.reportedInputOutput)),
    )
    card.append(top, element("h3", null, plan.title), stats)
    return card
  })
  if (cards.length === 0) cards.push(element("p", "no-attempts", "No finished plans."))
  replaceChildren(byId("finished-grid"), cards)
}

function selectDefaultPlan(state) {
  if (state.plans.some((plan) => plan.id === view.selectedPlan)) return
  view.selectedPlan = state.plans.find((plan) => ACTIVE_PHASES.has(plan.phase))?.id
    ?? state.plans.find((plan) => plan.phase === "ready")?.id
    ?? state.plans[0]?.id
    ?? null
}

function render(state) {
  view.state = state
  selectDefaultPlan(state)
  document.title = `${state.planSet.name} · Herder Dashboard`
  byId("plan-name").textContent = state.planSet.name
  byId("snapshot-state").textContent = view.paused ? "PAUSED" : "LIVE"
  byId("last-updated").textContent = formatSnapshotTime(state.generatedAt)
  const active = state.plans.filter((plan) => ACTIVE_PHASES.has(plan.phase)).length
  const managerStatus = state.manager?.run?.status
  byId("run-state").textContent = managerStatus
    ? `${humanize(managerStatus)}${active > 0 ? ` · ${active} active` : ""}`
    : (state.planSet.complete ? "Complete" : (active > 0 ? `${active} active` : `${state.planSet.ready.length} ready`))
  renderOverallProgress(state)
  renderGraph(state)
  renderPlanDetail(state)
  renderIntegration(state)
  renderFinished(state)
}

function showConnectionError(message) {
  const toast = byId("connection-toast")
  toast.textContent = `Observer disconnected — ${message}`
  toast.hidden = false
  byId("snapshot-state").textContent = "STALE"
}

async function refresh() {
  if (view.paused || view.fetching) return
  view.fetching = true
  try {
    const response = await fetch("/api/state", { cache: "no-store" })
    if (!response.ok) throw new Error(`snapshot request returned ${response.status}`)
    const state = await response.json()
    if (state.version !== 1 || state.readOnly !== true) throw new Error("unsupported dashboard state")
    byId("connection-toast").hidden = true
    render(state)
  } catch (error) {
    showConnectionError(error.message)
  } finally {
    view.fetching = false
  }
}

function setPaused(paused) {
  view.paused = paused
  const button = byId("refresh-toggle")
  button.classList.toggle("is-paused", paused)
  button.setAttribute("aria-pressed", String(paused))
  button.setAttribute("aria-label", paused ? "Resume automatic refresh" : "Pause automatic refresh")
  button.title = paused ? "Resume automatic refresh" : "Pause automatic refresh"
  if (view.state) render(view.state)
  if (!paused) refresh()
}

function installThemeControl() {
  const choices = ["system", "light", "dark"]
  let saved = null
  try {
    saved = localStorage.getItem("herder-dashboard-theme")
  } catch {}
  let theme = choices.includes(saved) ? saved : "system"
  const apply = () => {
    document.documentElement.dataset.theme = theme
    const label = `Theme: ${theme}. Activate to change.`
    byId("theme-toggle").setAttribute("aria-label", label)
    byId("theme-toggle").title = label
  }
  apply()
  byId("theme-toggle").addEventListener("click", () => {
    theme = choices[(choices.indexOf(theme) + 1) % choices.length]
    try {
      localStorage.setItem("herder-dashboard-theme", theme)
    } catch {}
    apply()
  })
}

function setSectionExpanded(button, expanded) {
  const target = byId(button.getAttribute("aria-controls"))
  if (!target) return
  target.hidden = !expanded
  button.setAttribute("aria-expanded", String(expanded))
  button.closest("[data-collapsible-section]")?.classList.toggle("is-collapsed", !expanded)
  const label = button.dataset.sectionLabel
  const accessibleLabel = button.querySelector(".sr-only")
  if (accessibleLabel) accessibleLabel.textContent = `${expanded ? "Collapse" : "Expand"} ${label}`
}

function installSectionControls() {
  for (const button of document.querySelectorAll("[data-section-toggle]")) {
    setSectionExpanded(button, true)
    button.addEventListener("click", () => {
      setSectionExpanded(button, button.getAttribute("aria-expanded") !== "true")
    })
  }
}

function installControls() {
  byId("refresh-toggle").addEventListener("click", () => setPaused(!view.paused))
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === view.filter))
    button.addEventListener("click", () => {
      view.filter = button.dataset.filter
      for (const candidate of document.querySelectorAll("[data-filter]")) {
        const active = candidate === button
        candidate.classList.toggle("is-active", active)
        candidate.setAttribute("aria-pressed", String(active))
      }
      if (view.state) {
        const visible = view.state.plans.filter(planMatchesFilter)
        if (!visible.some((plan) => plan.id === view.selectedPlan)) view.selectedPlan = visible[0]?.id ?? null
        renderGraph(view.state)
        renderPlanDetail(view.state)
      }
    })
  }
  installSectionControls()
  installThemeControl()
}

installControls()
refresh()
setInterval(refresh, REFRESH_INTERVAL_MS)
