import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { db, audit } from '../db.js'
import { requireCap, can, settingsOf, capsFor, DEFAULT_SETTINGS } from '../auth.js'
import { PLANS } from '../plans.js'
import { scopedProjectIds, projectScopeWhere } from '../scope.js'
import { ensureSystemFolders } from './docs.js'
import { wagesForProjects } from './projects.js'

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
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  })
  res.json(users)
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
    include: { user: { select: { name: true, role: true } } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  res.json(messages.map(m => ({
    id: m.id, from: m.user.name, role: m.user.role, text: m.text, createdAt: m.createdAt,
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
      include: { media: true, user: { select: { name: true } }, phase: { select: { name: true } }, project: { select: { name: true } } },
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
      id: u.id, by: u.user.name, project: u.project.name, phase: u.phase?.name, note: u.note,
      builders: u.builders, helpers: u.helpers, geotag: u.geotag, createdAt: u.createdAt,
      photos: u.media.filter(m => m.kind === 'photo').length,
      videos: u.media.filter(m => m.kind === 'video').length,
    })),
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
  })
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
  const data = { settings: next }
  if (req.body.currency) data.currency = req.body.currency
  if (req.body.tin !== undefined) data.tin = String(req.body.tin).trim() || null
  if (req.body.location !== undefined) data.location = String(req.body.location).trim() || null
  const client = await db.client.update({ where: { id: req.client.id }, data })
  await audit(req.client.id, req.user.name, 'settings.changed', JSON.stringify(req.body))
  res.json({
    settings: settingsOf(client), currency: client.currency, tin: client.tin,
    location: client.location,
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
r.get('/admin/dashboard', superOnly, async (_req, res) => {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const [received, pending, clients, settings] = await Promise.all([
    db.payment.findMany({ where: { status: 'CONFIRMED', confirmedAt: { gte: monthStart, lt: monthEnd } } }),
    db.payment.findMany({ where: { status: 'PENDING' } }),
    db.client.findMany(),
    platformSettings(),
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
  res.json({
    month: now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    received: { total: sum(received), count: received.length },
    pending: { total: sum(pending), count: pending.length },
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
    take: 100,
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

r.get('/admin/demos', superOnly, async (_req, res) => {
  res.json(await db.demoBooking.findMany({ orderBy: { slot: 'asc' } }))
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
