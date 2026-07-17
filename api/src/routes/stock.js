import { Router } from 'express'
import { db, audit } from '../db.js'
import { requireCap, can } from '../auth.js'
import { scopedProjectIds, projectScopeWhere, inScope } from '../scope.js'
import { checkLowStock } from '../stockAlerts.js'

const r = Router()

// Resolve and validate an optional projectId from the request body:
// must belong to the client and be inside the caller's project scope.
async function resolveProject(req, scope) {
  if (!req.body.projectId) return { projectId: null }
  const project = await db.project.findFirst({ where: { id: +req.body.projectId, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return { error: 'Project not found' }
  return { projectId: project.id, projectName: project.name }
}

r.get('/', requireCap('stock.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const items = await db.stockItem.findMany({
    where: { clientId: req.client.id, ...projectScopeWhere(ids) },
    include: { project: { select: { id: true, name: true } } },
    orderBy: { id: 'asc' },
  })
  const showMoney = can(req, 'stock.amounts')
  res.json(items.map(i => ({
    id: i.id, name: i.name, category: i.category, qty: i.qty, unit: i.unit,
    serial: i.serial, low: i.lowThreshold > 0 && i.qty <= i.lowThreshold,
    projectId: i.projectId, projectName: i.project?.name ?? null,
    // PRD: Stock Manager never sees monetary amounts - stripped server-side.
    unitCost: showMoney ? i.unitCost : null,
    total: showMoney ? i.qty * i.unitCost : null,
  })))
})

r.post('/', requireCap('stock.edit'), async (req, res) => {
  const { name, category, qty, unit, unitCost, serial, lowThreshold } = req.body
  if (!name) return res.status(400).json({ error: 'Product name is required' })
  if (category === 'Machine' && !serial)
    return res.status(400).json({ error: 'Machines/tools require a serial number' })
  const scope = await scopedProjectIds(req)
  const proj = await resolveProject(req, scope)
  if (proj.error) return res.status(404).json({ error: proj.error })
  const item = await db.stockItem.create({
    data: {
      clientId: req.client.id, projectId: proj.projectId,
      name, category: category || 'Consumable',
      qty: Number(qty) || 0, unit: unit || 'pcs', unitCost: Number(unitCost) || 0,
      serial: serial || null, lowThreshold: Number(lowThreshold) || 0,
    },
  })
  await audit(req.client.id, req.user.name, 'stock.inserted',
    `${item.qty} ${item.unit} ${name}${proj.projectName ? ' · ' + proj.projectName : ''}`)
  res.json(item)
})

// Bulk insert from the CSV template. Valid rows are created; problem rows come
// back with the reason so nothing fails silently.
r.post('/bulk', requireCap('stock.edit'), async (req, res) => {
  const rows = Array.isArray(req.body.items) ? req.body.items.slice(0, 500) : []
  if (!rows.length) return res.status(400).json({ error: 'No rows found in the file' })
  const scope = await scopedProjectIds(req)
  const proj = await resolveProject(req, scope)
  if (proj.error) return res.status(404).json({ error: proj.error })

  const valid = []
  const skipped = []
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const line = i + 2 // header is line 1 in the template
    const name = String(raw.name ?? '').trim()
    const category = String(raw.category ?? '').trim().toLowerCase() === 'machine' ? 'Machine' : 'Consumable'
    const serial = String(raw.serial ?? '').trim() || null
    if (!name) { skipped.push({ line, name: raw.name ?? '', reason: 'Missing name' }); continue }
    if (category === 'Machine' && !serial) { skipped.push({ line, name, reason: 'Machines/tools require a serial number' }); continue }
    valid.push({
      clientId: req.client.id, projectId: proj.projectId, name, category,
      qty: Number(raw.qty) || 0,
      unit: String(raw.unit ?? '').trim() || 'pcs',
      unitCost: Number(raw.unitCost) || 0,
      serial,
      lowThreshold: Number(raw.lowThreshold) || 0,
    })
  }
  if (valid.length) await db.stockItem.createMany({ data: valid })
  await audit(req.client.id, req.user.name, 'stock.bulk',
    `${valid.length} items inserted${skipped.length ? `, ${skipped.length} skipped` : ''}${proj.projectName ? ' · ' + proj.projectName : ''}`)
  res.json({ added: valid.length, skipped })
})

r.patch('/:id', requireCap('stock.edit'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const item = await db.stockItem.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!item || (item.projectId && !inScope(scope, item.projectId)))
    return res.status(404).json({ error: 'Item not found' })
  const data = {}
  for (const k of ['name', 'unit', 'serial']) if (req.body[k] !== undefined) data[k] = req.body[k]
  for (const k of ['qty', 'unitCost', 'lowThreshold']) if (req.body[k] !== undefined) data[k] = Number(req.body[k]) || 0
  if (req.body.projectId !== undefined) {
    const proj = await resolveProject(req, scope)
    if (proj.error) return res.status(404).json({ error: proj.error })
    data.projectId = proj.projectId
  }
  const updated = await db.stockItem.update({ where: { id: item.id }, data })
  await audit(req.client.id, req.user.name, 'stock.edited', item.name)
  checkLowStock(req.client, updated, item.qty)
  res.json(updated)
})

// ---- Requests (Stock Manager submits; Senior Engineer approves - PRD 7.1 default) ----

r.get('/requests', requireCap('stock.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const requests = await db.stockRequest.findMany({
    where: { clientId: req.client.id, ...projectScopeWhere(ids) },
    include: { requestedBy: { select: { name: true } }, project: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json(requests.map(q => ({
    id: q.id, itemName: q.itemName, qty: q.qty, note: q.note, status: q.status,
    by: q.requestedBy.name, projectName: q.project?.name ?? null, createdAt: q.createdAt,
  })))
})

r.post('/requests', (req, res, next) => {
  if (can(req, 'stock.request') || can(req, 'stock.edit')) return next()
  res.status(403).json({ error: 'No permission: stock.request' })
}, async (req, res) => {
  const { itemName, qty, note } = req.body
  if (!itemName || !qty) return res.status(400).json({ error: 'Item and quantity are required' })
  const scope = await scopedProjectIds(req)
  const proj = await resolveProject(req, scope)
  if (proj.error) return res.status(404).json({ error: proj.error })
  const q = await db.stockRequest.create({
    data: {
      clientId: req.client.id, projectId: proj.projectId,
      itemName, qty: String(qty), note: note || null, requestedById: req.user.id,
    },
  })
  await audit(req.client.id, req.user.name, 'stock.requested', `${qty} × ${itemName}`)
  res.json(q)
})

r.patch('/requests/:id', requireCap('stock.approve'), async (req, res) => {
  const status = req.body.status
  if (!['APPROVED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'Status must be APPROVED or REJECTED' })
  const scope = await scopedProjectIds(req)
  const existing = await db.stockRequest.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!existing || (existing.projectId && !inScope(scope, existing.projectId)))
    return res.status(404).json({ error: 'Request not found' })
  const q = await db.stockRequest.update({ where: { id: existing.id }, data: { status } })
  await audit(req.client.id, req.user.name, 'stock.request.' + status.toLowerCase(), `${q.qty} × ${q.itemName}`)
  res.json(q)
})

// ---- Damaged items (hidden from Stock Manager - PRD §3) ----

r.get('/damaged', requireCap('damaged.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const damaged = await db.damagedItem.findMany({
    where: { clientId: req.client.id, ...projectScopeWhere(ids) },
    include: { project: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json(damaged.map(d => ({
    id: d.id, name: d.name, serial: d.serial, note: d.note,
    projectName: d.project?.name ?? null, createdAt: d.createdAt,
  })))
})

r.post('/damaged', requireCap('stock.edit'), async (req, res) => {
  const { name, serial, note } = req.body
  if (!name) return res.status(400).json({ error: 'Item name is required' })
  const scope = await scopedProjectIds(req)
  const proj = await resolveProject(req, scope)
  if (proj.error) return res.status(404).json({ error: proj.error })
  const d = await db.damagedItem.create({
    data: { clientId: req.client.id, projectId: proj.projectId, name, serial: serial || null, note: note || null },
  })
  await audit(req.client.id, req.user.name, 'stock.damaged', name)
  res.json(d)
})

export default r
