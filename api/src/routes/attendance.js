import { Router } from 'express'
import QRCode from 'qrcode'
import { db, audit } from '../db.js'
import { requireCap, settingsOf, can } from '../auth.js'
import { scopedProjectIds, projectScopeWhere, inScope } from '../scope.js'
import { photoUpload } from './account.js'
import { genCardId } from '../cards.js'

const r = Router()

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }

// ---- Time windows (optional, from client settings) ----

const toMins = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

// Which window is open right now: 'in' | 'out' | null (closed)
function currentWindow(set) {
  const now = new Date()
  const mins = now.getHours() * 60 + now.getMinutes()
  if (mins >= toMins(set.attInStart) && mins < toMins(set.attInEnd)) return 'in'
  if (mins >= toMins(set.attOutStart) && mins < toMins(set.attOutEnd)) return 'out'
  return null
}

function windowsInfo(client) {
  const set = settingsOf(client)
  if (!set.attWindows) return { enabled: false }
  return {
    enabled: true,
    inStart: set.attInStart, inEnd: set.attInEnd,
    outStart: set.attOutStart, outEnd: set.attOutEnd,
    current: currentWindow(set),
  }
}

const closedWindowError = (set) =>
  `Attendance is closed right now - clock-in ${set.attInStart}–${set.attInEnd}, clock-out ${set.attOutStart}–${set.attOutEnd}`

// Lazy day-cycle handling, run before any attendance operation:
// 1) stale open sessions from previous days are swept + closed and re-opened today
// 2) with time windows on, today's sessions auto-CLOSE after the clock-out window
// 3) with time windows on, this morning's session auto-OPENS (same scope as
//    yesterday's) once the clock-in window starts.
async function rolloverStale(client) {
  const clientId = client.id
  const today = startOfToday()
  const stale = await db.attendanceSession.findMany({
    where: { clientId, NOT: { mode: 'closed' }, date: { lt: today } },
    orderBy: { id: 'desc' }, // most recent scope becomes the live one
  })
  const liveSeen = new Set()
  for (const s of stale) {
    const endOfDay = new Date(s.date)
    endOfDay.setHours(23, 59, 0, 0)
    await db.attendanceRecord.updateMany({
      where: { sessionId: s.id, clockOutAt: null, NOT: { clockInAt: null } },
      data: { clockOutAt: endOfDay, outMethod: 'auto', outBy: 'auto-close 00:00' },
    })
    await db.attendanceSession.update({
      where: { id: s.id },
      data: { mode: 'closed', closedAt: endOfDay, closedBy: 'system (00:00)' },
    })
    const live = !liveSeen.has(s.projectId)
    liveSeen.add(s.projectId)
    await db.attendanceSession.create({
      data: {
        clientId, projectId: s.projectId, phaseId: s.phaseId, date: today,
        mode: 'in', paused: !live, openedBy: 'system (00:00)',
      },
    })
  }

  const set = settingsOf(client)
  if (!set.attWindows) return
  const now = new Date()
  const mins = now.getHours() * 60 + now.getMinutes()

  // evening: past the clock-out window → close today's open sessions
  if (mins >= toMins(set.attOutEnd)) {
    const open = await db.attendanceSession.findMany({
      where: { clientId, date: { gte: today }, NOT: { mode: 'closed' } },
    })
    for (const s of open) {
      const end = new Date(today)
      const [h, m] = set.attOutEnd.split(':').map(Number)
      end.setHours(h, m, 0, 0)
      await db.attendanceRecord.updateMany({
        where: { sessionId: s.id, clockOutAt: null, NOT: { clockInAt: null } },
        data: { clockOutAt: end, outMethod: 'auto', outBy: `system (after ${set.attOutEnd})` },
      })
      await db.attendanceSession.update({
        where: { id: s.id },
        data: { mode: 'closed', closedAt: end, closedBy: `system (${set.attOutEnd})` },
      })
    }
    return
  }

  // morning/day: clock-in window has started → reopen yesterday's scope if
  // nothing exists for the project today yet
  if (mins >= toMins(set.attInStart)) {
    const yStart = new Date(today.getTime() - 86400000)
    const yesterday = await db.attendanceSession.findMany({
      where: { clientId, date: { gte: yStart, lt: today } },
      orderBy: { id: 'desc' },
    })
    const seen = new Set()
    for (const s of yesterday) {
      if (seen.has(s.projectId)) continue
      seen.add(s.projectId)
      const todayAny = await db.attendanceSession.findFirst({
        where: { clientId, projectId: s.projectId, date: { gte: today } },
      })
      if (todayAny) continue
      await db.attendanceSession.create({
        data: { clientId, projectId: s.projectId, phaseId: s.phaseId, date: today, mode: 'in', openedBy: `system (${set.attInStart})` },
      })
    }
  }
}

const SESSION_INCLUDE = {
  project: { select: { name: true } },
  phase: { select: { name: true } },
  records: {
    include: {
      worker: { select: { id: true, name: true, type: true, dailyRate: true, photo: true } },
      user: { select: { id: true, name: true, role: true, photo: true } },
    },
  },
}

// A record belongs to a worker OR a team member (user) - same card namespace.
function recordPerson(rec) {
  if (rec.worker) return { name: rec.worker.name, type: rec.worker.type, photo: rec.worker.photo }
  if (rec.user) return { name: rec.user.name, type: rec.user.role.toLowerCase(), photo: rec.user.photo }
  return null
}

function shapeSession(s, client) {
  return {
    id: s.id, projectId: s.projectId, project: s.project.name,
    phaseId: s.phaseId, phase: s.phase?.name ?? null,
    date: s.date, mode: s.mode, paused: s.paused, openedBy: s.openedBy, closedBy: s.closedBy,
    windows: windowsInfo(client),
    records: s.records.map(rec => {
      const p = recordPerson(rec)
      return {
        workerId: rec.workerId, userId: rec.userId, name: p?.name ?? '—', type: p?.type ?? '',
        photo: p?.photo ? '/uploads/' + p.photo : null,
        clockInAt: rec.clockInAt, clockOutAt: rec.clockOutAt,
        inMethod: rec.inMethod, outMethod: rec.outMethod, inBy: rec.inBy, outBy: rec.outBy,
      }
    }),
  }
}

// Card ids come from the shared generator (src/cards.js): C<companyId>-<6
// chars>, unique across workers AND team members - one scan namespace.

// ---- Workers (enrolled manually once; then they tap their card daily) ----

// Worker types come from Settings › Access control (admin-defined site roles).
// Unknown input falls back to the first configured type.
function resolveWorkerType(client, raw) {
  const types = settingsOf(client).workerTypes ?? ['builder', 'helper']
  const wanted = String(raw ?? '').trim().toLowerCase()
  return types.find(t => t.toLowerCase() === wanted) ?? types[0] ?? 'builder'
}

// Optional project assignment for a worker - must exist and be in scope.
async function resolveWorkerProject(req, scope) {
  if (!req.body.projectId) return { projectId: null }
  const project = await db.project.findFirst({ where: { id: +req.body.projectId, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return { error: 'Project not found' }
  return { projectId: project.id, projectName: project.name }
}

r.get('/workers', requireCap('attendance.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const workers = await db.worker.findMany({
    where: { clientId: req.client.id, ...projectScopeWhere(ids) },
    include: { project: { select: { id: true, name: true } } },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })
  res.json(workers.map(w => ({
    id: w.id, name: w.name, type: w.type, phone: w.phone,
    cardId: w.cardId, dailyRate: w.dailyRate, active: w.active,
    photo: w.photo ? '/uploads/' + w.photo : null,
    projectId: w.projectId, projectName: w.project?.name ?? null,
  })))
})

// Optional worker photo - shown instead of the initials avatar everywhere.
r.post('/workers/:id/photo', requireCap('workers.manage'), photoUpload.single('photo'), async (req, res) => {
  const worker = await db.worker.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!worker) return res.status(404).json({ error: 'Worker not found' })
  if (!req.file) return res.status(400).json({ error: 'Pick an image file' })
  await db.worker.update({ where: { id: worker.id }, data: { photo: req.file.filename } })
  await audit(req.client.id, req.user.name, 'worker.photo', worker.name)
  res.json({ photo: '/uploads/' + req.file.filename })
})

r.delete('/workers/:id/photo', requireCap('workers.manage'), async (req, res) => {
  const worker = await db.worker.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!worker) return res.status(404).json({ error: 'Worker not found' })
  await db.worker.update({ where: { id: worker.id }, data: { photo: null } })
  res.json({ photo: null })
})

r.post('/workers', requireCap('workers.manage'), async (req, res) => {
  const name = (req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Worker name is required' })
  const scope = await scopedProjectIds(req)
  const proj = await resolveWorkerProject(req, scope)
  if (proj.error) return res.status(404).json({ error: proj.error })
  const cardId = await genCardId(req.client.id)
  const worker = await db.worker.create({
    data: {
      clientId: req.client.id, projectId: proj.projectId, name,
      type: resolveWorkerType(req.client, req.body.type),
      phone: (req.body.phone ?? '').trim() || null,
      cardId,
      dailyRate: req.body.dailyRate ? Number(req.body.dailyRate) || null : null,
    },
  })
  await audit(req.client.id, req.user.name, 'worker.added',
    `${name} (${worker.type}) · card ${cardId}${proj.projectName ? ' · ' + proj.projectName : ''}`)
  res.json(worker)
})

// Bulk enrolment from the CSV template. Valid rows are created; problem rows
// come back with the reason so nothing fails silently.
r.post('/workers/bulk', requireCap('workers.manage'), async (req, res) => {
  const rows = Array.isArray(req.body.workers) ? req.body.workers.slice(0, 500) : []
  if (!rows.length) return res.status(400).json({ error: 'No rows found in the file' })

  const scope = await scopedProjectIds(req)
  const proj = await resolveWorkerProject(req, scope)
  if (proj.error) return res.status(404).json({ error: proj.error })

  const valid = []
  const skipped = []

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const line = i + 2 // header is line 1 in the template
    const name = String(raw.name ?? '').trim()
    if (!name) { skipped.push({ line, name: raw.name ?? '', reason: 'Missing name' }); continue }
    valid.push({
      clientId: req.client.id, projectId: proj.projectId, name,
      type: resolveWorkerType(req.client, raw.type),
      phone: String(raw.phone ?? '').trim() || null,
      cardId: await genCardId(req.client.id),
      dailyRate: Number(raw.dailyRate) || null,
    })
  }

  if (valid.length) await db.worker.createMany({ data: valid })
  await audit(req.client.id, req.user.name, 'worker.bulk',
    `${valid.length} enrolled${skipped.length ? `, ${skipped.length} skipped` : ''}`)
  res.json({ added: valid.length, skipped })
})

r.patch('/workers/:id', requireCap('workers.manage'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const worker = await db.worker.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!worker || (worker.projectId && !inScope(scope, worker.projectId)))
    return res.status(404).json({ error: 'Worker not found' })
  const data = {}
  if (req.body.projectId !== undefined) {
    const proj = await resolveWorkerProject(req, scope)
    if (proj.error) return res.status(404).json({ error: proj.error })
    data.projectId = proj.projectId
  }
  if (req.body.name !== undefined && String(req.body.name).trim()) data.name = String(req.body.name).trim()
  if (req.body.type !== undefined) data.type = resolveWorkerType(req.client, req.body.type)
  if (req.body.phone !== undefined) data.phone = String(req.body.phone).trim() || null
  if (req.body.dailyRate !== undefined) data.dailyRate = Number(req.body.dailyRate) || null
  if (req.body.active !== undefined) data.active = !!req.body.active
  if (req.body.cardId !== undefined) {
    const cardId = String(req.body.cardId).trim() || null
    if (cardId) {
      const taken = await db.worker.findFirst({ where: { clientId: req.client.id, cardId } })
      if (taken && taken.id !== worker.id)
        return res.status(409).json({ error: 'That card is already assigned to another worker' })
    }
    data.cardId = cardId
  }
  const updated = await db.worker.update({ where: { id: worker.id }, data })
  await audit(req.client.id, req.user.name, 'worker.edited', updated.name)
  res.json(updated)
})

// Badge sheet: QR per worker for printable cards (works with phone-camera
// scanning today; RFID card ids print as text for card-based readers).
r.get('/workers/badges', requireCap('attendance.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const workers = await db.worker.findMany({
    where: { clientId: req.client.id, active: true, ...projectScopeWhere(ids) },
    include: { project: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  const shaped = []
  for (const w of workers) {
    let cardId = w.cardId
    if (!cardId) { // backfill workers enrolled before auto-generation
      cardId = await genCardId(req.client.id)
      await db.worker.update({ where: { id: w.id }, data: { cardId } })
    }
    shaped.push({
      id: w.id, name: w.name, type: w.type, phone: w.phone, cardId,
      photo: w.photo ? '/uploads/' + w.photo : null,
      projectId: w.projectId, projectName: w.project?.name ?? null,
      qr: await QRCode.toDataURL(cardId, { margin: 1, width: 140 }),
    })
  }
  // Team members carry QR badges too (scanned when stock is issued to them) -
  // generated automatically at creation, backfilled here for older accounts.
  const users = await db.user.findMany({
    where: { clientId: req.client.id },
    orderBy: { name: 'asc' },
  })
  const team = []
  for (const u of users) {
    let cardId = u.cardId
    if (!cardId) {
      cardId = await genCardId(req.client.id)
      await db.user.update({ where: { id: u.id }, data: { cardId } })
    }
    team.push({
      id: u.id, name: u.name, role: u.role, cardId,
      photo: u.photo ? '/uploads/' + u.photo : null,
      qr: await QRCode.toDataURL(cardId, { margin: 1, width: 140 }),
    })
  }
  res.json({
    company: req.client.company, contact: req.client.contact,
    logo: req.client.logo ? '/uploads/' + req.client.logo : '/logo.png',
    workers: shaped,
    team,
  })
})

// ---- Issued cards (every "Generate card" is recorded and downloadable) ----

r.post('/cards', requireCap('attendance.view'), async (req, res) => {
  // Engineers issue cards; the client (admin) can too.
  if (!can(req, 'workers.manage') && req.user.role !== 'CLIENT')
    return res.status(403).json({ error: 'Only engineers or the client can generate cards' })

  // Team-member card: same flow, recorded against the user instead of a worker.
  if (req.body.userId) {
    const member = await db.user.findFirst({ where: { id: +req.body.userId, clientId: req.client.id } })
    if (!member) return res.status(404).json({ error: 'Team member not found' })
    let cardId = member.cardId
    if (!cardId) {
      cardId = await genCardId(req.client.id)
      await db.user.update({ where: { id: member.id }, data: { cardId } })
    }
    const issue = await db.cardIssue.create({
      data: { clientId: req.client.id, userId: member.id, cardId, issuedBy: req.user.name },
    })
    await audit(req.client.id, req.user.name, 'card.issued', `${member.name} (${member.role}) · ${cardId}`)
    return res.json(issue)
  }

  const worker = await db.worker.findFirst({ where: { id: +req.body.workerId, clientId: req.client.id } })
  if (!worker) return res.status(404).json({ error: 'Worker not found' })
  let cardId = worker.cardId
  if (!cardId) {
    cardId = await genCardId(req.client.id)
    await db.worker.update({ where: { id: worker.id }, data: { cardId } })
  }
  const issue = await db.cardIssue.create({
    data: { clientId: req.client.id, workerId: worker.id, cardId, issuedBy: req.user.name },
  })
  await audit(req.client.id, req.user.name, 'card.issued', `${worker.name} · ${cardId}`)
  res.json(issue)
})

r.get('/cards', requireCap('attendance.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const issues = await db.cardIssue.findMany({
    where: {
      clientId: req.client.id,
      ...(ids ? {
        OR: [
          { worker: { OR: [{ projectId: null }, { projectId: { in: ids } }] } },
          { userId: { not: null } }, // team-member cards are not project-scoped
        ],
      } : {}),
    },
    include: {
      worker: { select: { name: true, type: true, phone: true, active: true, photo: true, projectId: true, project: { select: { name: true } } } },
      user: { select: { name: true, role: true, photo: true, suspended: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  const shaped = []
  for (const i of issues) {
    const p = i.worker
      ? { name: i.worker.name, type: i.worker.type, phone: i.worker.phone, active: i.worker.active, photo: i.worker.photo, projectId: i.worker.projectId, projectName: i.worker.project?.name ?? null }
      : { name: i.user?.name ?? '—', type: (i.user?.role ?? '').toLowerCase(), phone: null, active: !i.user?.suspended, photo: i.user?.photo, projectId: null, projectName: null }
    shaped.push({
      id: i.id, workerId: i.workerId, userId: i.userId, cardId: i.cardId,
      name: p.name, type: p.type, phone: p.phone, active: p.active,
      photo: p.photo ? '/uploads/' + p.photo : null,
      projectId: p.projectId, projectName: p.projectName,
      issuedBy: i.issuedBy, createdAt: i.createdAt,
      qr: await QRCode.toDataURL(i.cardId, { margin: 1, width: 140 }),
    })
  }
  res.json({
    company: req.client.company, contact: req.client.contact,
    logo: req.client.logo ? '/uploads/' + req.client.logo : '/logo.png',
    cards: shaped,
  })
})

// ---- Sessions ----

// All of today's sessions for a project - several phases can run the same day.
r.get('/sessions/today', requireCap('attendance.view'), async (req, res) => {
  await rolloverStale(req.client)
  const ids = await scopedProjectIds(req)
  if (!inScope(ids, +req.query.projectId || 0)) return res.json([])
  const sessions = await db.attendanceSession.findMany({
    where: {
      clientId: req.client.id, projectId: +req.query.projectId || 0,
      date: { gte: startOfToday() },
    },
    include: SESSION_INCLUDE,
    orderBy: { id: 'asc' },
  })
  res.json(sessions.map(s => shapeSession(s, req.client)))
})

// Active session for a project today (auto-rolls over stale days)
r.get('/sessions/active', requireCap('attendance.view'), async (req, res) => {
  await rolloverStale(req.client)
  const ids = await scopedProjectIds(req)
  if (!inScope(ids, +req.query.projectId || 0)) return res.json(null)
  const session = await db.attendanceSession.findFirst({
    where: {
      clientId: req.client.id, projectId: +req.query.projectId || 0,
      date: { gte: startOfToday() }, NOT: { mode: 'closed' },
    },
    include: SESSION_INCLUDE,
    orderBy: { id: 'desc' },
  })
  res.json(session ? shapeSession(session, req.client) : null)
})

r.get('/sessions/:id', requireCap('attendance.view'), async (req, res) => {
  await rolloverStale(req.client)
  const session = await db.attendanceSession.findFirst({
    where: { id: +req.params.id, clientId: req.client.id },
    include: SESSION_INCLUDE,
  })
  if (!session) return res.status(404).json({ error: 'Session not found' })
  res.json(shapeSession(session, req.client))
})

// Start a session ("record per phase?" → pass phaseId; otherwise project-wide)
r.post('/sessions', requireCap('attendance.session'), async (req, res) => {
  await rolloverStale(req.client)
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +req.body.projectId, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return res.status(404).json({ error: 'Project not found' })
  let phaseId = null
  if (req.body.phaseId) {
    const phase = await db.phase.findFirst({ where: { id: +req.body.phaseId, projectId: project.id } })
    if (!phase) return res.status(404).json({ error: 'Phase not found' })
    phaseId = phase.id
  }
  // Many sessions may be open per day, but exactly ONE is live (receiving taps)
  // per project. Opening/activating a phase pauses the current one - it stays
  // open so its clock-out can happen later.
  const open = await db.attendanceSession.findMany({
    where: {
      clientId: req.client.id, projectId: project.id,
      date: { gte: startOfToday() }, NOT: { mode: 'closed' },
    },
    include: SESSION_INCLUDE,
  })
  const same = open.find(s => s.phaseId === phaseId)
  const pauseLive = () => db.attendanceSession.updateMany({
    where: {
      clientId: req.client.id, projectId: project.id,
      date: { gte: startOfToday() }, NOT: { mode: 'closed' }, paused: false,
      ...(same ? { NOT: [{ mode: 'closed' }, { id: same.id }] } : {}),
    },
    data: { paused: true },
  })
  if (same) {
    if (same.paused) {
      await pauseLive()
      const revived = await db.attendanceSession.update({
        where: { id: same.id }, data: { paused: false }, include: SESSION_INCLUDE,
      })
      await audit(req.client.id, req.user.name, 'attendance.activated',
        `${project.name}${revived.phase ? ' › ' + revived.phase.name : ''}`)
      return res.json(shapeSession(revived, req.client))
    }
    return res.json(shapeSession(same, req.client)) // already live → reuse
  }
  await pauseLive()
  const session = await db.attendanceSession.create({
    data: { clientId: req.client.id, projectId: project.id, phaseId, date: startOfToday(), mode: 'in', openedBy: req.user.name },
    include: SESSION_INCLUDE,
  })
  await audit(req.client.id, req.user.name, 'attendance.session.started',
    `${project.name}${phaseId ? ' › phase ' + phaseId : ''}`)
  res.json(shapeSession(session, req.client))
})

// Flip clock-in/clock-out mode (any recorder), or close the session (managers)
r.patch('/sessions/:id', requireCap('attendance.record'), async (req, res) => {
  const session = await db.attendanceSession.findFirst({
    where: { id: +req.params.id, clientId: req.client.id },
    include: { project: { select: { name: true } } },
  })
  if (!session) return res.status(404).json({ error: 'Session not found' })
  if (session.mode === 'closed') return res.status(400).json({ error: 'Session is closed' })

  if (req.body.action === 'mode') {
    const mode = req.body.mode === 'out' ? 'out' : 'in'
    await db.attendanceSession.update({ where: { id: session.id }, data: { mode } })
    await audit(req.client.id, req.user.name, 'attendance.mode', `${session.project.name} → clock-${mode}`)
    return res.json({ ok: true, mode })
  }

  // "Move into" this session: it becomes live; the currently live one pauses
  // (stays open, e.g. for a later clock-out).
  if (req.body.action === 'activate') {
    if (!session.paused) return res.json({ ok: true, alreadyActive: true })
    await db.attendanceSession.updateMany({
      where: {
        clientId: req.client.id, projectId: session.projectId,
        date: { gte: startOfToday() }, NOT: { mode: 'closed' }, paused: false,
      },
      data: { paused: true },
    })
    await db.attendanceSession.update({ where: { id: session.id }, data: { paused: false } })
    await audit(req.client.id, req.user.name, 'attendance.activated', session.project.name)
    return res.json({ ok: true })
  }

  // Explicit bulk clock-out: everyone recorded at clock-in gets clocked out now.
  if (req.body.action === 'outAll') {
    const swept = await db.attendanceRecord.updateMany({
      where: { sessionId: session.id, clockOutAt: null, NOT: { clockInAt: null } },
      data: { clockOutAt: new Date(), outMethod: 'manual', outBy: req.user.name + ' (all)' },
    })
    await audit(req.client.id, req.user.name, 'attendance.outAll',
      `${session.project.name} · ${swept.count} clocked out`)
    return res.json({ ok: true, clockedOut: swept.count })
  }

  if (req.body.action === 'close') {
    // Anyone who may run sessions may close them (admins, Senior Engineers,
    // and Stock Managers when the admin granted them attendance).
    if (!can(req, 'attendance.session'))
      return res.status(403).json({ error: 'Only an admin or a senior engineer can close a session' })
    // A session only closes once clock-out is done - nobody may still be clocked in.
    const stillIn = await db.attendanceRecord.count({
      where: { sessionId: session.id, clockOutAt: null, NOT: { clockInAt: null } },
    })
    if (stillIn > 0)
      return res.status(400).json({
        error: `${stillIn} worker${stillIn === 1 ? ' is' : 's are'} still clocked in - switch to clock-out and record them (or use "Clock out everyone") before closing`,
      })
    await db.attendanceSession.update({
      where: { id: session.id },
      data: { mode: 'closed', closedAt: new Date(), closedBy: req.user.name },
    })
    await audit(req.client.id, req.user.name, 'attendance.session.closed', session.project.name)
    return res.json({ ok: true })
  }

  res.status(400).json({ error: 'Unknown action' })
})

// ---- Recording ----

async function openSession(req, id) {
  await rolloverStale(req.client)
  return db.attendanceSession.findFirst({
    where: { id, clientId: req.client.id, NOT: { mode: 'closed' } },
  })
}

// Card tap (kiosk / USB HID reader) → auto record
r.post('/sessions/:id/scan', requireCap('attendance.record'), async (req, res) => {
  const session = await openSession(req, +req.params.id)
  if (!session) return res.status(400).json({ error: 'Session is closed - ask a manager to start one' })
  if (session.paused) return res.status(400).json({ error: 'This phase is paused - activate it on the Attendance page first' })
  const cardId = String(req.body.cardId ?? '').trim()
  if (!cardId) return res.status(400).json({ error: 'Empty scan' })
  // One card namespace: the scan may be a worker's card or a team member's badge.
  const worker = await db.worker.findFirst({ where: { clientId: req.client.id, cardId, active: true } })
  const member = worker ? null : await db.user.findFirst({ where: { clientId: req.client.id, cardId, suspended: false } })
  if (!worker && !member) return res.status(404).json({ error: 'Card not recognised - worker needs enrolment', unknown: true })

  // With time windows on, the time of day decides in/out - late arrivals are refused.
  const set = settingsOf(req.client)
  let action = session.mode
  if (set.attWindows) {
    const win = currentWindow(set)
    if (!win) return res.status(400).json({ error: closedWindowError(set) })
    action = win
  }

  // Team member scan: same in/out flow, no daily-rate snapshot (staff are not
  // paid from attendance) - their presence still shows in sessions and reports.
  if (member) {
    const who = { name: member.name, type: member.role.toLowerCase() }
    const existing = await db.attendanceRecord.findUnique({
      where: { sessionId_userId: { sessionId: session.id, userId: member.id } },
    })
    if (action === 'in') {
      if (existing?.clockInAt) return res.json({ action: 'dup', worker: who, at: existing.clockInAt })
      const rec = existing
        ? await db.attendanceRecord.update({ where: { id: existing.id }, data: { clockInAt: new Date(), inMethod: 'auto', inBy: 'card' } })
        : await db.attendanceRecord.create({ data: { sessionId: session.id, userId: member.id, clockInAt: new Date(), inMethod: 'auto', inBy: 'card' } })
      return res.json({ action: 'in', worker: who, at: rec.clockInAt })
    }
    if (!existing?.clockInAt) return res.status(400).json({ error: `${member.name} was never clocked in today`, worker: { name: member.name } })
    if (existing.clockOutAt) return res.json({ action: 'dup-out', worker: who, at: existing.clockOutAt })
    const rec = await db.attendanceRecord.update({
      where: { id: existing.id },
      data: { clockOutAt: new Date(), outMethod: 'auto', outBy: 'card' },
    })
    return res.json({ action: 'out', worker: who, at: rec.clockOutAt })
  }

  const existing = await db.attendanceRecord.findUnique({
    where: { sessionId_workerId: { sessionId: session.id, workerId: worker.id } },
  })

  if (action === 'in') {
    if (existing?.clockInAt) {
      return res.json({ action: 'dup', worker: { name: worker.name, type: worker.type }, at: existing.clockInAt })
    }
    const rec = existing
      ? await db.attendanceRecord.update({ where: { id: existing.id }, data: { clockInAt: new Date(), inMethod: 'auto', inBy: 'card', rateSnap: worker.dailyRate } })
      : await db.attendanceRecord.create({ data: { sessionId: session.id, workerId: worker.id, clockInAt: new Date(), inMethod: 'auto', inBy: 'card', rateSnap: worker.dailyRate } })
    return res.json({ action: 'in', worker: { name: worker.name, type: worker.type }, at: rec.clockInAt })
  }

  // clock-out mode
  if (!existing?.clockInAt) return res.status(400).json({ error: `${worker.name} was never clocked in today`, worker: { name: worker.name } })
  if (existing.clockOutAt) return res.json({ action: 'dup-out', worker: { name: worker.name, type: worker.type }, at: existing.clockOutAt })
  const rec = await db.attendanceRecord.update({
    where: { id: existing.id },
    data: { clockOutAt: new Date(), outMethod: 'auto', outBy: 'card' },
  })
  res.json({ action: 'out', worker: { name: worker.name, type: worker.type }, at: rec.clockOutAt })
})

// Manual tick by an engineer / stock manager (toggles, labelled 'manual')
r.post('/sessions/:id/tick', requireCap('attendance.record'), async (req, res) => {
  const session = await openSession(req, +req.params.id)
  if (!session) return res.status(400).json({ error: 'Session is closed' })
  if (session.paused) return res.status(400).json({ error: 'This phase is paused - activate it on the Attendance page first' })
  const worker = await db.worker.findFirst({ where: { id: +req.body.workerId, clientId: req.client.id, active: true } })
  if (!worker) return res.status(404).json({ error: 'Worker not found' })

  // Manual ticks follow the session mode, but must still fall inside the window.
  const set = settingsOf(req.client)
  if (set.attWindows) {
    const win = currentWindow(set)
    if (session.mode === 'in' && win !== 'in')
      return res.status(400).json({ error: `Clock-in window is ${set.attInStart}–${set.attInEnd} - this arrival is not recorded` })
    if (session.mode === 'out' && win !== 'out')
      return res.status(400).json({ error: `Clock-out window is ${set.attOutStart}–${set.attOutEnd}` })
  }

  const existing = await db.attendanceRecord.findUnique({
    where: { sessionId_workerId: { sessionId: session.id, workerId: worker.id } },
  })

  if (session.mode === 'in') {
    if (existing?.clockOutAt) return res.status(400).json({ error: `${worker.name} already completed today` })
    if (existing?.clockInAt) { // untick = undo a manual mistake
      await db.attendanceRecord.delete({ where: { id: existing.id } })
      return res.json({ action: 'undo-in' })
    }
    await db.attendanceRecord.create({
      data: { sessionId: session.id, workerId: worker.id, clockInAt: new Date(), inMethod: 'manual', inBy: req.user.name, rateSnap: worker.dailyRate },
    })
    return res.json({ action: 'in' })
  }

  if (!existing?.clockInAt) return res.status(400).json({ error: `${worker.name} was never clocked in` })
  if (existing.clockOutAt) {
    await db.attendanceRecord.update({ where: { id: existing.id }, data: { clockOutAt: null, outMethod: null, outBy: null } })
    return res.json({ action: 'undo-out' })
  }
  await db.attendanceRecord.update({
    where: { id: existing.id },
    data: { clockOutAt: new Date(), outMethod: 'manual', outBy: req.user.name },
  })
  res.json({ action: 'out' })
})

// ---- Phase 2: integrations ----

// Today's live head-count for a project/phase - pre-fills daily updates.
r.get('/counts', requireCap('attendance.view'), async (req, res) => {
  await rolloverStale(req.client)
  const where = {
    clientId: req.client.id, date: { gte: startOfToday() },
    ...(req.query.projectId ? { projectId: +req.query.projectId } : {}),
    ...(req.query.phaseId ? { phaseId: +req.query.phaseId } : {}),
  }
  const sessions = await db.attendanceSession.findMany({
    where, include: { records: { include: { worker: { select: { type: true } } } } },
  })
  const seen = new Set()
  let builders = 0, helpers = 0
  for (const s of sessions) {
    for (const rec of s.records) {
      if (!rec.worker) continue // team-member scans are not crew head-count
      if (!rec.clockInAt || seen.has(rec.workerId)) continue
      seen.add(rec.workerId)
      if (rec.worker.type === 'helper') helpers++
      else builders++
    }
  }
  res.json({ builders, helpers })
})

// Attendance report over a date range → rows per worker, columns per day.
r.get('/report', requireCap('attendance.view'), async (req, res) => {
  await rolloverStale(req.client)
  const ids = await scopedProjectIds(req)
  if (req.query.projectId && !inScope(ids, +req.query.projectId)) return res.json({ days: [], rows: [] })
  const from = req.query.from ? new Date(req.query.from + 'T00:00:00') : new Date(Date.now() - 6 * 86400000)
  const to = req.query.to ? new Date(req.query.to + 'T23:59:59') : new Date()
  const sessions = await db.attendanceSession.findMany({
    where: {
      clientId: req.client.id, date: { gte: from, lte: to },
      ...(req.query.projectId ? { projectId: +req.query.projectId } : ids ? { projectId: { in: ids } } : {}),
    },
    include: SESSION_INCLUDE,
    orderBy: { date: 'asc' },
  })
  // Local-date keys (the server runs in the site's timezone) - UTC slicing
  // would shift days for UTC+2.
  const dayKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const days = [...new Set(sessions.map(s => dayKey(s.date)))]
  // Pay is money - hidden from roles without stock.amounts (Stock Manager).
  const showMoney = can(req, 'stock.amounts')
  const rows = {}
  for (const s of sessions) {
    const day = dayKey(s.date)
    for (const rec of s.records) {
      if (!rec.clockInAt) continue
      const p = recordPerson(rec)
      if (!p) continue
      // Team members share the table (keyed apart from workers); they earn no
      // pay from attendance and don't count toward present/absent crew totals.
      const key = rec.workerId ?? 'u' + rec.userId
      const row = rows[key] ??= {
        workerId: rec.workerId, userId: rec.userId, staff: !rec.workerId,
        name: p.name, type: p.type,
        photo: p.photo ? '/uploads/' + p.photo : null,
        days: {}, totalHours: 0, daysPresent: 0, totalPay: 0,
      }
      const hours = rec.clockOutAt
        ? Math.max(0, Math.round((rec.clockOutAt - rec.clockInAt) / 360000) / 10)
        : null
      const method = rec.inMethod === 'auto' && rec.outMethod !== 'manual' ? 'auto' : 'manual'
      const prev = row.days[day]
      if (prev) {
        // Worker recorded on several phase sessions the same day → one merged cell:
        // earliest in, latest out (open if any leg is open), summed hours.
        row.days[day] = {
          in: new Date(prev.in) < rec.clockInAt ? prev.in : rec.clockInAt,
          out: prev.out && rec.clockOutAt
            ? (new Date(prev.out) > rec.clockOutAt ? prev.out : rec.clockOutAt)
            : null,
          hours: prev.hours == null && hours == null
            ? null
            : Math.round(((prev.hours ?? 0) + (hours ?? 0)) * 10) / 10,
          method: prev.method === 'manual' || method === 'manual' ? 'manual' : 'auto',
          project: s.project.name,
          phase: [...new Set(
            [prev.phase, s.phase?.name].filter(Boolean).flatMap(p => p.split(' + '))
          )].join(' + ') || null,
        }
      } else {
        row.days[day] = {
          in: rec.clockInAt, out: rec.clockOutAt, hours, method,
          project: s.project.name, phase: s.phase?.name ?? null,
        }
        row.daysPresent += 1
        // The daily rate is earned once per day, however many phase sessions
        // the worker tapped into. (Team members earn nothing from attendance.)
        row.totalPay += rec.worker ? (rec.rateSnap ?? rec.worker.dailyRate ?? 0) : 0
      }
      row.totalHours = Math.round((row.totalHours + (hours ?? 0)) * 10) / 10
    }
  }
  const shaped = Object.values(rows).sort((a, b) => a.name.localeCompare(b.name))
  if (!showMoney) for (const row of shaped) delete row.totalPay

  // Present vs absent: how many of the active workers in scope showed up,
  // per day and over the whole range.
  const totalWorkers = await db.worker.count({
    where: {
      clientId: req.client.id, active: true,
      ...(req.query.projectId
        ? { OR: [{ projectId: null }, { projectId: +req.query.projectId }] }
        : projectScopeWhere(ids)),
    },
  })
  // Present/absent counts crew only - team-member badges don't shrink "absent".
  const crewRows = shaped.filter(row => !row.staff)
  const dayTotals = {}
  for (const day of days) {
    const present = crewRows.filter(row => row.days[day]).length
    dayTotals[day] = { present, absent: Math.max(0, totalWorkers - present) }
  }
  const presentTotal = crewRows.length
  res.json({
    from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10),
    days, money: showMoney, rows: shaped,
    totalWorkers, dayTotals,
    presentTotal, absentTotal: Math.max(0, totalWorkers - presentTotal),
  })
})

export default r
