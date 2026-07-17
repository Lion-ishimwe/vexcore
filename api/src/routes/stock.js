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
    include: { project: { select: { id: true, name: true } }, store: { select: { id: true, name: true } } },
    orderBy: { id: 'asc' },
  })
  const showMoney = can(req, 'stock.amounts')
  res.json(items.map(i => ({
    id: i.id, name: i.name, category: i.category, qty: i.qty, unit: i.unit,
    serial: i.serial, low: i.lowThreshold > 0 && i.qty <= i.lowThreshold,
    projectId: i.projectId, projectName: i.project?.name ?? null,
    storeId: i.storeId, storeName: i.store?.name ?? null,
    // PRD: Stock Manager never sees monetary amounts - stripped server-side.
    unitCost: showMoney ? i.unitCost : null,
    total: showMoney ? i.qty * i.unitCost : null,
  })))
})

// ---- Stores: a big project can run several stock stores ----

r.get('/stores', requireCap('stock.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const stores = await db.stockStore.findMany({
    where: { clientId: req.client.id, ...(ids ? { projectId: { in: ids } } : {}) },
    include: { project: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    orderBy: [{ projectId: 'asc' }, { name: 'asc' }],
  })
  res.json(stores.map(s => ({
    id: s.id, name: s.name, projectId: s.projectId, projectName: s.project.name,
    items: s._count.items, createdAt: s.createdAt,
  })))
})

r.post('/stores', requireCap('stock.edit'), async (req, res) => {
  const name = String(req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Store name is required' })
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +req.body.projectId, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return res.status(404).json({ error: 'Project not found' })
  const dup = await db.stockStore.findFirst({ where: { projectId: project.id, name } })
  if (dup) return res.status(409).json({ error: `${project.name} already has a store called "${name}"` })
  const store = await db.stockStore.create({ data: { clientId: req.client.id, projectId: project.id, name } })
  await audit(req.client.id, req.user.name, 'stock.store.added', `${name} · ${project.name}`)
  res.json({ id: store.id, name: store.name, projectId: store.projectId, projectName: project.name, items: 0 })
})

r.patch('/stores/:id', requireCap('stock.edit'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const store = await db.stockStore.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!store || !inScope(scope, store.projectId)) return res.status(404).json({ error: 'Store not found' })
  const name = String(req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Store name is required' })
  const dup = await db.stockStore.findFirst({ where: { projectId: store.projectId, name, NOT: { id: store.id } } })
  if (dup) return res.status(409).json({ error: `This project already has a store called "${name}"` })
  const updated = await db.stockStore.update({ where: { id: store.id }, data: { name } })
  await audit(req.client.id, req.user.name, 'stock.store.renamed', `${store.name} → ${name}`)
  res.json(updated)
})

// Deleting a store keeps its items - they fall back to the project's
// unassigned stock, nothing is lost.
r.delete('/stores/:id', requireCap('stock.edit'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const store = await db.stockStore.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!store || !inScope(scope, store.projectId)) return res.status(404).json({ error: 'Store not found' })
  const moved = await db.stockItem.updateMany({ where: { storeId: store.id }, data: { storeId: null } })
  await db.stockStore.delete({ where: { id: store.id } })
  await audit(req.client.id, req.user.name, 'stock.store.deleted',
    `${store.name}${moved.count ? ` · ${moved.count} items moved to the project's unassigned stock` : ''}`)
  res.json({ ok: true, movedItems: moved.count })
})

// Resolve an optional storeId: must belong to the client and be in scope; the
// item's project is then taken FROM the store (a store pins the project).
async function resolveStore(req, scope) {
  if (!req.body.storeId) return { storeId: null }
  const store = await db.stockStore.findFirst({ where: { id: +req.body.storeId, clientId: req.client.id } })
  if (!store || !inScope(scope, store.projectId)) return { error: 'Store not found' }
  return { storeId: store.id, projectId: store.projectId, storeName: store.name }
}

r.post('/', requireCap('stock.edit'), async (req, res) => {
  const { name, category, qty, unit, unitCost, serial, lowThreshold } = req.body
  if (!name) return res.status(400).json({ error: 'Product name is required' })
  if (category === 'Machine' && !serial)
    return res.status(400).json({ error: 'Machines/tools require a serial number' })
  const scope = await scopedProjectIds(req)
  const proj = await resolveProject(req, scope)
  if (proj.error) return res.status(404).json({ error: proj.error })
  const store = await resolveStore(req, scope)
  if (store.error) return res.status(404).json({ error: store.error })
  const item = await db.stockItem.create({
    data: {
      clientId: req.client.id,
      // a store pins the project - otherwise the picked project (or general)
      projectId: store.storeId ? store.projectId : proj.projectId,
      storeId: store.storeId,
      name, category: category || 'Consumable',
      qty: Number(qty) || 0, unit: unit || 'pcs', unitCost: Number(unitCost) || 0,
      serial: serial || null, lowThreshold: Number(lowThreshold) || 0,
    },
  })
  await audit(req.client.id, req.user.name, 'stock.inserted',
    `${item.qty} ${item.unit} ${name}${proj.projectName ? ' · ' + proj.projectName : ''}${store.storeName ? ' · ' + store.storeName : ''}`)
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
  const store = await resolveStore(req, scope)
  if (store.error) return res.status(404).json({ error: store.error })

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
      clientId: req.client.id,
      projectId: store.storeId ? store.projectId : proj.projectId,
      storeId: store.storeId,
      name, category,
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
    if (!req.body.storeId) data.storeId = null // moving projects leaves the old store
  }
  if (req.body.storeId !== undefined) {
    const store = await resolveStore(req, scope)
    if (store.error) return res.status(404).json({ error: store.error })
    data.storeId = store.storeId
    if (store.storeId) data.projectId = store.projectId // the store pins the project
  }
  const updated = await db.stockItem.update({ where: { id: item.id }, data })
  await audit(req.client.id, req.user.name, 'stock.edited', item.name)
  checkLowStock(req.client, updated, item.qty)
  res.json(updated)
})

// ---- Issues: proof of how stock was consumed ----
// The Stock Manager (or Senior/Admin) hands items to a person - a worker
// identified by scanning their card (or picked manually) or a team member -
// and the hand-out is recorded with quantities. Stock is deducted here.

// One scan namespace: a card id resolves to a worker or a team member.
async function personByCard(clientId, cardId) {
  const worker = await db.worker.findFirst({ where: { clientId, cardId, active: true } })
  if (worker) return { worker, user: null }
  const user = await db.user.findFirst({ where: { clientId, cardId } })
  if (user) return { worker: null, user }
  return null
}

r.get('/card/:cardId', requireCap('stock.issue'), async (req, res) => {
  const found = await personByCard(req.client.id, String(req.params.cardId).trim())
  if (!found) return res.status(404).json({ error: 'Card not recognised' })
  res.json(found.worker
    ? { kind: 'worker', name: found.worker.name, sub: found.worker.type, photo: found.worker.photo ? '/uploads/' + found.worker.photo : null }
    : { kind: 'user', name: found.user.name, sub: found.user.role, photo: found.user.photo ? '/uploads/' + found.user.photo : null })
})

r.post('/issues', requireCap('stock.issue'), async (req, res) => {
  // The recipient is identified by their card - scanned QR or typed id.
  const cardId = String(req.body.cardId ?? '').trim()
  if (!cardId) return res.status(400).json({ error: 'Scan the card\'s QR code or type the card id' })
  const found = await personByCard(req.client.id, cardId)
  if (!found) return res.status(404).json({ error: 'Card not recognised - workers need enrolment, team members get their badge automatically' })
  const { worker, user } = found

  // Validate the items (duplicate rows merged), then deduct in one transaction
  const wanted = new Map()
  for (const i of Array.isArray(req.body.items) ? req.body.items : []) {
    const id = +i.stockItemId, qty = Number(i.qty)
    if (id && qty > 0) wanted.set(id, (wanted.get(id) ?? 0) + qty)
  }
  if (!wanted.size) return res.status(400).json({ error: 'Add at least one item' })
  const draws = []
  for (const [stockItemId, qty] of wanted) {
    const item = await db.stockItem.findFirst({ where: { id: stockItemId, clientId: req.client.id } })
    if (!item) return res.status(400).json({ error: 'An item is no longer in stock' })
    if (item.qty < qty) return res.status(400).json({ error: `Only ${item.qty} ${item.unit} of ${item.name} in stock` })
    draws.push({ item, qty })
  }

  const issue = await db.$transaction(async (tx) => {
    const created = await tx.stockIssue.create({
      data: {
        clientId: req.client.id, issuedById: req.user.id,
        workerId: worker?.id ?? null, userId: user?.id ?? null,
        viaCard: true, note: String(req.body.note ?? '').trim() || null,
      },
    })
    for (const d of draws) {
      await tx.stockIssueItem.create({
        data: {
          issueId: created.id, stockItemId: d.item.id, nameSnap: d.item.name,
          unitSnap: d.item.unit, qty: d.qty, unitCostSnap: d.item.unitCost,
        },
      })
      await tx.stockItem.update({ where: { id: d.item.id }, data: { qty: { decrement: d.qty } } })
    }
    return created
  })
  for (const d of draws) checkLowStock(req.client, { ...d.item, qty: d.item.qty - d.qty }, d.item.qty)

  const recipient = worker ? `${worker.name} (${worker.type})` : `${user.name} (${user.role})`
  await audit(req.client.id, req.user.name, 'stock.issued',
    `${draws.map(d => `${d.qty} ${d.item.unit} ${d.item.name}`).join(', ')} → ${recipient}${cardId ? ' · card scan' : ''}`)
  res.json({ ok: true, id: issue.id, recipient })
})

r.get('/issues', requireCap('stock.view'), async (req, res) => {
  const showMoney = can(req, 'stock.amounts')
  const issues = await db.stockIssue.findMany({
    where: { clientId: req.client.id },
    include: {
      items: true,
      issuedBy: { select: { name: true } },
      worker: { select: { name: true, type: true, photo: true } },
      user: { select: { name: true, role: true, photo: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  res.json(issues.map(i => ({
    id: i.id, createdAt: i.createdAt, viaCard: i.viaCard, note: i.note,
    issuedBy: i.issuedBy.name,
    recipient: i.worker
      ? { kind: 'worker', name: i.worker.name, sub: i.worker.type, photo: i.worker.photo ? '/uploads/' + i.worker.photo : null }
      : { kind: 'user', name: i.user?.name ?? '-', sub: i.user?.role ?? '', photo: i.user?.photo ? '/uploads/' + i.user.photo : null },
    items: i.items.map(it => ({
      name: it.nameSnap, qty: it.qty, unit: it.unitSnap,
      cost: showMoney ? it.qty * it.unitCostSnap : null,
    })),
    total: showMoney ? i.items.reduce((s, it) => s + it.qty * it.unitCostSnap, 0) : null,
  })))
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
