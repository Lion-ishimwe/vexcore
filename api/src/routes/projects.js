import { Router } from 'express'
import { Prisma } from '@prisma/client'
import path from 'node:path'
import { db, audit } from '../db.js'
import { requireCap, can, settingsOf } from '../auth.js'
import { sendMail, APP_URL } from '../mail.js'
import { checkLowStock } from '../stockAlerts.js'
import { planLimits } from '../plans.js'
import { scopedProjectIds, inScope } from '../scope.js'
import { uploader, discardUploads, UPLOADS } from '../uploads.js'
import { crewCost, crewOf, crewSummary, cleanRates } from '../crew.js'

// Phase rates from a request: crewRates, or the old two-rate fields still sent
// by phase CSV files made from the earlier template.
const ratesFromBody = (b) => cleanRates(b.crewRates ?? (
  b.costPerBuilder !== undefined || b.costPerHelper !== undefined
    ? { builder: b.costPerBuilder, helper: b.costPerHelper } : null))

const r = Router()

const upload = uploader({ files: 12 })

// Phase status is a fixed set. It used to accept any string, which skipped the
// sign-off checks and later crashed the schedule PDF, whose colour map is
// indexed by exactly these three values.
const PHASE_STATUS = ['todo', 'active', 'done']

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Worker wages from attendance: each clocked-in worker earns their daily rate
// once per DAY across the whole account (the earliest session of that day wins,
// whichever project or phase it belongs to). The rate is snapshotted on the
// record at clock-in; older records fall back to the worker's current rate.
export async function wagesForProjects(clientId, projectIds) {
  // Sessions are ALWAYS loaded for the whole account, never just the projects
  // being displayed, because the de-duplication below has to be global. A
  // worker earns their daily rate once per DAY, not once per project per day:
  // keying on project|worker|day paid a worker who moved between two sites
  // twice, so project spend and the dashboard overstated payroll while the
  // attendance report (which keys on worker+day) showed the true figure.
  //
  // Loading every session also makes attribution stable. The earliest session
  // of the day wins, so the same worker-day always lands on the same project
  // whether you are looking at one project or all of them.
  const sessions = await db.attendanceSession.findMany({
    where: { clientId },
    include: { records: { include: { worker: { select: { name: true, type: true, dailyRate: true } } } } },
    orderBy: { id: 'asc' },
  })
  const wanted = projectIds ? new Set(projectIds) : null
  const seen = new Set() // worker|day → already earned that day, anywhere
  const byPhase = new Map() // phaseId → Map(day → { amount, workers })
  const unphased = new Map() // projectId → wages of project-wide (no phase) sessions
  for (const s of sessions) {
    const day = dayKey(s.date)
    for (const rec of s.records) {
      if (!rec.worker || !rec.clockInAt) continue // team-member badges earn no wages
      const key = `${rec.workerId}|${day}`
      if (seen.has(key)) continue
      seen.add(key) // claimed for the day even if it belongs to a project we are not showing
      if (wanted && !wanted.has(s.projectId)) continue
      const amount = rec.rateSnap ?? rec.worker.dailyRate ?? 0
      if (s.phaseId) {
        const days = byPhase.get(s.phaseId) ?? new Map()
        const cell = days.get(day) ?? { amount: 0, workers: 0 }
        cell.amount += amount
        cell.workers += 1
        days.set(day, cell)
        byPhase.set(s.phaseId, days)
      } else {
        unphased.set(s.projectId, (unphased.get(s.projectId) ?? 0) + amount)
      }
    }
  }
  return { byPhase, unphased }
}

// Per-phase spend: wages from real attendance, materials from stock draws, and
// the crew estimate (daily-update counts × per-phase rates) only on days with
// no attendance wages - attendance pre-fills those counts, so charging both
// would pay the same people twice.
function phaseSpent(phase, wageDays) {
  let wages = 0, workerDays = 0
  const paidDays = new Set()
  for (const [day, cell] of wageDays ?? []) {
    wages += cell.amount
    workerDays += cell.workers
    paidDays.add(day)
  }
  const labor = phase.updates.reduce(
    (s, u) => paidDays.has(dayKey(u.createdAt)) ? s
      : s + crewCost(u, phase), 0)
  // Materials: drawn from stock via the phase + reported as used in this
  // phase's daily updates (both deduct stock and snapshot the unit cost).
  const materials = phase.materials.reduce((s, m) => s + m.qty * m.unitCostSnap, 0) +
    phase.updates.reduce((s, u) => s + (u.materials ?? []).reduce((t, m) => t + m.qty * m.unitCostSnap, 0), 0)
  return { wages, workerDays, labor, materials, spent: wages + labor + materials }
}

// Percent is derived from key insights when any exist: each insight is an equal
// share of 100%; all done = phase complete (PRD 4.6 + client requirement).
function derivedPercent(ph) {
  if (!ph.insights?.length) return ph.percent
  return Math.round(ph.insights.filter(i => i.done).length / ph.insights.length * 100)
}

// showMoney=false strips every monetary field server-side. The web UI already
// hid these from roles without stock.amounts, but the API returned them anyway,
// so a Guest could read every budget straight off the network tab.
function shapePhase(ph, wageDays, showMoney = true) {
  const { wages, workerDays, labor, materials, spent } = phaseSpent(ph, wageDays)
  const insightMedia = (ph.insights ?? []).flatMap(i => i.media ?? [])
  const money = (n) => (showMoney ? n : null)
  return {
    id: ph.id, projectId: ph.projectId, name: ph.name, status: ph.status,
    percent: derivedPercent(ph),
    startDate: ph.startDate, endDate: ph.endDate, budget: money(ph.budget),
    crewRates: showMoney ? (ph.crewRates ?? {}) : null,
    assignee: ph.assignee ? { id: ph.assignee.id, name: ph.assignee.name } : null,
    materials: [
      ...ph.materials.map(m => ({ id: m.id, name: m.nameSnap, qty: m.qty, unitCost: money(m.unitCostSnap) })),
      ...ph.updates.flatMap(u => (u.materials ?? []).map(m =>
        ({ id: 'u' + m.id, name: m.nameSnap, qty: m.qty, unitCost: money(m.unitCostSnap), fromUpdate: true }))),
    ],
    insights: (ph.insights ?? []).map(i => ({
      id: i.id, title: i.title, done: i.done, doneAt: i.doneAt, doneBy: i.doneBy,
      media: (i.media ?? []).map(m => ({ ...m, url: '/uploads/' + m.path })),
    })),
    wagesSpent: money(wages), workerDays, laborSpent: money(labor),
    materialsSpent: money(materials), spent: money(spent),
    hasPhotoProof: ph.updates.some(u => u.media.some(m => m.kind === 'photo')) ||
      insightMedia.some(m => m.kind === 'photo'),
  }
}

const PHASE_INCLUDE = {
  assignee: true, materials: true,
  updates: { include: { media: true, materials: true } },
  insights: { orderBy: { orderIdx: 'asc' } },
  project: { select: { name: true } },
}

// Keep the stored percent column in sync so dashboards and reports that read
// Phase.percent directly stay correct.
async function syncPhasePercent(phaseId) {
  const insights = await db.keyInsight.findMany({ where: { phaseId } })
  // Deleting the last insight used to leave the old percent frozen in place, so
  // a phase with an empty checklist could keep reading as 100% complete.
  const percent = insights.length
    ? Math.round(insights.filter(i => i.done).length / insights.length * 100)
    : 0
  await db.phase.update({ where: { id: phaseId }, data: { percent } })
}

// Insight routes reach a phase by insight id. Checking only the client let a
// user scoped to one project edit another project's checklist - which drives
// that phase's completion percentage - so the project scope is enforced here.
async function phaseForInsight(req, insightId) {
  const found = await db.keyInsight.findFirst({
    where: { id: insightId, phase: { project: { clientId: req.client.id } } },
    include: { phase: true },
  })
  if (!found) return null
  const ids = await scopedProjectIds(req)
  return inScope(ids, found.phase.projectId) ? found : null
}

// Same for reaching a phase directly by id.
async function phaseInScope(req, phaseId) {
  const phase = await db.phase.findFirst({
    where: { id: phaseId, project: { clientId: req.client.id } },
  })
  if (!phase) return null
  const ids = await scopedProjectIds(req)
  return inScope(ids, phase.projectId) ? phase : null
}

// A phase assignee must be a member of THIS account. It used to accept any
// integer, so a senior could attach - and read back the name of - any user on
// the platform.
async function resolveAssignee(req) {
  if (req.body.assigneeId === undefined) return { skip: true }
  if (!req.body.assigneeId) return { assigneeId: null }
  const user = await db.user.findFirst({
    where: { id: +req.body.assigneeId, clientId: req.client.id },
    select: { id: true },
  })
  if (!user) return { error: 'That team member is not part of this account' }
  return { assigneeId: user.id }
}

// The project list is also needed by anyone who submits daily reports (the
// form's project picker) - e.g. Stock Managers, who may lack projects.view.
r.get('/', (req, res, next) => {
  if (can(req, 'projects.view') || can(req, 'updates.submit')) return next()
  res.status(403).json({ error: 'No permission: projects.view' })
}, async (req, res) => {
  const ids = await scopedProjectIds(req)
  const projects = await db.project.findMany({
    where: { clientId: req.client.id, ...(ids ? { id: { in: ids } } : {}) },
    include: {
      phases: { include: PHASE_INCLUDE, orderBy: { orderIdx: 'asc' } },
      members: { include: { user: { select: { id: true, name: true, role: true } } } },
    },
    orderBy: { id: 'asc' },
  })
  const { byPhase, unphased } = await wagesForProjects(req.client.id, projects.map(p => p.id))
  // Items consumed by daily reports that had no phase picked - still money out
  // of stock, counted at project level.
  const looseItems = await db.updateMaterial.findMany({
    where: { update: { clientId: req.client.id, phaseId: null, projectId: { in: projects.map(p => p.id) } } },
    include: { update: { select: { projectId: true } } },
  })
  const looseConsumed = new Map()
  for (const m of looseItems)
    looseConsumed.set(m.update.projectId, (looseConsumed.get(m.update.projectId) ?? 0) + m.qty * m.unitCostSnap)
  const showMoney = can(req, 'stock.amounts')
  res.json(projects.map(p => {
    const phases = p.phases.map(ph => shapePhase(ph, byPhase.get(ph.id), showMoney))
    const percent = phases.length ? Math.round(phases.reduce((s, ph) => s + ph.percent, 0) / phases.length) : 0
    // Wages from project-wide attendance sessions (no phase picked) still cost
    // money - they count in the project total even though no phase shows them.
    const unphasedWages = unphased.get(p.id) ?? 0
    const spent = p.phases.reduce((s, ph) => s + phaseSpent(ph, byPhase.get(ph.id)).spent, 0) +
      unphasedWages + (looseConsumed.get(p.id) ?? 0)
    return {
      id: p.id, name: p.name, location: p.location, status: p.status, currency: p.currency,
      budget: showMoney ? p.budget : null, documents: p.documents ?? [], percent,
      spent: showMoney ? spent : null,
      unphasedWages: showMoney ? unphasedWages : null,
      phases,
      team: p.members.map(m => ({ id: m.user.id, name: m.user.name, role: m.user.role })),
    }
  }))
})

// ---- Project team (each project has its own engineers / stock manager) ----

r.put('/:id/team', requireCap('team.create'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!project || !inScope(ids, project.id)) return res.status(404).json({ error: 'Project not found' })
  const userIds = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(Number).filter(Boolean))]
  const users = await db.user.findMany({
    where: { id: { in: userIds }, clientId: req.client.id, role: { in: ['SENIOR', 'SITE', 'STOCK', 'GUEST'] } },
    select: { id: true, name: true },
  })
  await db.$transaction([
    db.projectMember.deleteMany({ where: { projectId: project.id } }),
    db.projectMember.createMany({ data: users.map(u => ({ projectId: project.id, userId: u.id })) }),
  ])
  await audit(req.client.id, req.user.name, 'project.team',
    `${project.name}: ${users.length ? users.map(u => u.name).join(', ') : 'nobody (admins only)'}`)
  res.json({ ok: true, team: users })
})

r.post('/', requireCap('projects.create'), async (req, res) => {
  const { name, location, budget, documents } = req.body
  if (!name) return res.status(400).json({ error: 'Project name is required' })
  // Plan limit: active (non-Done) projects
  const limits = planLimits(req.client)
  if (limits.projects != null) {
    const active = await db.project.count({ where: { clientId: req.client.id, NOT: { status: 'Done' } } })
    if (active >= limits.projects)
      return res.status(403).json({
        error: `Your ${limits.name} plan allows ${limits.projects} active project${limits.projects === 1 ? '' : 's'} - upgrade in Billing to add more`,
        planLimit: true,
      })
  }
  const project = await db.project.create({
    data: {
      clientId: req.client.id, name, location: location || null,
      budget: Number(budget) || 0, currency: req.client.currency,
      documents: documents ?? [], status: 'Planning',
    },
  })
  await audit(req.client.id, req.user.name, 'project.created', name)
  res.json(project)
})

// Edit a project's details (admin only - same capability that creates them).
r.patch('/:id', requireCap('projects.create'), async (req, res) => {
  const project = await db.project.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const data = {}
  if (req.body.name !== undefined && String(req.body.name).trim()) data.name = String(req.body.name).trim()
  if (req.body.location !== undefined) data.location = String(req.body.location).trim() || null
  if (req.body.budget !== undefined) data.budget = Number(req.body.budget) || 0
  if (req.body.status !== undefined && ['Planning', 'In progress', 'Done'].includes(req.body.status)) data.status = req.body.status
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to change' })
  const updated = await db.project.update({ where: { id: project.id }, data })
  await audit(req.client.id, req.user.name, 'project.edited', data.name ?? project.name)
  res.json(updated)
})

// Delete a project and everything inside it (admin only): phases, daily
// reports and their media records, attendance, team assignments, requests and
// damaged-item logs. Workers and stock items assigned to it are kept - they
// move back to "all projects" / the general store.
r.delete('/:id', requireCap('projects.create'), async (req, res) => {
  const project = await db.project.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const pid = project.id
  await db.$transaction([
    db.media.deleteMany({ where: { update: { projectId: pid } } }),
    db.updateMaterial.deleteMany({ where: { update: { projectId: pid } } }),
    db.dailyUpdate.deleteMany({ where: { projectId: pid } }),
    db.attendanceRecord.deleteMany({ where: { session: { projectId: pid } } }),
    db.attendanceSession.deleteMany({ where: { projectId: pid } }),
    db.phaseMaterial.deleteMany({ where: { phase: { projectId: pid } } }),
    db.keyInsight.deleteMany({ where: { phase: { projectId: pid } } }),
    db.phase.deleteMany({ where: { projectId: pid } }),
    db.projectMember.deleteMany({ where: { projectId: pid } }),
    db.stockRequest.deleteMany({ where: { projectId: pid } }),
    db.damagedItem.deleteMany({ where: { projectId: pid } }),
    db.worker.updateMany({ where: { projectId: pid }, data: { projectId: null } }),
    // The project's stores go with it. Transfers referencing them have to clear
    // first, and items must let go of the store as well as the project -
    // otherwise the foreign keys block the delete and the project can never be
    // removed once anyone has created a store on it.
    db.stockTransfer.deleteMany({
      where: { OR: [{ fromStore: { projectId: pid } }, { toStore: { projectId: pid } }] },
    }),
    db.stockItem.updateMany({ where: { projectId: pid }, data: { projectId: null, storeId: null } }),
    db.stockStore.deleteMany({ where: { projectId: pid } }),
    db.project.delete({ where: { id: pid } }),
  ])
  await audit(req.client.id, req.user.name, 'project.deleted', project.name)
  res.json({ ok: true })
})

r.post('/:id/phases', requireCap('phases.edit'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return res.status(404).json({ error: 'Project not found' })
  const { name, budget, startDate, endDate } = req.body
  if (!name) return res.status(400).json({ error: 'Phase name is required' })
  const assignee = await resolveAssignee(req)
  if (assignee.error) return res.status(400).json({ error: assignee.error })
  const count = await db.phase.count({ where: { projectId: project.id } })
  const phase = await db.phase.create({
    data: {
      projectId: project.id, name, budget: Math.max(0, Number(budget) || 0),
      crewRates: ratesFromBody(req.body) ?? undefined,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      assigneeId: assignee.skip ? null : assignee.assigneeId,
      orderIdx: count,
    },
  })
  if (project.status === 'Planning')
    await db.project.update({ where: { id: project.id }, data: { status: 'In progress' } })
  await audit(req.client.id, req.user.name, 'phase.created', `${project.name} › ${name}`)
  res.json(phase)
})

// Bulk phase upload from the CSV template. Every row lands in "To do";
// problem rows come back with the reason so nothing fails silently.
r.post('/:id/phases/bulk', requireCap('phases.edit'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return res.status(404).json({ error: 'Project not found' })
  const rows = Array.isArray(req.body.phases) ? req.body.phases.slice(0, 200) : []
  if (!rows.length) return res.status(400).json({ error: 'No rows found in the file' })

  let orderIdx = await db.phase.count({ where: { projectId: project.id } })
  const parseDate = (s) => {
    if (!String(s ?? '').trim()) return null
    const d = new Date(String(s).trim())
    return isNaN(d.getTime()) ? undefined : d
  }
  const valid = []
  const skipped = []
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const line = i + 2 // header is line 1 in the template
    const name = String(raw.name ?? '').trim()
    if (!name) { skipped.push({ line, name: raw.name ?? '', reason: 'Missing phase name' }); continue }
    const startDate = parseDate(raw.startDate)
    const endDate = parseDate(raw.endDate)
    if (startDate === undefined || endDate === undefined) {
      skipped.push({ line, name, reason: 'Bad date - use YYYY-MM-DD' })
      continue
    }
    valid.push({
      projectId: project.id, name, status: 'todo',
      budget: Number(raw.budget) || 0,
      crewRates: ratesFromBody(raw) ?? undefined,
      startDate, endDate, orderIdx: orderIdx++,
    })
  }
  if (valid.length) await db.phase.createMany({ data: valid })
  if (valid.length && project.status === 'Planning')
    await db.project.update({ where: { id: project.id }, data: { status: 'In progress' } })
  await audit(req.client.id, req.user.name, 'phase.bulk',
    `${project.name}: ${valid.length} phase${valid.length === 1 ? '' : 's'} uploaded to To do${skipped.length ? `, ${skipped.length} skipped` : ''}`)
  res.json({ added: valid.length, skipped })
})

r.patch('/phases/:id', requireCap('phases.edit'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const phase = await db.phase.findFirst({
    where: { id: +req.params.id, project: { clientId: req.client.id } },
    include: PHASE_INCLUDE,
  })
  if (!phase || !inScope(scope, phase.projectId)) return res.status(404).json({ error: 'Phase not found' })

  const data = {}
  // Manual percent only applies while a phase has no key insights; otherwise it is derived.
  if (req.body.percent != null && !phase.insights.length) {
    const pct = Number(req.body.percent)
    if (!Number.isFinite(pct)) return res.status(400).json({ error: 'Percent must be a number' })
    data.percent = Math.max(0, Math.min(100, Math.round(pct)))
  }
  if (req.body.status) {
    if (!PHASE_STATUS.includes(req.body.status))
      return res.status(400).json({ error: `Status must be one of: ${PHASE_STATUS.join(', ')}` })
    data.status = req.body.status
  }
  const assignee = await resolveAssignee(req)
  if (assignee.error) return res.status(400).json({ error: assignee.error })
  if (!assignee.skip) data.assigneeId = assignee.assigneeId

  // Editable details
  if (req.body.name !== undefined && String(req.body.name).trim()) data.name = String(req.body.name).trim()
  if (req.body.budget !== undefined) data.budget = Number(req.body.budget) || 0
  if (req.body.crewRates !== undefined || req.body.costPerBuilder !== undefined || req.body.costPerHelper !== undefined)
    data.crewRates = ratesFromBody(req.body) ?? Prisma.DbNull
  for (const k of ['startDate', 'endDate'])
    if (req.body[k] !== undefined) data[k] = req.body[k] ? new Date(req.body[k]) : null
  if (['name', 'budget', 'crewRates', 'startDate', 'endDate'].some(k => k in data))
    await audit(req.client.id, req.user.name, 'phase.edited', data.name ?? phase.name)

  if (data.status === 'done') {
    // All key insights must be complete before sign-off.
    if (phase.insights.length && phase.insights.some(i => !i.done))
      return res.status(400).json({ error: 'Complete all key insights first - the phase reaches 100% when every insight is done' })
    // PRD 4.6: photo proof required before a phase can be marked done.
    const hasPhoto = phase.updates.some(u => u.media.some(m => m.kind === 'photo')) ||
      phase.insights.some(i => (i.media ?? []).some(m => m.kind === 'photo'))
    if (!hasPhoto) return res.status(400).json({ error: 'Photo proof required: attach a photo to an insight or submit a daily update with a photo before closing this phase' })
    data.percent = 100
    data.signedOffAt = new Date()
    data.signedOffBy = req.user.name
    await audit(req.client.id, req.user.name, 'phase.signedoff', phase.name)
    // Notify the account admins: dashboard banner (recent sign-offs) + email.
    const owners = settingsOf(req.client).emailPhaseDone
      ? await db.user.findMany({ where: { clientId: req.client.id, role: 'CLIENT' } })
      : []
    sendMail(owners.map(o => o.email), `Phase completed: ${phase.name} (${phase.project.name})`, {
      title: 'Phase completed ✔',
      lines: [
        `<b>${req.user.name}</b> signed off the phase <b>"${phase.name}"</b> on <b>${phase.project.name}</b>.`,
        'The full completion report - duration, budget vs actual, workers and their pay, materials used - is ready for you.',
      ],
      buttonText: 'Open the phase report',
      buttonUrl: `${APP_URL}/#/phases/${phase.id}/report`,
    })
  }
  if (data.status === 'active' && phase.status === 'todo')
    await audit(req.client.id, req.user.name, 'phase.started', phase.name)

  // Reopening a signed-off phase: audit it and notify the client directly.
  if (['active', 'todo'].includes(data.status) && phase.status === 'done') {
    data.signedOffAt = null
    data.signedOffBy = null
    // The phase is no longer complete, and the dashboard's phase-completion
    // bars read the stored percent - step it back down. Phases with a
    // checklist recompute from their insights; manual phases drop to 90%
    // (In progress) or 0% (To do) and the engineer sets the real figure
    // from the board's percent input.
    if (phase.insights.length) data.percent = derivedPercent(phase)
    else data.percent = data.status === 'active' ? 90 : 0
    const label = data.status === 'active' ? 'In progress' : 'To do'
    await audit(req.client.id, req.user.name, 'phase.reopened', `${phase.name} → ${label}`)
    const owners = await db.user.findMany({
      where: { clientId: req.client.id, role: 'CLIENT', NOT: { id: req.user.id } },
    })
    if (owners.length) {
      const text = `⚠️ Phase "${phase.name}" (${phase.project.name}) was moved back to ${label} by ${req.user.name} - its sign-off has been reopened.`
      await db.message.createMany({
        data: owners.map(o => ({
          clientId: req.client.id, userId: req.user.id, recipientId: o.id, text,
        })),
      })
    }
  }

  const updated = await db.phase.update({ where: { id: phase.id }, data, include: PHASE_INCLUDE })
  const { byPhase } = await wagesForProjects(req.client.id, [phase.projectId])
  res.json(shapePhase(updated, byPhase.get(phase.id)))
})

// Delete a phase: drawn materials go back to stock, daily updates keep their
// history (detached from the phase), insights are removed with it.
r.delete('/phases/:id', requireCap('phases.edit'), async (req, res) => {
  if (!(await phaseInScope(req, +req.params.id))) return res.status(404).json({ error: 'Phase not found' })
  const phase = await db.phase.findFirst({
    where: { id: +req.params.id, project: { clientId: req.client.id } },
    include: { materials: true },
  })
  if (!phase) return res.status(404).json({ error: 'Phase not found' })

  await db.$transaction([
    ...phase.materials.map(m =>
      db.stockItem.update({ where: { id: m.stockItemId }, data: { qty: { increment: m.qty } } })),
    db.phaseMaterial.deleteMany({ where: { phaseId: phase.id } }),
    db.dailyUpdate.updateMany({ where: { phaseId: phase.id }, data: { phaseId: null } }),
    db.attendanceSession.updateMany({ where: { phaseId: phase.id }, data: { phaseId: null } }),
    db.keyInsight.deleteMany({ where: { phaseId: phase.id } }),
    db.phase.delete({ where: { id: phase.id } }),
  ])
  const returned = phase.materials.length
    ? ` (${phase.materials.map(m => `${m.qty} ${m.nameSnap}`).join(', ')} returned to stock)`
    : ''
  await audit(req.client.id, req.user.name, 'phase.deleted', phase.name + returned)
  res.json({ ok: true })
})

// ---- Key insights: the checklist that drives phase completion ----

r.post('/phases/:id/insights', requireCap('phases.edit'), async (req, res) => {
  const phase = await phaseInScope(req, +req.params.id)
  if (!phase) return res.status(404).json({ error: 'Phase not found' })
  const title = (req.body.title ?? '').trim()
  if (!title) return res.status(400).json({ error: 'Insight title is required' })
  const count = await db.keyInsight.count({ where: { phaseId: phase.id } })
  const insight = await db.keyInsight.create({
    data: { phaseId: phase.id, title, orderIdx: count },
  })
  await syncPhasePercent(phase.id)
  await audit(req.client.id, req.user.name, 'insight.added', `${phase.name} › ${title}`)
  res.json(insight)
})

// Ticking an insight is site work - SENIOR and SITE (updates.submit) can do it.
r.patch('/insights/:id', requireCap('updates.submit'), async (req, res) => {
  const found = await phaseForInsight(req, +req.params.id)
  if (!found) return res.status(404).json({ error: 'Insight not found' })
  const done = !!req.body.done
  await db.keyInsight.update({
    where: { id: found.id },
    data: { done, doneAt: done ? new Date() : null, doneBy: done ? req.user.name : null },
  })
  await syncPhasePercent(found.phaseId)
  await audit(req.client.id, req.user.name, done ? 'insight.done' : 'insight.reopened',
    `${found.phase.name} › ${found.title}`)
  res.json({ ok: true })
})

// Attach photo/file proof to an insight.
r.post('/insights/:id/proof', requireCap('updates.submit'), upload.array('media', 6), async (req, res) => {
  const found = await phaseForInsight(req, +req.params.id)
  if (!found) { discardUploads(req); return res.status(404).json({ error: 'Insight not found' }) }
  const added = (req.files ?? []).map(f => ({
    kind: f.mimetype?.startsWith('video') ? 'video' : f.mimetype?.startsWith('image') ? 'photo' : 'file',
    path: f.filename, name: f.originalname || f.filename,
  }))
  if (!added.length) return res.status(400).json({ error: 'No files received' })
  const media = [...(found.media ?? []), ...added]
  await db.keyInsight.update({ where: { id: found.id }, data: { media } })
  await audit(req.client.id, req.user.name, 'insight.proof', `${found.phase.name} › ${found.title} (${added.length} file${added.length === 1 ? '' : 's'})`)
  res.json({ ok: true, media })
})

r.delete('/insights/:id', requireCap('phases.edit'), async (req, res) => {
  const found = await phaseForInsight(req, +req.params.id)
  if (!found) return res.status(404).json({ error: 'Insight not found' })
  await db.keyInsight.delete({ where: { id: found.id } })
  await syncPhasePercent(found.phaseId)
  await audit(req.client.id, req.user.name, 'insight.removed', `${found.phase.name} › ${found.title}`)
  res.json({ ok: true })
})

// Draw materials from stock into a phase (PRD 4.6: item must exist in stock first).
r.post('/phases/:id/materials', requireCap('phases.edit'), async (req, res) => {
  const phase = await phaseInScope(req, +req.params.id)
  if (!phase) return res.status(404).json({ error: 'Phase not found' })
  const { stockItemId, qty } = req.body
  const item = await db.stockItem.findFirst({ where: { id: +stockItemId, clientId: req.client.id } })
  if (!item) return res.status(400).json({ error: 'Item is not in stock - add it to stock first' })
  const n = Math.floor(Number(qty))
  if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Quantity must be a positive number' })
  if (item.qty < n) return res.status(400).json({ error: `Only ${item.qty} ${item.unit} in stock` })

  // The availability check above is advisory - it can go stale between here and
  // the write. The decrement below only matches rows that still have enough, so
  // two concurrent draws can never take the quantity negative.
  const result = await db.$transaction(async (tx) => {
    const taken = await tx.stockItem.updateMany({
      where: { id: item.id, qty: { gte: n } },
      data: { qty: { decrement: n } },
    })
    if (!taken.count) return null
    return tx.phaseMaterial.create({
      data: { phaseId: phase.id, stockItemId: item.id, nameSnap: item.name, qty: n, unitCostSnap: item.unitCost },
    })
  })
  if (!result) return res.status(409).json({ error: `${item.name} ran out while you were drawing it - refresh and try again` })

  await audit(req.client.id, req.user.name, 'phase.material', `${n} ${item.unit} ${item.name} → ${phase.name}`)
  checkLowStock(req.client, { ...item, qty: item.qty - n }, item.qty)
  res.json(result)
})

// ---- Schedule PDF: the Gantt plan as a downloadable file with letterhead ----

const GANTT_PDF = {
  colors: { todo: '#94a3b8', active: '#f59e0b', done: '#16a34a', today: '#dc2626', grid: '#e5e7eb', month: '#c3c9d2' },
  statusText: { todo: 'To do', active: 'In progress', done: 'Done' },
}

r.get('/:id/schedule.pdf', requireCap('schedule.view'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({
    where: { id: +req.params.id, clientId: req.client.id },
    include: { phases: { orderBy: { orderIdx: 'asc' }, include: { assignee: { select: { name: true } } } } },
  })
  if (!project || !inScope(scope, project.id)) return res.status(404).json({ error: 'Project not found' })

  const { default: PDFDocument } = await import('pdfkit')
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition',
    `attachment; filename="schedule-${project.name.replace(/[^\w-]+/g, '-')}.pdf"`)
  doc.pipe(res)

  const M = 40
  const W = doc.page.width - M * 2
  const C = GANTT_PDF.colors

  // Letterhead: the client's own branding logo when set, platform logo otherwise.
  const logoPath = [
    ...(req.client.logo ? [path.join(UPLOADS, req.client.logo)] : []),
    path.resolve('../web/public/logo.png'),
    path.resolve('../logo.png'),
  ].find(p => fs.existsSync(p))
  if (logoPath) { try { doc.image(logoPath, M, 36, { fit: [44, 44] }) } catch { /* text letterhead still stands */ } }
  const textX = logoPath ? M + 56 : M
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#10151d').text(req.client.company, textX, 38)
  doc.font('Helvetica').fontSize(9).fillColor('#64748b')
    .text(`TIN: ${req.client.tin ?? '-'}   ·   ${req.client.location ?? '-'}   ·   ${req.client.contact ?? '-'}`, textX, 58)
  doc.fontSize(9).fillColor('#334155')
    .text(`Project schedule - ${project.name}  ·  generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`, textX, 71)
  doc.moveTo(M, 90).lineTo(M + W, 90).lineWidth(1.5).strokeColor(C.month).stroke()

  const dated = project.phases.filter(p => p.startDate && p.endDate)
  const undated = project.phases.filter(p => !p.startDate || !p.endDate)

  if (!dated.length) {
    doc.font('Helvetica').fontSize(11).fillColor('#64748b')
      .text('No phases with both start and end dates yet - set dates on the phase cards and the schedule draws itself.', M, 110, { width: W })
    doc.end()
    return
  }

  // Timeline (whole months, like the on-screen chart)
  const min0 = new Date(Math.min(...dated.map(p => +new Date(p.startDate))))
  const max0 = new Date(Math.max(...dated.map(p => +new Date(p.endDate))))
  const tMin = new Date(min0.getFullYear(), min0.getMonth(), 1)
  const tMax = new Date(max0.getFullYear(), max0.getMonth() + 1, 0)
  const totalDays = Math.round((tMax - tMin) / 86400000) + 1
  const LABEL = 175
  const CHART = W - LABEL
  const xOf = (d) => M + LABEL + (Math.round((new Date(d) - tMin) / 86400000) / totalDays) * CHART

  const months = []
  for (let d = new Date(tMin); d <= tMax; d = new Date(d.getFullYear(), d.getMonth() + 1, 1))
    months.push({ x: xOf(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) })
  const weekXs = []
  for (let i = 7; i < totalDays; i += 7) weekXs.push(M + LABEL + (i / totalDays) * CHART)
  const now = new Date()
  const todayX = now >= tMin && now <= tMax ? xOf(now) : null

  const ROW = 26
  const monthStrip = (y) => {
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#64748b')
    months.forEach((m, i) => {
      const next = months[i + 1]?.x ?? M + LABEL + CHART
      doc.text(m.label.toUpperCase(), m.x, y + 3, { width: next - m.x, align: 'center' })
    })
    return y + 16
  }
  const block = (y, rows) => {
    const h = rows.length * ROW
    // grid first, bars on top
    weekXs.forEach(x => doc.moveTo(x, y).lineTo(x, y + h).lineWidth(0.5).strokeColor(C.grid).stroke())
    months.forEach(m => doc.moveTo(m.x, y).lineTo(m.x, y + h).lineWidth(0.75).strokeColor(C.month).stroke())
    rows.forEach((ph, i) => {
      const ry = y + i * ROW
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#10151d')
        .text(ph.name, M, ry + 3, { width: LABEL - 12, ellipsis: true, lineBreak: false })
      doc.font('Helvetica').fontSize(7).fillColor('#94a3b8')
        .text(`${new Date(ph.startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${new Date(ph.endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}${ph.assignee ? ' · ' + ph.assignee.name : ''}`,
          M, ry + 13, { width: LABEL - 12, ellipsis: true, lineBreak: false })
      const x1 = xOf(ph.startDate)
      const x2 = Math.max(x1 + 6, xOf(ph.endDate) + CHART / totalDays)
      // Defensive: an unrecognised status would hand pdfkit `undefined` and
      // throw mid-stream, after the PDF headers have already gone out.
      doc.roundedRect(x1, ry + 5, x2 - x1, ROW - 11, 3).fillColor(C[ph.status] ?? C.todo).fill()
      if (x2 - x1 > 34) {
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff')
          .text(`${ph.percent}%`, x1, ry + 9, { width: x2 - x1, align: 'center', lineBreak: false })
      }
    })
    if (todayX != null) doc.moveTo(todayX, y - 2).lineTo(todayX, y + h + 2).lineWidth(1.2).strokeColor(C.today).stroke()
    return y + h
  }

  // Paginate rows
  let y = 102
  let rest = [...dated]
  while (rest.length) {
    y = monthStrip(y)
    const capacity = Math.max(1, Math.floor((doc.page.height - 60 - y) / ROW))
    const page = rest.slice(0, capacity)
    rest = rest.slice(capacity)
    y = block(y, page)
    if (rest.length) { doc.addPage(); y = M }
  }

  // Legend + unscheduled note
  y += 14
  doc.font('Helvetica').fontSize(8)
  let lx = M
  for (const [k, label] of Object.entries(GANTT_PDF.statusText)) {
    doc.circle(lx + 4, y + 4, 4).fillColor(C[k]).fill()
    doc.fillColor('#334155').text(label, lx + 12, y, { lineBreak: false })
    lx += 12 + doc.widthOfString(label) + 18
  }
  doc.circle(lx + 4, y + 4, 4).fillColor(C.today).fill()
  doc.fillColor('#334155').text('Today', lx + 12, y, { lineBreak: false })
  if (undated.length) {
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text(`Not on the schedule (no dates yet): ${undated.map(p => p.name).join(', ')}`, M, y + 16, { width: W })
  }
  doc.end()
})

// ---- Phase report: the completion summary the admin opens from the dashboard ----

r.get('/phases/:id/report', requireCap('phases.view'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const phase = await db.phase.findFirst({
    where: { id: +req.params.id, project: { clientId: req.client.id } },
    include: {
      assignee: { select: { name: true } },
      materials: true,
      insights: { orderBy: { orderIdx: 'asc' } },
      updates: { include: { media: true, materials: true, user: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      project: { select: { id: true, name: true, currency: true } },
    },
  })
  if (!phase || !inScope(scope, phase.projectId)) return res.status(404).json({ error: 'Phase not found' })
  const showMoney = can(req, 'stock.amounts')

  // Wages with the same first-clock-in-wins rule used everywhere: walk the
  // whole project's sessions so a worker paid on another phase that day is
  // not charged here too, then keep only this phase's share.
  const sessions = await db.attendanceSession.findMany({
    where: { clientId: req.client.id, projectId: phase.projectId },
    include: { records: { include: { worker: { select: { id: true, name: true, type: true, dailyRate: true } } } } },
    orderBy: { id: 'asc' },
  })
  const seen = new Set()
  const wageDays = new Set()
  const workers = new Map() // workerId → { name, type, days, pay }
  const daily = new Map() // day → { wages, workers, materials }
  const bump = (day, field, v) => {
    const c = daily.get(day) ?? { wages: 0, workers: 0, materials: 0 }
    c[field] += v
    daily.set(day, c)
  }
  let wagesTotal = 0
  for (const s of sessions) {
    const day = dayKey(s.date)
    for (const rec of s.records) {
      if (!rec.worker || !rec.clockInAt) continue // team-member badges earn no wages
      const key = `${rec.workerId}|${day}`
      if (seen.has(key)) continue
      seen.add(key)
      if (s.phaseId !== phase.id) continue
      const amount = rec.rateSnap ?? rec.worker.dailyRate ?? 0
      wagesTotal += amount
      wageDays.add(day)
      const w = workers.get(rec.workerId) ?? { name: rec.worker.name, type: rec.worker.type, days: 0, pay: 0 }
      w.days += 1
      w.pay += amount
      workers.set(rec.workerId, w)
      bump(day, 'wages', amount)
      bump(day, 'workers', 1)
    }
  }

  // Crew estimate only on days with no attendance wages (no double counting).
  let crewEstimate = 0
  for (const u of phase.updates) {
    if (!wageDays.has(dayKey(u.createdAt)))
      crewEstimate += crewCost(u, phase)
  }

  // Materials: drawn from stock via the phase + consumed in its daily reports.
  const materials = [
    ...phase.materials.map(m => ({
      name: m.nameSnap, qty: m.qty, cost: m.qty * m.unitCostSnap, source: 'drawn', at: m.createdAt,
    })),
    ...phase.updates.flatMap(u => (u.materials ?? []).map(m => ({
      name: m.nameSnap, qty: m.qty, cost: m.qty * m.unitCostSnap, source: 'report', at: m.createdAt,
    }))),
  ]
  for (const m of materials) bump(dayKey(new Date(m.at)), 'materials', m.cost)
  const materialsTotal = materials.reduce((s, m) => s + m.cost, 0)
  const spent = wagesTotal + crewEstimate + materialsTotal

  // Duration: planned from the phase dates; actual from first activity
  // (attendance, update or stock draw) to sign-off (or latest activity).
  const activityDates = [
    ...[...daily.keys()].map(d => new Date(d + 'T00:00:00')),
    ...phase.updates.map(u => u.createdAt),
    ...phase.materials.map(m => m.createdAt),
  ].sort((a, b) => a - b)
  const startedAt = phase.startDate ?? activityDates[0] ?? phase.createdAt
  const endedAt = phase.signedOffAt ?? activityDates[activityDates.length - 1] ?? new Date()
  const spanDays = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000) + 1)
  const actualDays = spanDays(startedAt, endedAt)
  const plannedDays = phase.startDate && phase.endDate ? spanDays(phase.startDate, phase.endDate) : null

  const money = (v) => (showMoney ? v : null)
  res.json({
    id: phase.id, name: phase.name, status: phase.status, percent: derivedPercent(phase),
    project: phase.project.name, projectId: phase.project.id, currency: phase.project.currency,
    assignee: phase.assignee?.name ?? null,
    startDate: phase.startDate, endDate: phase.endDate,
    signedOffAt: phase.signedOffAt, signedOffBy: phase.signedOffBy,
    startedAt, endedAt, plannedDays, actualDays,
    budget: money(phase.budget),
    wages: money(wagesTotal),
    crewEstimate: money(crewEstimate),
    materialsTotal: money(materialsTotal),
    spent: money(spent),
    variance: money(phase.budget - spent),
    workerDays: [...workers.values()].reduce((s, w) => s + w.days, 0),
    workers: [...workers.values()]
      .sort((a, b) => b.pay - a.pay || a.name.localeCompare(b.name))
      .map(w => ({ name: w.name, type: w.type, days: w.days, pay: money(w.pay) })),
    materials: materials.map(m => ({ name: m.name, qty: m.qty, source: m.source, cost: money(m.cost) })),
    daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({
      day, workers: c.workers,
      wages: money(c.wages), materials: money(c.materials), spend: money(c.wages + c.materials),
    })),
    insights: phase.insights.map(i => ({ title: i.title, done: i.done, doneBy: i.doneBy, doneAt: i.doneAt })),
    updatesCount: phase.updates.length,
    photos: phase.updates.reduce((s, u) => s + u.media.filter(m => m.kind === 'photo').length, 0),
  })
})

// ---- Daily updates ----

r.get('/updates', requireCap('updates.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const where = { clientId: req.client.id, ...(ids ? { projectId: { in: ids } } : {}) }
  // Admins and guests see only updates the Senior Engineer forwarded (PRD 4.8):
  // the admin holds every capability, but daily reports still reach them
  // through the usual submit → forward chain.
  if (req.user.role === 'CLIENT' || req.user.role === 'GUEST') where.forwarded = true
  const updates = await db.dailyUpdate.findMany({
    where,
    include: { media: true, materials: true, user: { select: { name: true, photo: true } }, project: { select: { name: true } }, phase: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const download = can(req, 'media.download')
  const showMoney = can(req, 'stock.amounts') // Stock Manager & co. never see amounts

  // Same-day context for each report: who attended (with their pay) and which
  // materials were drawn - batch-fetched over the whole window, matched in JS.
  let sessions = [], draws = []
  if (updates.length) {
    const projectIds = [...new Set(updates.map(u => u.projectId))]
    const times = updates.map(u => u.createdAt.getTime())
    const from = new Date(Math.min(...times)); from.setHours(0, 0, 0, 0)
    const to = new Date(Math.max(...times)); to.setHours(23, 59, 59, 999)
    ;[sessions, draws] = await Promise.all([
      db.attendanceSession.findMany({
        where: { clientId: req.client.id, projectId: { in: projectIds }, date: { gte: from, lte: to } },
        include: { records: { include: { worker: { select: { name: true, type: true, dailyRate: true } } } } },
        orderBy: { id: 'asc' },
      }),
      db.phaseMaterial.findMany({
        where: { createdAt: { gte: from, lte: to }, phase: { project: { clientId: req.client.id, id: { in: projectIds } } } },
        include: { phase: { select: { projectId: true } } },
      }),
    ])
  }

  const dayContext = (u) => {
    const day = dayKey(u.createdAt)
    let daySessions = sessions.filter(s => s.projectId === u.projectId && dayKey(s.date) === day)
    // A phase-scoped report narrows to that phase's sessions when any exist.
    if (u.phaseId && daySessions.some(s => s.phaseId === u.phaseId))
      daySessions = daySessions.filter(s => s.phaseId === u.phaseId)
    const seen = new Set()
    const workers = []
    let wages = 0
    for (const s of daySessions) {
      for (const rec of s.records) {
        if (!rec.worker || !rec.clockInAt || seen.has(rec.workerId)) continue
        seen.add(rec.workerId)
        const amount = rec.rateSnap ?? rec.worker.dailyRate ?? 0
        wages += amount
        workers.push({ name: rec.worker.name, type: rec.worker.type, ...(showMoney ? { amount } : {}) })
      }
    }
    const items = [
      // Items this report itself consumed (deducted from stock on submit)...
      ...(u.materials ?? []).map(m =>
        ({ name: m.nameSnap, qty: m.qty, unit: m.unitSnap, ...(showMoney ? { cost: m.qty * m.unitCostSnap } : {}) })),
      // ...plus materials drawn into the phase from stock the same day.
      ...draws
        .filter(m => m.phase.projectId === u.projectId && dayKey(m.createdAt) === day &&
          (!u.phaseId || m.phaseId === u.phaseId))
        .map(m => ({ name: m.nameSnap, qty: m.qty, ...(showMoney ? { cost: m.qty * m.unitCostSnap } : {}) })),
    ]
    return {
      attendance: workers.length
        ? { workers, total: showMoney ? wages : null }
        : null,
      materialsUsed: items.length
        ? { items, total: showMoney ? items.reduce((s, i) => s + (i.cost ?? 0), 0) : null }
        : null,
    }
  }

  res.json(updates.map(u => ({
    id: u.id, by: u.user.name, byPhoto: u.user.photo ? '/uploads/' + u.user.photo : null,
    project: u.project.name, phase: u.phase?.name ?? null,
    crew: crewOf(u),
    note: u.note, geotag: u.geotag,
    forwarded: u.forwarded, createdAt: u.createdAt,
    media: u.media.map(m => ({ id: m.id, kind: m.kind, url: '/uploads/' + path.basename(m.path) })),
    canDownload: download,
    ...dayContext(u),
  })))
})

r.post('/updates', requireCap('updates.submit'), upload.array('media', 12), async (req, res) => {
  // Daily reports flow upward (PRD 4.8): the site team submits, the Senior
  // Engineer forwards, the Admin receives. The Admin never submits their own
  // even though the role holds every other capability.
  if (req.user.role === 'CLIENT')
    return res.status(403).json({ error: 'Daily updates are submitted by the site team - they reach you once the Senior Engineer forwards them' })
  const { projectId, phaseId, note, geotag } = req.body
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +projectId, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) { discardUploads(req); return res.status(400).json({ error: 'Pick a project' }) }

  // The phase was previously trusted as-is. Any id was accepted, including one
  // belonging to another company - the update then showed up in that company's
  // phase report, inflating its spend and satisfying its photo-proof gate.
  let phase = null
  if (phaseId) {
    phase = await db.phase.findFirst({ where: { id: +phaseId, projectId: project.id } })
    if (!phase) { discardUploads(req); return res.status(400).json({ error: 'That phase is not part of this project' }) }
  }

  // Crew on site: [{ type, count }] per worker type. Normally sent by the form
  // (pulled automatically from today's attendance, plus manual additions); if
  // absent, it is derived from attendance right here so the report never
  // misses who was on site. A page still running the previous version sends
  // builders/helpers counts instead; they are read as those two types.
  let crew = []
  if (req.body.crew) {
    try { crew = JSON.parse(req.body.crew) } catch { return res.status(400).json({ error: 'Bad crew payload' }) }
  } else if (req.body.builders || req.body.helpers) {
    crew = [{ type: 'builder', count: req.body.builders }, { type: 'helper', count: req.body.helpers }]
  }
  crew = (Array.isArray(crew) ? crew : [])
    .map(c => ({ type: String(c.type ?? '').trim().toLowerCase().slice(0, 40), count: Math.floor(Number(c.count)) }))
    .filter(c => c.type && c.count > 0)
    .slice(0, 30)
  if (!crew.length) {
    // auto-derive from today's attendance for this project (and phase)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const sessions = await db.attendanceSession.findMany({
      where: {
        clientId: req.client.id, projectId: project.id, date: { gte: today },
        ...(phase ? { phaseId: phase.id } : {}),
      },
      include: { records: { include: { worker: { select: { type: true } } } } },
    })
    const seen = new Set()
    const byType = new Map()
    for (const s of sessions) for (const rec of s.records) {
      if (!rec.worker || !rec.clockInAt || seen.has(rec.workerId)) continue
      seen.add(rec.workerId)
      byType.set(rec.worker.type, (byType.get(rec.worker.type) ?? 0) + 1)
    }
    crew = [...byType.entries()].map(([type, count]) => ({ type, count }))
  }
  // Merge duplicate type rows.
  const merged = new Map()
  for (const c of crew) merged.set(c.type, (merged.get(c.type) ?? 0) + c.count)
  crew = [...merged.entries()].map(([type, count]) => ({ type, count }))

  // Items used today: validated against stock and deducted on submit so the
  // report closes the day with accurate quantities. Snapshots keep the report
  // true even if the stock item is edited later.
  let items = []
  if (req.body.items) {
    try { items = JSON.parse(req.body.items) } catch { discardUploads(req); return res.status(400).json({ error: 'Bad items payload' }) }
  }
  const wanted = new Map() // stockItemId → qty (duplicate rows merged)
  for (const i of Array.isArray(items) ? items : []) {
    const id = +i.stockItemId, qty = Math.floor(Number(i.qty))
    if (id && qty > 0) wanted.set(id, (wanted.get(id) ?? 0) + qty)
  }
  const draws = []
  for (const [stockItemId, qty] of wanted) {
    const item = await db.stockItem.findFirst({
      where: { id: stockItemId, clientId: req.client.id, OR: [{ projectId: null }, { projectId: project.id }] },
    })
    if (!item) { discardUploads(req); return res.status(400).json({ error: 'An item is not in this project\'s stock - add it to stock first' }) }
    if (item.qty < qty) { discardUploads(req); return res.status(400).json({ error: `Only ${item.qty} ${item.unit} of ${item.name} in stock` }) }
    draws.push({ item, qty })
  }

  const update = await db.$transaction(async (tx) => {
    // Same guard as the phase draw: only decrement rows that still hold enough,
    // so two reports submitted at once cannot push stock negative.
    for (const d of draws) {
      const taken = await tx.stockItem.updateMany({
        where: { id: d.item.id, qty: { gte: d.qty } },
        data: { qty: { decrement: d.qty } },
      })
      if (!taken.count) {
        const err = new Error(`${d.item.name} ran out while you were submitting - refresh and try again`)
        err.status = 409
        throw err
      }
    }
    const u = await tx.dailyUpdate.create({
      data: {
        clientId: req.client.id, projectId: project.id,
        phaseId: phase?.id ?? null, userId: req.user.id,
        crew: crew.length ? crew : undefined,
        note: note || null, geotag: geotag || null,
        media: {
          create: (req.files ?? []).map(f => ({
            kind: f.mimetype?.startsWith('video') ? 'video' : 'photo',
            path: f.filename,
          })),
        },
      },
      include: { media: true },
    })
    for (const d of draws) {
      await tx.updateMaterial.create({
        data: {
          updateId: u.id, stockItemId: d.item.id, nameSnap: d.item.name,
          unitSnap: d.item.unit, qty: d.qty, unitCostSnap: d.item.unitCost,
        },
      })
    }
    return u
  }).catch((e) => {
    discardUploads(req)
    throw e
  })
  // Low-stock alerts for anything this report just consumed
  for (const d of draws)
    checkLowStock(req.client, { ...d.item, qty: d.item.qty - d.qty }, d.item.qty)

  const itemNote = draws.length
    ? `, used ${draws.map(d => `${d.qty} ${d.item.unit} ${d.item.name}`).join(', ')}`
    : ''
  await audit(req.client.id, req.user.name, 'update.submitted',
    `${project.name}: ${crewSummary(crew)}, ${update.media.length} media${itemNote}`)

  // Email the Senior Engineers that a daily report landed (the submitter is
  // skipped - they know). The Admin is NOT emailed here: reports reach them
  // through the forward chain, so their email fires on forward instead.
  const phaseName = update.phaseId
    ? (await db.phase.findFirst({ where: { id: update.phaseId }, select: { name: true } }))?.name
    : null
  const recipients = settingsOf(req.client).emailDailyReport
    ? await db.user.findMany({
        where: { clientId: req.client.id, role: 'SENIOR', NOT: { id: req.user.id } },
      })
    : []
  sendMail(recipients.map(u => u.email), `Daily report submitted - ${project.name}`, {
    title: 'Daily report submitted',
    lines: [
      `<b>${req.user.name}</b> submitted a daily report for <b>${project.name}</b>${phaseName ? ` › <b>${phaseName}</b>` : ''}.`,
      `Crew on site: ${crewSummary(crew)}${update.media.length ? ` · ${update.media.length} photo/video${update.media.length === 1 ? '' : 's'}` : ''}.`,
      draws.length ? `Items used: ${draws.map(d => `${d.qty} ${d.item.unit} ${d.item.name}`).join(', ')}.` : '',
      update.note ? `Note: &ldquo;${String(update.note).slice(0, 200)}&rdquo;` : '',
    ].filter(Boolean),
    buttonText: 'Open daily updates',
    buttonUrl: `${APP_URL}/#/updates`,
  })
  res.json(update)
})

r.post('/updates/:id/forward', requireCap('updates.forward'), async (req, res) => {
  // Updating straight away turned an unknown (or another company's) id into a
  // 500 rather than a 404.
  const exists = await db.dailyUpdate.findFirst({
    where: { id: +req.params.id, clientId: req.client.id }, select: { id: true },
  })
  if (!exists) return res.status(404).json({ error: 'Daily report not found' })
  const u = await db.dailyUpdate.update({
    where: { id: exists.id },
    data: { forwarded: true },
    include: {
      project: { select: { name: true } },
      phase: { select: { name: true } },
      user: { select: { name: true } },
      media: { select: { id: true } },
    },
  })
  await audit(req.client.id, req.user.name, 'update.forwarded', `update #${u.id} → client`)

  // The Admin's email fires here - only once the Senior Engineer forwards the
  // report to them (mirrors the in-app submit → forward → admin chain).
  if (settingsOf(req.client).emailDailyReport) {
    const admins = await db.user.findMany({
      where: { clientId: req.client.id, role: 'CLIENT', NOT: { id: req.user.id } },
    })
    sendMail(admins.map(a => a.email), `Daily report forwarded - ${u.project.name}`, {
      title: 'Daily report forwarded to you',
      lines: [
        `<b>${req.user.name}</b> forwarded ${u.user.name}'s daily report for <b>${u.project.name}</b>${u.phase ? ` › <b>${u.phase.name}</b>` : ''}.`,
        `Crew on site: ${crewSummary(crewOf(u))}${u.media.length ? ` · ${u.media.length} photo/video${u.media.length === 1 ? '' : 's'}` : ''}.`,
        u.note ? `Note: &ldquo;${String(u.note).slice(0, 200)}&rdquo;` : '',
      ].filter(Boolean),
      buttonText: 'Open daily updates',
      buttonUrl: `${APP_URL}/#/updates`,
    })
  }
  res.json({ ok: true })
})

export default r
