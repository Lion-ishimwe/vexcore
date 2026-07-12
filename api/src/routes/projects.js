import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { db, audit } from '../db.js'
import { requireCap, can } from '../auth.js'
import { planLimits } from '../plans.js'
import { scopedProjectIds, inScope } from '../scope.js'

const r = Router()

const UPLOADS = path.resolve('uploads')
fs.mkdirSync(UPLOADS, { recursive: true })
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) =>
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname || '.jpg')),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
})

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Worker wages from attendance: each clocked-in worker earns their daily rate
// once per day (first clock-in wins when several phase sessions ran the same
// day), attributed to that session's phase. The rate is snapshotted on the
// record at clock-in; older records fall back to the worker's current rate.
export async function wagesForProjects(clientId, projectIds) {
  const sessions = await db.attendanceSession.findMany({
    where: { clientId, ...(projectIds ? { projectId: { in: projectIds } } : {}) },
    include: { records: { include: { worker: { select: { name: true, type: true, dailyRate: true } } } } },
    orderBy: { id: 'asc' },
  })
  const seen = new Set() // project|worker|day → already earned that day
  const byPhase = new Map() // phaseId → Map(day → { amount, workers })
  const unphased = new Map() // projectId → wages of project-wide (no phase) sessions
  for (const s of sessions) {
    const day = dayKey(s.date)
    for (const rec of s.records) {
      if (!rec.clockInAt) continue
      const key = `${s.projectId}|${rec.workerId}|${day}`
      if (seen.has(key)) continue
      seen.add(key)
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
      : s + u.builders * phase.costPerBuilder + u.helpers * phase.costPerHelper, 0)
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

function shapePhase(ph, wageDays) {
  const { wages, workerDays, labor, materials, spent } = phaseSpent(ph, wageDays)
  const insightMedia = (ph.insights ?? []).flatMap(i => i.media ?? [])
  return {
    id: ph.id, projectId: ph.projectId, name: ph.name, status: ph.status,
    percent: derivedPercent(ph),
    startDate: ph.startDate, endDate: ph.endDate, budget: ph.budget,
    costPerBuilder: ph.costPerBuilder, costPerHelper: ph.costPerHelper,
    assignee: ph.assignee ? { id: ph.assignee.id, name: ph.assignee.name } : null,
    materials: [
      ...ph.materials.map(m => ({ id: m.id, name: m.nameSnap, qty: m.qty, unitCost: m.unitCostSnap })),
      ...ph.updates.flatMap(u => (u.materials ?? []).map(m =>
        ({ id: 'u' + m.id, name: m.nameSnap, qty: m.qty, unitCost: m.unitCostSnap, fromUpdate: true }))),
    ],
    insights: (ph.insights ?? []).map(i => ({
      id: i.id, title: i.title, done: i.done, doneAt: i.doneAt, doneBy: i.doneBy,
      media: (i.media ?? []).map(m => ({ ...m, url: '/uploads/' + m.path })),
    })),
    wagesSpent: wages, workerDays, laborSpent: labor, materialsSpent: materials, spent,
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
  if (!insights.length) return
  const percent = Math.round(insights.filter(i => i.done).length / insights.length * 100)
  await db.phase.update({ where: { id: phaseId }, data: { percent } })
}

async function phaseForInsight(req, insightId) {
  return db.keyInsight.findFirst({
    where: { id: insightId, phase: { project: { clientId: req.client.id } } },
    include: { phase: true },
  })
}

r.get('/', requireCap('projects.view'), async (req, res) => {
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
  res.json(projects.map(p => {
    const phases = p.phases.map(ph => shapePhase(ph, byPhase.get(ph.id)))
    const percent = phases.length ? Math.round(phases.reduce((s, ph) => s + ph.percent, 0) / phases.length) : 0
    // Wages from project-wide attendance sessions (no phase picked) still cost
    // money - they count in the project total even though no phase shows them.
    const unphasedWages = unphased.get(p.id) ?? 0
    const spent = phases.reduce((s, ph) => s + ph.spent, 0) + unphasedWages + (looseConsumed.get(p.id) ?? 0)
    return {
      id: p.id, name: p.name, location: p.location, status: p.status, currency: p.currency,
      budget: p.budget, documents: p.documents ?? [], percent, spent, unphasedWages, phases,
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
    `${project.name}: ${users.length ? users.map(u => u.name).join(', ') : 'everyone (unassigned)'}`)
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

r.post('/:id/phases', requireCap('phases.edit'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return res.status(404).json({ error: 'Project not found' })
  const { name, budget, costPerBuilder, costPerHelper, startDate, endDate, assigneeId } = req.body
  if (!name) return res.status(400).json({ error: 'Phase name is required' })
  const count = await db.phase.count({ where: { projectId: project.id } })
  const phase = await db.phase.create({
    data: {
      projectId: project.id, name, budget: Number(budget) || 0,
      costPerBuilder: Number(costPerBuilder) || 0, costPerHelper: Number(costPerHelper) || 0,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      assigneeId: assigneeId ? +assigneeId : null,
      orderIdx: count,
    },
  })
  if (project.status === 'Planning')
    await db.project.update({ where: { id: project.id }, data: { status: 'In progress' } })
  await audit(req.client.id, req.user.name, 'phase.created', `${project.name} › ${name}`)
  res.json(phase)
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
  if (req.body.percent != null && !phase.insights.length)
    data.percent = Math.max(0, Math.min(100, +req.body.percent))
  if (req.body.status) data.status = req.body.status
  if (req.body.assigneeId !== undefined) data.assigneeId = req.body.assigneeId ? +req.body.assigneeId : null

  // Editable details
  if (req.body.name !== undefined && String(req.body.name).trim()) data.name = String(req.body.name).trim()
  for (const k of ['budget', 'costPerBuilder', 'costPerHelper'])
    if (req.body[k] !== undefined) data[k] = Number(req.body[k]) || 0
  for (const k of ['startDate', 'endDate'])
    if (req.body[k] !== undefined) data[k] = req.body[k] ? new Date(req.body[k]) : null
  if (['name', 'budget', 'costPerBuilder', 'costPerHelper', 'startDate', 'endDate'].some(k => k in data))
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
    // Notify the account admins on their dashboard (recent sign-offs section).
  }
  if (data.status === 'active' && phase.status === 'todo')
    await audit(req.client.id, req.user.name, 'phase.started', phase.name)

  // Reopening a signed-off phase: audit it and notify the client directly.
  if (['active', 'todo'].includes(data.status) && phase.status === 'done') {
    data.signedOffAt = null
    data.signedOffBy = null
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
  const phase = await db.phase.findFirst({
    where: { id: +req.params.id, project: { clientId: req.client.id } },
  })
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
  if (!found) return res.status(404).json({ error: 'Insight not found' })
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
  const phase = await db.phase.findFirst({
    where: { id: +req.params.id, project: { clientId: req.client.id } },
  })
  if (!phase) return res.status(404).json({ error: 'Phase not found' })
  const { stockItemId, qty } = req.body
  const item = await db.stockItem.findFirst({ where: { id: +stockItemId, clientId: req.client.id } })
  if (!item) return res.status(400).json({ error: 'Item is not in stock - add it to stock first' })
  const n = Number(qty)
  if (!n || n <= 0) return res.status(400).json({ error: 'Quantity must be a positive number' })
  if (item.qty < n) return res.status(400).json({ error: `Only ${item.qty} ${item.unit} in stock` })

  const [material] = await db.$transaction([
    db.phaseMaterial.create({
      data: { phaseId: phase.id, stockItemId: item.id, nameSnap: item.name, qty: n, unitCostSnap: item.unitCost },
    }),
    db.stockItem.update({ where: { id: item.id }, data: { qty: { decrement: n } } }),
  ])
  await audit(req.client.id, req.user.name, 'phase.material', `${n} ${item.unit} ${item.name} → ${phase.name}`)
  res.json(material)
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
      if (!rec.clockInAt) continue
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
      crewEstimate += u.builders * phase.costPerBuilder + u.helpers * phase.costPerHelper
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
    include: { media: true, materials: true, user: { select: { name: true } }, project: { select: { name: true } }, phase: { select: { name: true } } },
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
        if (!rec.clockInAt || seen.has(rec.workerId)) continue
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
    id: u.id, by: u.user.name, project: u.project.name, phase: u.phase?.name ?? null,
    builders: u.builders, helpers: u.helpers, note: u.note, geotag: u.geotag,
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
  const { projectId, phaseId, builders, helpers, note, geotag } = req.body
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +projectId, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return res.status(400).json({ error: 'Pick a project' })

  // Items used today: validated against stock and deducted on submit so the
  // report closes the day with accurate quantities. Snapshots keep the report
  // true even if the stock item is edited later.
  let items = []
  if (req.body.items) {
    try { items = JSON.parse(req.body.items) } catch { return res.status(400).json({ error: 'Bad items payload' }) }
  }
  const wanted = new Map() // stockItemId → qty (duplicate rows merged)
  for (const i of Array.isArray(items) ? items : []) {
    const id = +i.stockItemId, qty = Number(i.qty)
    if (id && qty > 0) wanted.set(id, (wanted.get(id) ?? 0) + qty)
  }
  const draws = []
  for (const [stockItemId, qty] of wanted) {
    const item = await db.stockItem.findFirst({
      where: { id: stockItemId, clientId: req.client.id, OR: [{ projectId: null }, { projectId: project.id }] },
    })
    if (!item) return res.status(400).json({ error: 'An item is not in this project\'s stock - add it to stock first' })
    if (item.qty < qty) return res.status(400).json({ error: `Only ${item.qty} ${item.unit} of ${item.name} in stock` })
    draws.push({ item, qty })
  }

  const update = await db.$transaction(async (tx) => {
    const u = await tx.dailyUpdate.create({
      data: {
        clientId: req.client.id, projectId: project.id,
        phaseId: phaseId ? +phaseId : null, userId: req.user.id,
        builders: Number(builders) || 0, helpers: Number(helpers) || 0,
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
      await tx.stockItem.update({ where: { id: d.item.id }, data: { qty: { decrement: d.qty } } })
    }
    return u
  })
  const itemNote = draws.length
    ? `, used ${draws.map(d => `${d.qty} ${d.item.unit} ${d.item.name}`).join(', ')}`
    : ''
  await audit(req.client.id, req.user.name, 'update.submitted',
    `${project.name}: ${update.builders} builders, ${update.helpers} helpers, ${update.media.length} media${itemNote}`)
  res.json(update)
})

r.post('/updates/:id/forward', requireCap('updates.forward'), async (req, res) => {
  const u = await db.dailyUpdate.update({
    where: { id: +req.params.id, clientId: req.client.id },
    data: { forwarded: true },
  })
  await audit(req.client.id, req.user.name, 'update.forwarded', `update #${u.id} → client`)
  res.json({ ok: true })
})

export default r
