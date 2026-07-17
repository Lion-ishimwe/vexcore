import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { db, audit } from '../db.js'
import { requireCap, can, settingsOf, capsFor, DEFAULT_SETTINGS } from '../auth.js'
import { PLANS } from '../plans.js'
import { scopedProjectIds, projectScopeWhere, inScope } from '../scope.js'
import { ensureSystemFolders } from './docs.js'
import { wagesForProjects } from './projects.js'
import { photoUpload } from './account.js'

const r = Router()

const UPLOADS = path.resolve('uploads')
fs.mkdirSync(UPLOADS, { recursive: true })
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) =>
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname || '.bin')),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
})

// ---- Chat ----

// Lightweight member list for @-invites - available to anyone with chat access
// (unlike /api/team, which is restricted to team.view roles). No emails exposed.
r.get('/members', requireCap('chat'), async (req, res) => {
  const users = await db.user.findMany({
    where: { clientId: req.client.id },
    select: { id: true, name: true, role: true, photo: true },
    orderBy: { name: 'asc' },
  })
  res.json(users.map(u => ({ ...u, photo: u.photo ? '/uploads/' + u.photo : null })))
})

function attachmentKind(mimetype = '') {
  if (mimetype.startsWith('audio')) return 'audio'
  if (mimetype.startsWith('image')) return 'image'
  if (mimetype.startsWith('video')) return 'video'
  return 'file'
}

// ?to=all → company channel; ?to=<userId> → private DM thread between me and them
r.get('/messages', requireCap('chat'), async (req, res) => {
  const to = req.query.to
  const me = req.user.id
  const convo = !to || to === 'all'
    ? { recipientId: null }
    : { OR: [{ userId: me, recipientId: +to }, { userId: +to, recipientId: me }] }
  const messages = await db.message.findMany({
    where: { clientId: req.client.id, ...convo },
    include: { user: { select: { name: true, role: true, photo: true } } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  res.json(messages.map(m => ({
    id: m.id, from: m.user.name, role: m.user.role, text: m.text, createdAt: m.createdAt,
    fromPhoto: m.user.photo ? '/uploads/' + m.user.photo : null,
    mine: m.userId === me, recipientId: m.recipientId,
    attachments: (m.attachments ?? []).map(a =>
      a.kind === 'call' ? a : { ...a, url: '/uploads/' + a.path }),
  })))
})

// Conversation summary: latest activity per thread + any live call invite for me.
r.get('/messages/threads', requireCap('chat'), async (req, res) => {
  const me = req.user.id
  const [channelLast, dms, recent] = await Promise.all([
    db.message.findFirst({
      where: { clientId: req.client.id, recipientId: null },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    }),
    db.message.findMany({
      where: { clientId: req.client.id, NOT: { recipientId: null }, OR: [{ userId: me }, { recipientId: me }] },
      orderBy: { createdAt: 'desc' }, take: 300,
      select: { userId: true, recipientId: true, createdAt: true },
    }),
    db.message.findMany({
      where: {
        clientId: req.client.id,
        createdAt: { gte: new Date(Date.now() - 5 * 60000) },
        NOT: { userId: me },
        OR: [{ recipientId: null }, { recipientId: me }],
      },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 30,
    }),
  ])
  const threads = {}
  for (const m of dms) {
    const partner = m.userId === me ? m.recipientId : m.userId
    if (!threads[partner]) threads[partner] = m.createdAt
  }
  let incomingCall = null
  for (const m of recent) {
    const call = (m.attachments ?? []).find(a => a.kind === 'call' && (a.invited ?? []).includes(me))
    if (call) { incomingCall = { msgId: m.id, from: m.user.name, room: call.room }; break }
  }
  res.json({
    channelLastAt: channelLast?.createdAt ?? null,
    threads: Object.entries(threads).map(([userId, lastAt]) => ({ userId: +userId, lastAt })),
    incomingCall,
  })
})

r.post('/messages', requireCap('chat'), upload.array('files', 8), async (req, res) => {
  const text = (req.body.text ?? '').trim()
  const attachments = (req.files ?? []).map(f => ({
    kind: attachmentKind(f.mimetype), path: f.filename, name: f.originalname || f.filename,
  }))
  // A call invite is a message carrying the room name; anyone in the conversation can join,
  // and specifically invited members get pinged in their chat.
  if (req.body.callRoom) {
    let invited = []
    try { invited = JSON.parse(req.body.invited ?? '[]').map(Number).filter(Boolean) } catch { /* ignore bad json */ }
    attachments.push({ kind: 'call', room: String(req.body.callRoom), invited })
  }
  if (!text && !attachments.length) return res.status(400).json({ error: 'Empty message' })

  // Private message: recipient must be a member of the same company.
  let recipientId = null
  if (req.body.recipientId) {
    const recipient = await db.user.findFirst({
      where: { id: +req.body.recipientId, clientId: req.client.id },
    })
    if (!recipient) return res.status(400).json({ error: 'Recipient is not in your company' })
    recipientId = recipient.id
  }

  const m = await db.message.create({
    data: { clientId: req.client.id, userId: req.user.id, text, attachments, recipientId },
  })
  res.json({ id: m.id })
})

// ---- Weather (Open-Meteo, free, no API key) ----

const geoCache = new Map() // place string -> {lat, lon, resolved} | null
const wxCache = new Map() // place string -> { at, data }
const WX_TTL = 15 * 60 * 1000

async function fetchJson(url) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 6000)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    if (!r.ok) throw new Error('http ' + r.status)
    return await r.json()
  } finally { clearTimeout(t) }
}

// Geocode a place, preferring matches in the client's own country (set at
// sign-up) so "Kigali" resolves to Kigali, Rwanda - not a namesake elsewhere.
async function geocode(place, country) {
  const key = `${place}|${country ?? ''}`
  if (geoCache.has(key)) return geoCache.get(key)
  // "Kacyiru, Kigali" → try the full string, then each part, then the first word
  const candidates = [...new Set([
    place,
    ...place.split(',').map(s => s.trim()).filter(Boolean),
    place.split(/[\s,]+/)[0],
  ])]
  let fallback = null
  for (const c of candidates) {
    try {
      const d = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(c)}&count=5&language=en`)
      const results = d?.results ?? []
      if (!fallback && results[0]) fallback = results[0]
      const hit = country
        ? results.find(r => (r.country ?? '').toLowerCase() === country.toLowerCase())
        : results[0]
      if (hit) {
        const g = { lat: hit.latitude, lon: hit.longitude, resolved: hit.name, country: hit.country }
        geoCache.set(key, g)
        return g
      }
    } catch { /* try next candidate */ }
  }
  const g = fallback
    ? { lat: fallback.latitude, lon: fallback.longitude, resolved: fallback.name, country: fallback.country }
    : null
  geoCache.set(key, g)
  return g
}

// WMO weather codes → label + icon category
function wmo(code) {
  if (code === 0) return { label: 'Clear sky', icon: 'sun' }
  if (code <= 2) return { label: 'Partly cloudy', icon: 'partly' }
  if (code === 3) return { label: 'Overcast', icon: 'cloud' }
  if (code <= 48) return { label: 'Fog', icon: 'fog' }
  if (code <= 57) return { label: 'Drizzle', icon: 'drizzle' }
  if (code <= 67 || (code >= 80 && code <= 82)) return { label: 'Rain', icon: 'rain' }
  if (code <= 77 || code === 85 || code === 86) return { label: 'Snow', icon: 'snow' }
  return { label: 'Thunderstorm', icon: 'storm' }
}

r.get('/weather', requireCap('dashboard'), async (req, res) => {
  const projects = await db.project.findMany({
    where: { clientId: req.client.id },
    select: { location: true, name: true },
  })
  const country = req.client.country ?? ''

  // The client's sign-up location leads; every project site follows,
  // labelled with the works running there.
  const sites = []
  if (req.client.location) sites.push({ place: req.client.location, tag: 'hq', works: [] })
  for (const p of projects) {
    if (!p.location) continue
    const existing = sites.find(s => s.place.toLowerCase() === p.location.toLowerCase())
    if (existing) existing.works.push(p.name)
    else sites.push({ place: p.location, tag: null, works: [p.name] })
  }

  const out = []
  for (const site of sites.slice(0, 5)) {
    const cacheKey = `${site.place}|${country}`
    const cached = wxCache.get(cacheKey)
    if (cached && Date.now() - cached.at < WX_TTL) {
      out.push({ ...cached.data, tag: site.tag, works: site.works })
      continue
    }
    const geo = await geocode(site.place, country)
    if (!geo) continue
    try {
      const w = await fetchJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
        `&current=temperature_2m,weather_code,wind_speed_10m` +
        `&daily=weather_code,precipitation_probability_max,temperature_2m_max,temperature_2m_min` +
        `&timezone=auto&forecast_days=7`)
      const days = (w.daily?.time ?? []).map((date, i) => ({
        date,
        ...wmo(w.daily.weather_code?.[i] ?? 0),
        tmax: Math.round(w.daily.temperature_2m_max?.[i] ?? 0),
        tmin: Math.round(w.daily.temperature_2m_min?.[i] ?? 0),
        rain: w.daily.precipitation_probability_max?.[i] ?? null,
      }))
      const item = {
        location: site.place, resolved: geo.resolved, country: geo.country ?? null,
        temp: Math.round(w.current?.temperature_2m ?? 0),
        wind: Math.round(w.current?.wind_speed_10m ?? 0),
        ...wmo(w.current?.weather_code ?? 0),
        rainChance: days[0]?.rain ?? null,
        tmin: days[0]?.tmin ?? 0,
        tmax: days[0]?.tmax ?? 0,
        days,
      }
      wxCache.set(cacheKey, { at: Date.now(), data: item })
      out.push({ ...item, tag: site.tag, works: site.works })
    } catch { /* skip site on upstream failure */ }
  }
  res.json(out)
})

// ---- Dashboard aggregates ----

r.get('/dashboard', requireCap('dashboard'), async (req, res) => {
  const cid = req.client.id
  const ids = await scopedProjectIds(req)
  const [projects, phases, stockItems, consumed, updates] = await Promise.all([
    db.project.findMany({ where: { clientId: cid, ...(ids ? { id: { in: ids } } : {}) } }),
    db.phase.findMany({
      where: { project: { clientId: cid }, ...(ids ? { projectId: { in: ids } } : {}) },
      include: { materials: true, updates: true, project: { select: { name: true } } },
    }),
    db.stockItem.findMany({ where: { clientId: cid, ...projectScopeWhere(ids) } }),
    // Items reported as used in daily updates - deducted from stock on submit.
    db.updateMaterial.findMany({
      where: { update: { clientId: cid, ...(ids ? { projectId: { in: ids } } : {}) } },
    }),
    db.dailyUpdate.findMany({
      where: {
        clientId: cid,
        ...(ids ? { projectId: { in: ids } } : {}),
        ...(req.user.role === 'CLIENT' || req.user.role === 'GUEST' ? { forwarded: true } : {}),
      },
      include: { media: true, user: { select: { name: true, photo: true } }, phase: { select: { name: true } }, project: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 3,
    }),
  ])

  const showMoney = can(req, 'stock.amounts')

  // Same cost model as Projects/Reports: attendance wages + crew estimate
  // (only on days without wages) + materials drawn via phases. Items consumed
  // through daily reports and project-wide (unphased) wages are added below.
  const { byPhase, unphased } = await wagesForProjects(cid, projects.map(p => p.id))
  const dayOf = d =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const phaseSpend = ph => {
    let wages = 0
    const paidDays = new Set()
    for (const [day, cell] of byPhase.get(ph.id) ?? []) { wages += cell.amount; paidDays.add(day) }
    const labor = ph.updates.reduce((s, u) => paidDays.has(dayOf(u.createdAt)) ? s
      : s + u.builders * ph.costPerBuilder + u.helpers * ph.costPerHelper, 0)
    return wages + labor + ph.materials.reduce((s, m) => s + m.qty * m.unitCostSnap, 0)
  }

  const overall = phases.length ? Math.round(phases.reduce((s, p) => s + p.percent, 0) / phases.length) : 0
  const consumedValue = consumed.reduce((s, m) => s + m.qty * m.unitCostSnap, 0)
  const totalSpent = phases.reduce((s, p) => s + phaseSpend(p), 0) + consumedValue +
    [...unphased.values()].reduce((a, b) => a + b, 0)
  const totalBudget = projects.reduce((s, p) => s + p.budget, 0)
  const stockValue = stockItems.reduce((s, i) => s + i.qty * i.unitCost, 0)
  // Stock used = everything that left stock (drawn into phases + consumed in
  // daily reports) vs what remains on the shelves.
  const drawn = phases.flatMap(p => p.materials).reduce((s, m) => s + m.qty * m.unitCostSnap, 0) + consumedValue
  const stockUsedPct = drawn + stockValue > 0 ? Math.round((drawn / (drawn + stockValue)) * 100) : 0

  // Design slider: images in the system "Design" folder, respecting folder
  // restriction and per-document visibility.
  await ensureSystemFolders(cid)
  const designFolder = await db.folder.findFirst({ where: { clientId: cid, name: 'Design', system: true } })
  let designImages = []
  if (designFolder && (!designFolder.restricted || req.user.role === 'CLIENT')) {
    const imgs = await db.document.findMany({
      where: {
        clientId: cid, folderId: designFolder.id, kind: 'image',
        ...(req.user.role === 'CLIENT' ? {} : { OR: [{ visibility: 'public' }, { uploaderId: req.user.id }] }),
      },
      orderBy: { createdAt: 'desc' }, take: 8,
    })
    designImages = imgs.map(d => ({ url: '/uploads/' + d.path, name: d.name }))
  }

  // Sign-off notifications for the account admin: phases completed in the
  // last 30 days, newest first, each linking to its phase report page.
  let completedPhases = []
  if (req.user.role === 'CLIENT') {
    const recent = await db.phase.findMany({
      where: {
        project: { clientId: cid }, ...(ids ? { projectId: { in: ids } } : {}),
        status: 'done', signedOffAt: { gte: new Date(Date.now() - 30 * 86400000) },
      },
      include: { project: { select: { name: true } } },
      orderBy: { signedOffAt: 'desc' },
      take: 5,
    })
    completedPhases = recent.map(p => ({
      id: p.id, name: p.name, project: p.project.name,
      signedOffAt: p.signedOffAt, signedOffBy: p.signedOffBy,
    }))
  }

  res.json({
    designImages,
    completedPhases,
    activeProjects: projects.filter(p => p.status === 'In progress').length,
    totalProjects: projects.length,
    overallPercent: overall,
    totalSpent: showMoney ? totalSpent : null,
    totalBudget: showMoney ? totalBudget : null,
    stockValue: showMoney ? stockValue : null,
    stockUsedPct,
    lowStock: stockItems.filter(i => i.lowThreshold > 0 && i.qty <= i.lowThreshold).map(i => i.name),
    phaseBars: phases.slice(0, 8).map(p => ({ name: p.name, project: p.project.name, percent: p.percent })),
    latestUpdates: updates.map(u => ({
      id: u.id, by: u.user.name, byPhoto: u.user.photo ? '/uploads/' + u.user.photo : null,
      project: u.project.name, phase: u.phase?.name, note: u.note,
      builders: u.builders, helpers: u.helpers, geotag: u.geotag, createdAt: u.createdAt,
      photos: u.media.filter(m => m.kind === 'photo').length,
      videos: u.media.filter(m => m.kind === 'video').length,
    })),
  })
})

// ---- Admin reports hub: one round trip for the whole filtered slice ----
// Money is safe to return: the 'reports' capability belongs to CLIENT and
// SENIOR only, and both hold stock.amounts.

r.get('/reports', requireCap('reports'), async (req, res) => {
  const cid = req.client.id
  const ids = await scopedProjectIds(req)
  const pFilter = +req.query.projectId || null
  const phFilter = +req.query.phaseId || null
  if (pFilter && !inScope(ids, pFilter)) return res.status(404).json({ error: 'Project not found' })
  const from = req.query.from
    ? new Date(req.query.from + 'T00:00:00')
    : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 29); return d })()
  const to = req.query.to
    ? new Date(req.query.to + 'T23:59:59.999')
    : (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d })()
  const inRange = (d) => d >= from && d <= to
  const dayKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const projects = await db.project.findMany({
    where: { clientId: cid, ...(ids ? { id: { in: ids } } : {}), ...(pFilter ? { id: pFilter } : {}) },
    orderBy: { id: 'asc' },
  })
  const projIds = projects.map(p => p.id)

  const [phases, sessions, totalWorkers, stockItems, damagedCount, pendingRequests, auditRows, looseRange] = await Promise.all([
    db.phase.findMany({
      where: { projectId: { in: projIds }, ...(phFilter ? { id: phFilter } : {}) },
      include: {
        materials: true,
        updates: { include: { materials: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: [{ projectId: 'asc' }, { orderIdx: 'asc' }],
    }),
    db.attendanceSession.findMany({
      where: { clientId: cid, projectId: { in: projIds } },
      include: { records: { include: { worker: { select: { id: true, name: true, type: true, dailyRate: true, photo: true } } } } },
      orderBy: { id: 'asc' },
    }),
    db.worker.count({
      where: {
        clientId: cid, active: true,
        ...(pFilter ? { OR: [{ projectId: null }, { projectId: pFilter }] } : projectScopeWhere(ids)),
      },
    }),
    db.stockItem.findMany({ where: { clientId: cid, ...projectScopeWhere(ids) } }),
    db.damagedItem.count({ where: { clientId: cid, createdAt: { gte: from, lte: to } } }),
    db.stockRequest.count({ where: { clientId: cid, status: 'PENDING' } }),
    db.auditLog.findMany({
      where: { clientId: cid, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: 'desc' }, take: 150,
    }),
    // Items consumed by phase-less daily reports (they carry no phase relation)
    phFilter ? [] : db.updateMaterial.findMany({
      where: { createdAt: { gte: from, lte: to }, update: { clientId: cid, phaseId: null, projectId: { in: projIds } } },
    }),
  ])

  // ---- Wages: one pass, first-clock-in-wins per worker/project/day ----
  const seen = new Set()
  const phaseWageDays = new Map()   // phaseId → Map(day → amount) (lifetime)
  const unphasedByProject = new Map() // projectId → lifetime unphased wages
  const wagesByDay = new Map()      // range + filter scope
  const laborWorkers = new Map()    // range: workerId → { name, type, photo, days, pay }
  const presentByDay = new Map()    // range: day → Set(workerId)
  for (const s of sessions) {
    const day = dayKey(s.date)
    for (const rec of s.records) {
      if (!rec.clockInAt) continue
      const key = `${s.projectId}|${rec.workerId}|${day}`
      if (seen.has(key)) continue
      seen.add(key)
      const amt = rec.rateSnap ?? rec.worker.dailyRate ?? 0
      if (s.phaseId) {
        const m = phaseWageDays.get(s.phaseId) ?? new Map()
        m.set(day, (m.get(day) ?? 0) + amt)
        phaseWageDays.set(s.phaseId, m)
      } else {
        unphasedByProject.set(s.projectId, (unphasedByProject.get(s.projectId) ?? 0) + amt)
      }
      if (phFilter && s.phaseId !== phFilter) continue
      if (!inRange(s.date)) continue
      wagesByDay.set(day, (wagesByDay.get(day) ?? 0) + amt)
      const w = laborWorkers.get(rec.workerId) ?? {
        name: rec.worker.name, type: rec.worker.type,
        photo: rec.worker.photo ? '/uploads/' + rec.worker.photo : null, days: 0, pay: 0,
      }
      w.days += 1
      w.pay += amt
      laborWorkers.set(rec.workerId, w)
      const ps = presentByDay.get(day) ?? new Set()
      ps.add(rec.workerId)
      presentByDay.set(day, ps)
    }
  }

  // ---- Phases: lifetime cost model + schedule + burn forecast; also feed the
  // range-scoped crew/materials day buckets and the materials item list. ----
  const crewByDay = new Map(), matByDay = new Map()
  const itemAgg = new Map() // name → { qty, cost, drawn, reported }
  const addItem = (name, qty, cost, source) => {
    const it = itemAgg.get(name) ?? { name, qty: 0, cost: 0, drawn: 0, reported: 0 }
    it.qty += qty
    it.cost += cost
    it[source] += qty
    itemAgg.set(name, it)
  }
  const today = new Date()
  const spanDays = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000) + 1)
  let crewRange = 0, matRange = 0
  const phaseRows = phases.map(ph => {
    const wd = phaseWageDays.get(ph.id) ?? new Map()
    const wagesAll = [...wd.values()].reduce((a, b) => a + b, 0)
    let crewAll = 0
    for (const u of ph.updates) {
      if (wd.has(dayKey(u.createdAt))) continue
      const c = u.builders * ph.costPerBuilder + u.helpers * ph.costPerHelper
      crewAll += c
      if (c > 0 && inRange(u.createdAt)) {
        crewRange += c
        const day = dayKey(u.createdAt)
        crewByDay.set(day, (crewByDay.get(day) ?? 0) + c)
      }
    }
    let matAll = 0
    const addMat = (at, name, qty, cost, source) => {
      matAll += cost
      const when = new Date(at)
      if (inRange(when)) {
        matRange += cost
        const day = dayKey(when)
        matByDay.set(day, (matByDay.get(day) ?? 0) + cost)
        addItem(name, qty, cost, source)
      }
    }
    for (const m of ph.materials) addMat(m.createdAt, m.nameSnap, m.qty, m.qty * m.unitCostSnap, 'drawn')
    for (const u of ph.updates) for (const m of (u.materials ?? []))
      addMat(m.createdAt, m.nameSnap, m.qty, m.qty * m.unitCostSnap, 'reported')

    const spent = wagesAll + crewAll + matAll
    const started = ph.startDate ?? ph.createdAt
    const ended = ph.signedOffAt ?? (today < new Date(started) ? started : today)
    const actualDays = ph.status === 'todo' && !ph.signedOffAt ? 0 : spanDays(started, ended)
    const plannedDays = ph.startDate && ph.endDate ? spanDays(ph.startDate, ph.endDate) : null
    const late = ph.status !== 'done' && ph.endDate && new Date(ph.endDate) < today
    return {
      id: ph.id, projectId: ph.project.id, project: ph.project.name, name: ph.name,
      status: ph.status, percent: ph.percent,
      startDate: ph.startDate, endDate: ph.endDate, signedOffAt: ph.signedOffAt,
      budget: ph.budget, spent, wages: wagesAll, crew: crewAll, materials: matAll,
      plannedDays, actualDays, late,
      overPace: ph.budget > 0 && spent / ph.budget > ph.percent / 100 + 0.05,
      // Earned-value-lite: at this burn per % complete, cost at completion.
      forecast: ph.percent > 0 && ph.status !== 'done' ? Math.round((spent * 100) / ph.percent) : null,
    }
  })

  // Loose (phase-less) consumption joins the materials picture.
  for (const m of looseRange) {
    matRange += m.qty * m.unitCostSnap
    const day = dayKey(new Date(m.createdAt))
    matByDay.set(day, (matByDay.get(day) ?? 0) + m.qty * m.unitCostSnap)
    addItem(m.nameSnap, m.qty, m.qty * m.unitCostSnap, 'reported')
  }

  // ---- Rollups ----
  const wagesRange = [...wagesByDay.values()].reduce((a, b) => a + b, 0)
  const projectRows = projects.map(p => {
    const rows = phaseRows.filter(r => r.projectId === p.id)
    const spent = rows.reduce((s, r) => s + r.spent, 0) +
      (phFilter ? 0 : (unphasedByProject.get(p.id) ?? 0))
    return { id: p.id, name: p.name, status: p.status, budget: p.budget, spent }
  })
  if (!phFilter) {
    // attribute lifetime loose consumption to its project (needs update relation)
    const looseWithProject = await db.updateMaterial.findMany({
      where: { update: { clientId: cid, phaseId: null, projectId: { in: projIds } } },
      include: { update: { select: { projectId: true } } },
    })
    for (const m of looseWithProject) {
      const row = projectRows.find(p => p.id === m.update.projectId)
      if (row) row.spent += m.qty * m.unitCostSnap
    }
  }
  const budgetTotal = phFilter
    ? (phaseRows[0]?.budget ?? 0)
    : projectRows.reduce((s, p) => s + p.budget, 0)
  const spentAllTime = phFilter
    ? (phaseRows[0]?.spent ?? 0)
    : projectRows.reduce((s, p) => s + p.spent, 0)

  // Weekly spend series (buckets start on Monday, local time)
  const weekOf = (dayStr) => {
    const d = new Date(dayStr + 'T00:00:00')
    d.setDate(d.getDate() - (d.getDay() + 6) % 7)
    return dayKey(d)
  }
  const weeks = new Map()
  const bump = (day, field, v) => {
    const wk = weekOf(day)
    const b = weeks.get(wk) ?? { week: wk, wages: 0, crew: 0, materials: 0 }
    b[field] += v
    weeks.set(wk, b)
  }
  for (const [day, v] of wagesByDay) bump(day, 'wages', v)
  for (const [day, v] of crewByDay) bump(day, 'crew', v)
  for (const [day, v] of matByDay) bump(day, 'materials', v)

  const workers = [...laborWorkers.values()].sort((a, b) => b.pay - a.pay || b.days - a.days)
  const workerDays = workers.reduce((s, w) => s + w.days, 0)
  const presence = [...presentByDay.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([day, set]) => ({ day, present: set.size, absent: Math.max(0, totalWorkers - set.size) }))

  res.json({
    from: dayKey(from), to: dayKey(to),
    projects: projectRows,
    kpis: {
      spent: wagesRange + crewRange + matRange,
      wages: wagesRange, crew: crewRange, materials: matRange,
      workerDays, workersPresent: workers.length,
      budgetTotal, spentAllTime,
      budgetUsedPct: budgetTotal > 0 ? Math.round((spentAllTime / budgetTotal) * 100) : null,
      phasesCompleted: phaseRows.filter(r => r.signedOffAt && inRange(new Date(r.signedOffAt))).length,
      phasesLate: phaseRows.filter(r => r.late).length,
    },
    series: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    phases: phaseRows,
    labor: { workers, workerDays, totalPay: wagesRange, totalWorkers, presence },
    materials: {
      items: [...itemAgg.values()].sort((a, b) => b.cost - a.cost),
      totalCost: matRange,
      stockValue: stockItems.reduce((s, i) => s + i.qty * i.unitCost, 0),
      lowStock: stockItems.filter(i => i.lowThreshold > 0 && i.qty <= i.lowThreshold).map(i => i.name),
      damaged: damagedCount,
      pendingRequests,
    },
    audit: auditRows.map(a => ({ userName: a.userName, action: a.action, detail: a.detail, createdAt: a.createdAt })),
  })
})

// ---- Audit trail ----

r.get('/audit', requireCap('audit.view'), async (req, res) => {
  res.json(await db.auditLog.findMany({
    where: { clientId: req.client.id }, orderBy: { createdAt: 'desc' }, take: 40,
  }))
})

// ---- Settings ----

r.get('/settings', (req, res) => {
  res.json({
    settings: settingsOf(req.client), currency: req.client.currency,
    company: req.client.company, tin: req.client.tin, location: req.client.location,
    contact: req.client.contact, country: req.client.country,
    logo: req.client.logo ? '/uploads/' + req.client.logo : null,
  })
})

// ---- Branding: the company logo used on everything printed (schedule PDF /
// Excel, letterheads, worker badges and ID cards). ----

r.post('/settings/logo', requireCap('settings.edit'), photoUpload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pick an image file (PNG or JPG)' })
  await db.client.update({ where: { id: req.client.id }, data: { logo: req.file.filename } })
  await audit(req.client.id, req.user.name, 'branding.logo', 'Company logo updated')
  res.json({ logo: '/uploads/' + req.file.filename })
})

r.delete('/settings/logo', requireCap('settings.edit'), async (req, res) => {
  await db.client.update({ where: { id: req.client.id }, data: { logo: null } })
  await audit(req.client.id, req.user.name, 'branding.logo', 'Company logo removed - platform default applies')
  res.json({ logo: null })
})

r.patch('/settings', requireCap('settings.edit'), async (req, res) => {
  const current = settingsOf(req.client)
  const next = { ...current }
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof req.body[k] === 'boolean') next[k] = req.body[k]
  }
  for (const k of ['attInStart', 'attInEnd', 'attOutStart', 'attOutEnd']) {
    if (typeof req.body[k] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(req.body[k])) next[k] = req.body[k]
  }
  // Worker types: a de-duplicated list of short names, at least one kept.
  if (Array.isArray(req.body.workerTypes)) {
    const list = [...new Set(
      req.body.workerTypes.map(t => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean)
    )].slice(0, 30)
    if (list.length) next.workerTypes = list
  }
  const data = { settings: next }
  if (req.body.currency) data.currency = req.body.currency
  if (req.body.tin !== undefined) data.tin = String(req.body.tin).trim() || null
  if (req.body.location !== undefined) data.location = String(req.body.location).trim() || null
  if (req.body.company !== undefined && String(req.body.company).trim())
    data.company = String(req.body.company).trim()
  if (req.body.contact !== undefined) data.contact = String(req.body.contact).trim() || null
  const client = await db.client.update({ where: { id: req.client.id }, data })
  await audit(req.client.id, req.user.name, 'settings.changed', JSON.stringify(req.body))
  res.json({
    settings: settingsOf(client), currency: client.currency, tin: client.tin,
    location: client.location, company: client.company, contact: client.contact,
    caps: capsFor(req.user, client),
  })
})

// ---- Super Admin ----

function superOnly(req, res, next) {
  if (req.user.role !== 'SUPER') return res.status(403).json({ error: 'Super Admin only' })
  next()
}

// ---- Platform settings (Super Admin, singleton row) ----

async function platformSettings() {
  return db.platformSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
}

// ---- Demo booking alerts: the Super Admin gets a popup for new bookings ----

r.get('/admin/demo-alerts', superOnly, async (_req, res) => {
  const bookings = await db.demoBooking.findMany({
    where: { seenAt: null },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  res.json(bookings.map(b => ({
    id: b.id, slot: b.slot, name: b.name, company: b.company, email: b.email,
    phone: b.phone, teamSize: b.teamSize, interests: b.interests ?? [],
    createdAt: b.createdAt,
  })))
})

r.post('/admin/demo-alerts/seen', superOnly, async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean)
  await db.demoBooking.updateMany({
    where: { seenAt: null, ...(ids.length ? { id: { in: ids } } : {}) },
    data: { seenAt: new Date() },
  })
  res.json({ ok: true })
})

// ---- Demos tab: the full booking book with lifecycle + time tracking ----

const DEMO_STATUSES = ['SCHEDULED', 'DONE', 'NO_SHOW', 'CANCELED']

r.get('/admin/demos', superOnly, async (req, res) => {
  const where = {}
  if (DEMO_STATUSES.includes(req.query.status)) where.status = req.query.status
  if (req.query.from) where.slot = { ...(where.slot ?? {}), gte: new Date(req.query.from + 'T00:00:00') }
  if (req.query.to) where.slot = { ...(where.slot ?? {}), lte: new Date(req.query.to + 'T23:59:59.999') }
  const bookings = await db.demoBooking.findMany({ where, orderBy: { slot: 'desc' } })
  const all = await db.demoBooking.groupBy({ by: ['status'], _count: true })
  const counts = Object.fromEntries(all.map(g => [g.status, g._count]))
  const now = new Date()
  res.json({
    counts: {
      total: all.reduce((s, g) => s + g._count, 0),
      scheduled: counts.SCHEDULED ?? 0, done: counts.DONE ?? 0,
      noShow: counts.NO_SHOW ?? 0, canceled: counts.CANCELED ?? 0,
      upcoming: await db.demoBooking.count({ where: { status: 'SCHEDULED', slot: { gte: now } } }),
    },
    demos: bookings.map(b => ({
      id: b.id, slot: b.slot, name: b.name, company: b.company, email: b.email,
      phone: b.phone, teamSize: b.teamSize, interests: b.interests ?? [],
      status: b.status, heldAt: b.heldAt, duration: b.duration, note: b.note,
      seen: !!b.seenAt, createdAt: b.createdAt,
    })),
  })
})

r.patch('/admin/demos/:id', superOnly, async (req, res) => {
  const booking = await db.demoBooking.findUnique({ where: { id: +req.params.id } })
  if (!booking) return res.status(404).json({ error: 'Booking not found' })
  const data = {}
  if (req.body.status !== undefined) {
    if (!DEMO_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Bad status' })
    data.status = req.body.status
    // Time tracking: stamp when it was held; clear if moved back to scheduled.
    if (req.body.status === 'DONE' && !booking.heldAt) data.heldAt = new Date()
    if (req.body.status === 'SCHEDULED') { data.heldAt = null; data.duration = null }
  }
  if (req.body.duration !== undefined) data.duration = Number(req.body.duration) > 0 ? Math.round(Number(req.body.duration)) : null
  if (req.body.note !== undefined) data.note = String(req.body.note).trim() || null
  const updated = await db.demoBooking.update({ where: { id: booking.id }, data })
  res.json({ ok: true, status: updated.status, heldAt: updated.heldAt, duration: updated.duration, note: updated.note })
})

r.get('/admin/settings', superOnly, async (_req, res) => {
  res.json(await platformSettings())
})

r.patch('/admin/settings', superOnly, async (req, res) => {
  const days = Math.min(60, Math.max(1, parseInt(req.body.renewalReminderDays) || 5))
  const s = await db.platformSettings.upsert({
    where: { id: 1 },
    update: { renewalReminderDays: days },
    create: { id: 1, renewalReminderDays: days },
  })
  res.json(s)
})

// When a client's current coverage runs out: paid coverage for active
// accounts, trial end for trials; null for suspended/terminated.
const renewalAt = (c) =>
  c.status === 'ACTIVE' ? c.paidUntil : c.status === 'TRIAL' ? c.trialEndsAt : null

// Platform finance dashboard: money received this month, renewals falling due
// this month, and payments waiting to be confirmed.
r.get('/admin/dashboard', superOnly, async (req, res) => {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const yearAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1)
  const [received, pending, clients, settings, confirmedYear, userTotal, userActive, projTotal, projActive] = await Promise.all([
    db.payment.findMany({ where: { status: 'CONFIRMED', confirmedAt: { gte: monthStart, lt: monthEnd } } }),
    db.payment.findMany({ where: { status: 'PENDING' } }),
    db.client.findMany(),
    platformSettings(),
    db.payment.findMany({ where: { status: 'CONFIRMED', confirmedAt: { gte: yearAgo } } }),
    db.user.count({ where: { NOT: { role: 'SUPER' } } }),
    db.user.count({ where: { NOT: { role: 'SUPER' }, client: { status: { in: ['ACTIVE', 'TRIAL'] } } } }),
    db.project.count(),
    db.project.count({ where: { status: 'In progress' } }),
  ])
  const sum = (arr) => arr.reduce((s, p) => s + p.amount, 0)
  // Companies whose paid coverage or trial ends inside this month → due to (re)pay
  const dueCompanies = clients
    .map((c) => ({ c, endsAt: renewalAt(c) }))
    .filter(({ endsAt }) => endsAt && new Date(endsAt) >= monthStart && new Date(endsAt) < monthEnd)
  // Renewal reminders: coverage ending within the configured window (or already
  // lapsed but the account not yet suspended) - the list to chase for payment.
  const windowEnd = now.getTime() + settings.renewalReminderDays * 86400000
  const reminders = clients
    .map((c) => ({ c, endsAt: renewalAt(c) }))
    .filter(({ endsAt }) => endsAt && new Date(endsAt).getTime() <= windowEnd)
    .map(({ c, endsAt }) => ({
      id: c.id, company: c.company, status: c.status, plan: c.plan, endsAt,
      daysLeft: Math.ceil((new Date(endsAt).getTime() - now.getTime()) / 86400000),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
  const statusCounts = {}
  for (const c of clients) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1

  // Last 12 months of confirmed subscriptions: count + revenue per month.
  const monthly = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
    const inMonth = confirmedYear.filter(p => p.confirmedAt >= d && p.confirmedAt < next)
    monthly.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }) + (d.getMonth() === 0 || i === 11 ? ` '${String(d.getFullYear()).slice(2)}` : ''),
      subs: inMonth.length,
      revenue: sum(inMonth),
    })
  }

  // System health: DB round trip, process uptime/memory, API latency tracker.
  const t0 = Date.now()
  await db.$queryRaw`SELECT 1`
  const dbLatencyMs = Date.now() - t0
  const perf = req.app.get('perf') ?? { count: 0, totalMs: 0, samples: [] }
  const sorted = [...perf.samples].sort((a, b) => a - b)
  const system = {
    uptimeSec: Math.round(process.uptime()),
    dbLatencyMs,
    apiCount: perf.count,
    apiAvgMs: perf.count ? Math.round((perf.totalMs / perf.count) * 10) / 10 : null,
    apiP95Ms: sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95) - 1 < 0 ? 0 : Math.floor(sorted.length * 0.95) - 1] * 10) / 10 : null,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    node: process.version,
  }

  res.json({
    month: now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    received: { total: sum(received), count: received.length },
    pending: { total: sum(pending), count: pending.length },
    monthly,
    users: { total: userTotal, active: userActive },
    projects: { total: projTotal, active: projActive },
    system,
    due: {
      total: dueCompanies.reduce((s, { c }) => s + (PLANS[c.plan]?.price ?? PLANS.STARTER.price), 0),
      count: dueCompanies.length,
      companies: dueCompanies.map(({ c, endsAt }) => ({
        id: c.id, company: c.company, status: c.status, plan: c.plan, endsAt,
      })).sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt)),
    },
    reminders: { days: settings.renewalReminderDays, companies: reminders },
    statusCounts,
  })
})

r.get('/admin/clients', superOnly, async (_req, res) => {
  const clients = await db.client.findMany({
    include: { _count: { select: { users: true, projects: true } } },
    orderBy: { id: 'asc' },
  })
  res.json(clients.map(c => ({
    id: c.id, company: c.company, status: c.status, currency: c.currency,
    country: c.country, trialEndsAt: c.trialEndsAt, createdAt: c.createdAt,
    plan: c.plan, paidUntil: c.paidUntil, renewalAt: renewalAt(c),
    users: c._count.users, projects: c._count.projects,
  })))
})

// Manual MoMo payment queue: clients report payments; the Super Admin matches
// them against the MoMo account statement and confirms or rejects here.
r.get('/admin/payments', superOnly, async (_req, res) => {
  const payments = await db.payment.findMany({
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: { client: { select: { id: true, company: true, status: true, plan: true, paidUntil: true } } },
  })
  res.json(payments)
})

r.patch('/admin/payments/:id', superOnly, async (req, res) => {
  const payment = await db.payment.findUnique({ where: { id: +req.params.id }, include: { client: true } })
  if (!payment || payment.status !== 'PENDING')
    return res.status(404).json({ error: 'Pending payment not found' })

  if (req.body.action === 'reject') {
    await db.payment.update({
      where: { id: payment.id },
      data: { status: 'REJECTED', note: req.body.note ? String(req.body.note) : null, confirmedAt: new Date(), confirmedBy: req.user.name },
    })
    await audit(payment.clientId, req.user.name, 'billing.rejected', payment.reference)
    return res.json({ ok: true })
  }
  if (req.body.action !== 'confirm') return res.status(400).json({ error: 'Unknown action' })

  // Extend from the current coverage end if still in the future, else from now.
  const base = payment.client.paidUntil && new Date(payment.client.paidUntil) > new Date()
    ? new Date(payment.client.paidUntil) : new Date()
  const paidUntil = new Date(base.getTime() + payment.months * 30 * 86400000)
  await db.$transaction([
    db.payment.update({
      where: { id: payment.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: req.user.name },
    }),
    db.client.update({
      where: { id: payment.clientId },
      data: { status: 'ACTIVE', plan: payment.plan, paidUntil },
    }),
  ])
  await audit(payment.clientId, req.user.name, 'billing.confirmed',
    `${payment.reference} · ${payment.plan} until ${paidUntil.toISOString().slice(0, 10)}`)
  res.json({ ok: true, paidUntil })
})

r.patch('/admin/clients/:id', superOnly, async (req, res) => {
  const status = req.body.status
  if (!['TRIAL', 'ACTIVE', 'SUSPENDED', 'TERMINATED'].includes(status))
    return res.status(400).json({ error: 'Bad status' })
  const c = await db.client.update({ where: { id: +req.params.id }, data: { status } })
  await audit(c.id, 'Super Admin', 'account.' + status.toLowerCase(), null)
  res.json({ ok: true })
})

export default r
