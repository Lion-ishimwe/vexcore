import { Router } from 'express'
import { db, audit } from '../db.js'
import { requireCap, can } from '../auth.js'
import { scopedProjectIds, projectScopeWhere, inScope } from '../scope.js'
import { checkLowStock } from '../stockAlerts.js'

const r = Router()

// Quantities and money are whole, non-negative numbers. `Number(x) || 0` used
// to let a negative through, which then poisoned stock valuation and the
// dashboard totals.
const whole = (v, fallback = 0) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const isNegative = (v) => v !== undefined && Number(v) < 0

// Resolve and validate an optional projectId from the request body:
// must belong to the client and be inside the caller's project scope.
async function resolveProject(req, scope) {
  if (!req.body.projectId) return { projectId: null }
  const project = await db.project.findFirst({ where: { id: +req.body.projectId, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return { error: 'Project not found' }
  return { projectId: project.id, projectName: project.name }
}

// Stores assigned to this Stock Manager. Non-empty ⇒ their whole stock view
// narrows to exactly those stores - they see the stock assigned to them only.
// Managers with no store assignment keep the normal project-scoped view.
async function managedStoreIds(req) {
  if (req.user.role !== 'STOCK') return null
  const stores = await db.stockStore.findMany({
    where: { clientId: req.client.id, managerId: req.user.id },
    select: { id: true },
  })
  return stores.length ? stores.map(s => s.id) : null
}

r.get('/', requireCap('stock.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const managed = await managedStoreIds(req)
  const items = await db.stockItem.findMany({
    where: {
      clientId: req.client.id,
      ...(managed ? { storeId: { in: managed } } : projectScopeWhere(ids)),
    },
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

const STORE_INCLUDE = {
  project: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true, photo: true } },
  _count: { select: { items: true } },
}

const shapeStore = (s) => ({
  id: s.id, name: s.name, projectId: s.projectId, projectName: s.project.name,
  managerId: s.managerId, managerName: s.manager?.name ?? null,
  managerPhoto: s.manager?.photo ? '/uploads/' + s.manager.photo : null,
  items: s._count?.items ?? 0, createdAt: s.createdAt,
})

r.get('/stores', requireCap('stock.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const managed = await managedStoreIds(req)
  const stores = await db.stockStore.findMany({
    where: {
      clientId: req.client.id,
      ...(managed ? { id: { in: managed } } : ids ? { projectId: { in: ids } } : {}),
    },
    include: STORE_INCLUDE,
    orderBy: [{ projectId: 'asc' }, { name: 'asc' }],
  })
  res.json(stores.map(shapeStore))
})

// Creating/renaming/deleting stores (and assigning their managers) is the
// admin's and Senior Engineer's job - Stock Managers work INSIDE a store.
function storeAdminOnly(req, res, next) {
  if (['SUPER', 'CLIENT', 'SENIOR'].includes(req.user.role)) return next()
  res.status(403).json({ error: 'Only the admin or a Senior Engineer can manage stores' })
}

// A store's manager must be one of the company's Stock Managers.
async function resolveManager(req) {
  if (req.body.managerId === undefined) return { skip: true }
  if (!req.body.managerId) return { managerId: null }
  const manager = await db.user.findFirst({
    where: { id: +req.body.managerId, clientId: req.client.id, role: 'STOCK', suspended: false },
  })
  if (!manager) return { error: 'The store manager must be one of your Stock Manager accounts' }
  return { managerId: manager.id, managerName: manager.name }
}

r.post('/stores', requireCap('stock.edit'), storeAdminOnly, async (req, res) => {
  const name = String(req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Store name is required' })
  const scope = await scopedProjectIds(req)
  const project = await db.project.findFirst({ where: { id: +req.body.projectId, clientId: req.client.id } })
  if (!project || !inScope(scope, project.id)) return res.status(404).json({ error: 'Project not found' })
  const dup = await db.stockStore.findFirst({ where: { projectId: project.id, name } })
  if (dup) return res.status(409).json({ error: `${project.name} already has a store called "${name}"` })
  const mgr = await resolveManager(req)
  if (mgr.error) return res.status(400).json({ error: mgr.error })
  const store = await db.stockStore.create({
    data: { clientId: req.client.id, projectId: project.id, name, managerId: mgr.skip ? null : mgr.managerId },
    include: STORE_INCLUDE,
  })
  await audit(req.client.id, req.user.name, 'stock.store.added',
    `${name} · ${project.name}${mgr.managerName ? ' · manager ' + mgr.managerName : ''}`)
  res.json(shapeStore(store))
})

r.patch('/stores/:id', requireCap('stock.edit'), storeAdminOnly, async (req, res) => {
  const scope = await scopedProjectIds(req)
  const store = await db.stockStore.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!store || !inScope(scope, store.projectId)) return res.status(404).json({ error: 'Store not found' })
  const data = {}
  if (req.body.name !== undefined) {
    const name = String(req.body.name ?? '').trim()
    if (!name) return res.status(400).json({ error: 'Store name is required' })
    const dup = await db.stockStore.findFirst({ where: { projectId: store.projectId, name, NOT: { id: store.id } } })
    if (dup) return res.status(409).json({ error: `This project already has a store called "${name}"` })
    data.name = name
  }
  const mgr = await resolveManager(req)
  if (mgr.error) return res.status(400).json({ error: mgr.error })
  if (!mgr.skip) data.managerId = mgr.managerId
  const updated = await db.stockStore.update({ where: { id: store.id }, data, include: STORE_INCLUDE })
  await audit(req.client.id, req.user.name, 'stock.store.edited',
    `${updated.name}${!mgr.skip ? ` · manager ${mgr.managerName ?? 'removed'}` : ''}`)
  res.json(shapeStore(updated))
})

// Deleting a store keeps its items - they fall back to the project's
// unassigned stock, nothing is lost.
r.delete('/stores/:id', requireCap('stock.edit'), storeAdminOnly, async (req, res) => {
  const scope = await scopedProjectIds(req)
  const store = await db.stockStore.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!store || !inScope(scope, store.projectId)) return res.status(404).json({ error: 'Store not found' })
  const moved = await db.stockItem.updateMany({ where: { storeId: store.id }, data: { storeId: null } })
  await db.stockStore.delete({ where: { id: store.id } })
  await audit(req.client.id, req.user.name, 'stock.store.deleted',
    `${store.name}${moved.count ? ` · ${moved.count} items moved to the project's unassigned stock` : ''}`)
  res.json({ ok: true, movedItems: moved.count })
})

// ---- Inter-store transfers: a store that runs short requests the item from
// another store that has it. Approval moves the quantity between stores. ----

const TRANSFER_INCLUDE = {
  item: { select: { id: true, name: true, unit: true, qty: true, category: true } },
  fromStore: { select: { id: true, name: true, managerId: true, project: { select: { name: true } } } },
  toStore: { select: { id: true, name: true, project: { select: { name: true } } } },
  requestedBy: { select: { name: true } },
}

const shapeTransfer = (t) => ({
  id: t.id, qty: t.qty, note: t.note, status: t.status,
  item: { id: t.item.id, name: t.item.name, unit: t.item.unit, available: t.item.qty },
  from: { id: t.fromStore.id, name: t.fromStore.name, project: t.fromStore.project.name, managerId: t.fromStore.managerId },
  to: { id: t.toStore.id, name: t.toStore.name, project: t.toStore.project.name },
  requestedBy: t.requestedBy.name, decidedBy: t.decidedBy, decidedAt: t.decidedAt, createdAt: t.createdAt,
})

r.get('/transfers', requireCap('stock.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const managed = await managedStoreIds(req)
  const transfers = await db.stockTransfer.findMany({
    where: {
      clientId: req.client.id,
      // Store-scoped manager: transfers touching THEIR stores (either side)
      // or requested by them; otherwise the usual project scope.
      ...(managed
        ? { OR: [{ fromStoreId: { in: managed } }, { toStoreId: { in: managed } }, { requestedById: req.user.id }] }
        : ids ? { OR: [{ fromStore: { projectId: { in: ids } } }, { toStore: { projectId: { in: ids } } }] } : {}),
    },
    include: TRANSFER_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  res.json(transfers.map(shapeTransfer))
})

// What OTHER stores hold - the transfer request picker. Deliberately minimal
// (name/qty/store, no costs) so a store-scoped manager can ask another store
// for an item without seeing that store's full stock view.
r.get('/transferable', (req, res, next) => {
  if (can(req, 'stock.request') || can(req, 'stock.edit')) return next()
  res.status(403).json({ error: 'No permission: stock.request' })
}, async (req, res) => {
  const ids = await scopedProjectIds(req)
  const managed = await managedStoreIds(req)
  const items = await db.stockItem.findMany({
    where: {
      clientId: req.client.id, qty: { gt: 0 }, NOT: { storeId: null },
      // any store of any project in the company can be asked - but a
      // store-scoped manager never needs their OWN items listed
      ...(managed ? { storeId: { notIn: managed } } : {}),
    },
    include: { store: { select: { id: true, name: true, project: { select: { name: true } } } } },
    orderBy: { name: 'asc' },
  })
  res.json(items.map(i => ({
    id: i.id, name: i.name, unit: i.unit, qty: i.qty,
    storeId: i.storeId, storeName: i.store.name, projectName: i.store.project.name,
  })))
})

r.post('/transfers', (req, res, next) => {
  if (can(req, 'stock.request') || can(req, 'stock.edit')) return next()
  res.status(403).json({ error: 'No permission: stock.request' })
}, async (req, res) => {
  const qty = Number(req.body.qty)
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantity must be at least 1' })
  const item = await db.stockItem.findFirst({
    where: { id: +req.body.itemId, clientId: req.client.id },
    include: { store: { include: { project: { select: { name: true } } } } },
  })
  if (!item || !item.storeId) return res.status(404).json({ error: 'Pick an item held by another store' })
  const scope = await scopedProjectIds(req)
  const managed = await managedStoreIds(req)
  const toStore = await db.stockStore.findFirst({
    where: { id: +req.body.toStoreId, clientId: req.client.id },
    include: { project: { select: { name: true } } },
  })
  if (!toStore || (managed ? !managed.includes(toStore.id) : !inScope(scope, toStore.projectId)))
    return res.status(404).json({ error: managed ? 'You can only request items into your own store' : 'Destination store not found' })
  if (toStore.id === item.storeId) return res.status(400).json({ error: 'That item is already in this store' })
  if (item.qty < qty) return res.status(400).json({ error: `${item.store.name} only has ${item.qty} ${item.unit} of ${item.name}` })
  const transfer = await db.stockTransfer.create({
    data: {
      clientId: req.client.id, itemId: item.id, fromStoreId: item.storeId, toStoreId: toStore.id,
      qty, note: String(req.body.note ?? '').trim() || null, requestedById: req.user.id,
    },
    include: TRANSFER_INCLUDE,
  })
  await audit(req.client.id, req.user.name, 'stock.transfer.requested',
    `${qty} ${item.unit} ${item.name}: ${item.store.name} → ${toStore.name}`)
  res.json(shapeTransfer(transfer))
})

// Decide a transfer: the SOURCE store's manager, or anyone with stock.approve
// (Senior Engineer / Admin). Approval moves the stock between the stores.
r.patch('/transfers/:id', requireCap('stock.view'), async (req, res) => {
  const status = req.body.status
  if (!['APPROVED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'Status must be APPROVED or REJECTED' })
  const transfer = await db.stockTransfer.findFirst({
    where: { id: +req.params.id, clientId: req.client.id },
    include: TRANSFER_INCLUDE,
  })
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' })
  if (transfer.status !== 'PENDING') return res.status(400).json({ error: 'This transfer was already decided' })
  const isSourceManager = transfer.fromStore.managerId === req.user.id
  if (!isSourceManager && !can(req, 'stock.approve'))
    return res.status(403).json({ error: `Only ${transfer.fromStore.name}'s manager, a Senior Engineer or the admin can decide this transfer` })

  if (status === 'REJECTED') {
    const updated = await db.stockTransfer.update({
      where: { id: transfer.id },
      data: { status, decidedBy: req.user.name, decidedAt: new Date() },
      include: TRANSFER_INCLUDE,
    })
    await audit(req.client.id, req.user.name, 'stock.transfer.rejected',
      `${transfer.qty} ${transfer.item.unit} ${transfer.item.name}: ${transfer.fromStore.name} → ${transfer.toStore.name}`)
    return res.json(shapeTransfer(updated))
  }

  // Approve: move the quantity. Full-quantity moves relocate the item itself
  // (keeps serials on machines); partial moves split into the target store's
  // matching item (same name/unit) or a new one.
  const result = await db.$transaction(async (tx) => {
    const item = await tx.stockItem.findUnique({ where: { id: transfer.itemId } })
    if (!item || item.storeId !== transfer.fromStoreId) throw new Error('The item is no longer in the source store')
    if (item.qty < transfer.qty) throw new Error(`${transfer.fromStore.name} only has ${item.qty} ${item.unit} left`)
    const toStore = await tx.stockStore.findUnique({ where: { id: transfer.toStoreId } })
    if (!toStore) throw new Error('The destination store no longer exists')

    if (item.qty === transfer.qty) {
      await tx.stockItem.update({
        where: { id: item.id },
        data: { storeId: toStore.id, projectId: toStore.projectId },
      })
    } else {
      await tx.stockItem.update({ where: { id: item.id }, data: { qty: { decrement: transfer.qty } } })
      const target = await tx.stockItem.findFirst({
        where: { clientId: transfer.clientId, storeId: toStore.id, name: item.name, unit: item.unit },
      })
      if (target) await tx.stockItem.update({ where: { id: target.id }, data: { qty: { increment: transfer.qty } } })
      else await tx.stockItem.create({
        data: {
          clientId: transfer.clientId, projectId: toStore.projectId, storeId: toStore.id,
          name: item.name, category: item.category, qty: transfer.qty, unit: item.unit,
          unitCost: item.unitCost, lowThreshold: item.lowThreshold,
        },
      })
    }
    return tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: 'APPROVED', decidedBy: req.user.name, decidedAt: new Date() },
      include: TRANSFER_INCLUDE,
    })
  }).catch((e) => ({ error: e.message }))
  if (result.error) return res.status(400).json({ error: result.error })

  // The source store may have just crossed its low-stock threshold.
  const after = await db.stockItem.findUnique({ where: { id: transfer.itemId } })
  if (after && after.storeId === transfer.fromStoreId)
    checkLowStock(req.client, after, after.qty + transfer.qty)

  await audit(req.client.id, req.user.name, 'stock.transfer.approved',
    `${transfer.qty} ${transfer.item.unit} ${transfer.item.name}: ${transfer.fromStore.name} → ${transfer.toStore.name}`)
  res.json(shapeTransfer(result))
})

// Resolve an optional storeId: must belong to the client and be in scope; the
// item's project is then taken FROM the store (a store pins the project).
// A store's own manager always reaches it, whatever their project scope.
async function resolveStore(req, scope) {
  if (!req.body.storeId) return { storeId: null }
  const store = await db.stockStore.findFirst({ where: { id: +req.body.storeId, clientId: req.client.id } })
  if (!store || (store.managerId !== req.user.id && !inScope(scope, store.projectId)))
    return { error: 'Store not found' }
  return { storeId: store.id, projectId: store.projectId, storeName: store.name }
}

r.post('/', requireCap('stock.edit'), async (req, res) => {
  const { name, category, qty, unit, unitCost, serial, lowThreshold } = req.body
  if (!name) return res.status(400).json({ error: 'Product name is required' })
  if (category === 'Machine' && !serial)
    return res.status(400).json({ error: 'Machines/tools require a serial number' })
  if ([qty, unitCost, lowThreshold].some(isNegative))
    return res.status(400).json({ error: 'Quantity, unit cost and threshold cannot be negative' })
  const scope = await scopedProjectIds(req)
  const proj = await resolveProject(req, scope)
  if (proj.error) return res.status(404).json({ error: proj.error })
  const store = await resolveStore(req, scope)
  if (store.error) return res.status(404).json({ error: store.error })
  // A store-scoped manager inserts into their own store(s) only.
  const managedIns = await managedStoreIds(req)
  if (managedIns) {
    if (!store.storeId && managedIns.length === 1) {
      const own = await db.stockStore.findUnique({ where: { id: managedIns[0] } })
      store.storeId = own.id; store.projectId = own.projectId; store.storeName = own.name
    }
    if (!store.storeId || !managedIns.includes(store.storeId))
      return res.status(403).json({ error: 'You can only add products to your own store' })
  }
  const item = await db.stockItem.create({
    data: {
      clientId: req.client.id,
      // a store pins the project - otherwise the picked project (or general)
      projectId: store.storeId ? store.projectId : proj.projectId,
      storeId: store.storeId,
      name, category: category || 'Consumable',
      qty: whole(qty), unit: unit || 'pcs', unitCost: whole(unitCost),
      serial: serial || null, lowThreshold: whole(lowThreshold),
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
  // A store-scoped manager bulk-inserts into their own store(s) only.
  const managedBulk = await managedStoreIds(req)
  if (managedBulk) {
    if (!store.storeId && managedBulk.length === 1) {
      const own = await db.stockStore.findUnique({ where: { id: managedBulk[0] } })
      store.storeId = own.id; store.projectId = own.projectId; store.storeName = own.name
    }
    if (!store.storeId || !managedBulk.includes(store.storeId))
      return res.status(403).json({ error: 'You can only add products to your own store' })
  }

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
      qty: whole(raw.qty),
      unit: String(raw.unit ?? '').trim() || 'pcs',
      unitCost: whole(raw.unitCost),
      serial,
      lowThreshold: whole(raw.lowThreshold),
    })
  }
  if (valid.length) await db.stockItem.createMany({ data: valid })
  await audit(req.client.id, req.user.name, 'stock.bulk',
    `${valid.length} items inserted${skipped.length ? `, ${skipped.length} skipped` : ''}${proj.projectName ? ' · ' + proj.projectName : ''}`)
  res.json({ added: valid.length, skipped })
})

r.patch('/:id', requireCap('stock.edit'), async (req, res) => {
  const scope = await scopedProjectIds(req)
  const managed = await managedStoreIds(req)
  const item = await db.stockItem.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  // A store assignment IS the manager's scope - their own store's items are
  // always reachable; everyone else keeps the project-scope rule.
  const reachable = item && (managed
    ? managed.includes(item.storeId)
    : !item.projectId || inScope(scope, item.projectId))
  if (!reachable) return res.status(404).json({ error: 'Item not found' })
  if (['qty', 'unitCost', 'lowThreshold'].some(k => isNegative(req.body[k])))
    return res.status(400).json({ error: 'Quantity, unit cost and threshold cannot be negative' })
  const data = {}
  for (const k of ['name', 'unit', 'serial']) if (req.body[k] !== undefined) data[k] = req.body[k]
  for (const k of ['qty', 'unitCost', 'lowThreshold']) if (req.body[k] !== undefined) data[k] = whole(req.body[k])
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
    const id = +i.stockItemId, qty = Math.floor(Number(i.qty))
    if (id && qty > 0) wanted.set(id, (wanted.get(id) ?? 0) + qty)
  }
  if (!wanted.size) return res.status(400).json({ error: 'Add at least one item' })
  const managedIssue = await managedStoreIds(req)
  const draws = []
  for (const [stockItemId, qty] of wanted) {
    const item = await db.stockItem.findFirst({
      where: {
        id: stockItemId, clientId: req.client.id,
        // a store-scoped manager only hands out their own store's stock
        ...(managedIssue ? { storeId: { in: managedIssue } } : {}),
      },
    })
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
      // Conditional decrement: the availability check above happened outside
      // the transaction and can be stale, so only take from rows that still
      // hold enough. Without this two concurrent hand-outs of the same item
      // both succeed and stock goes negative.
      const taken = await tx.stockItem.updateMany({
        where: { id: d.item.id, qty: { gte: d.qty } },
        data: { qty: { decrement: d.qty } },
      })
      if (!taken.count) {
        const err = new Error(`${d.item.name} ran out while you were issuing it - refresh and try again`)
        err.status = 409
        throw err
      }
      await tx.stockIssueItem.create({
        data: {
          issueId: created.id, stockItemId: d.item.id, nameSnap: d.item.name,
          unitSnap: d.item.unit, qty: d.qty, unitCostSnap: d.item.unitCost,
        },
      })
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
  const managed = await managedStoreIds(req)
  const issues = await db.stockIssue.findMany({
    where: {
      clientId: req.client.id,
      // store-scoped manager: their own hand-outs + any issue drawing from
      // their stores' items
      ...(managed ? {
        OR: [
          { issuedById: req.user.id },
          { items: { some: { stockItem: { storeId: { in: managed } } } } },
        ],
      } : {}),
    },
    include: ISSUE_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  res.json(issues.map(i => shapeIssue(i, showMoney)))
})

// ---- Returns: the other half of an issue ----
// A worker takes 100 bags to the site in the morning and hands the unused ones
// back in the afternoon. Each hand-back is recorded against the original issue,
// so the outstanding quantity - what that person still holds - is always known.
// Good items go back into the store; damaged ones are logged as damaged instead
// so stock never counts a broken item as usable.

const ISSUE_INCLUDE = {
  items: true,
  issuedBy: { select: { name: true } },
  worker: { select: { id: true, name: true, type: true, photo: true } },
  user: { select: { id: true, name: true, role: true, photo: true } },
}

const recipientOf = (i) => (i.worker
  ? { kind: 'worker', id: i.worker.id, name: i.worker.name, sub: i.worker.type, photo: i.worker.photo ? '/uploads/' + i.worker.photo : null }
  : { kind: 'user', id: i.user?.id ?? null, name: i.user?.name ?? '-', sub: i.user?.role ?? '', photo: i.user?.photo ? '/uploads/' + i.user.photo : null })

function shapeIssue(i, showMoney) {
  const items = i.items.map(it => ({
    id: it.id, stockItemId: it.stockItemId, name: it.nameSnap, qty: it.qty, unit: it.unitSnap,
    returnedQty: it.returnedQty, outstanding: Math.max(0, it.qty - it.returnedQty),
    cost: showMoney ? it.qty * it.unitCostSnap : null,
  }))
  return {
    id: i.id, createdAt: i.createdAt, viaCard: i.viaCard, note: i.note,
    issuedBy: i.issuedBy.name,
    recipient: recipientOf(i),
    items,
    outstanding: items.reduce((s, it) => s + it.outstanding, 0),
    total: showMoney ? i.items.reduce((s, it) => s + it.qty * it.unitCostSnap, 0) : null,
  }
}

// What a person is still holding. Scanning their card on the Returns screen
// lists exactly what they have not brought back yet.
r.get('/outstanding/:cardId', requireCap('stock.issue'), async (req, res) => {
  const found = await personByCard(req.client.id, String(req.params.cardId).trim())
  if (!found) return res.status(404).json({ error: 'Card not recognised' })
  const { worker, user } = found
  const managed = await managedStoreIds(req)
  const issues = await db.stockIssue.findMany({
    where: {
      clientId: req.client.id,
      ...(worker ? { workerId: worker.id } : { userId: user.id }),
      // a store-scoped manager only takes back their own store's stock
      ...(managed ? { items: { some: { stockItem: { storeId: { in: managed } } } } } : {}),
    },
    include: ISSUE_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const showMoney = can(req, 'stock.amounts')
  const open = issues.map(i => shapeIssue(i, showMoney)).filter(i => i.outstanding > 0)
  res.json({
    person: worker
      ? { kind: 'worker', name: worker.name, sub: worker.type, photo: worker.photo ? '/uploads/' + worker.photo : null }
      : { kind: 'user', name: user.name, sub: user.role, photo: user.photo ? '/uploads/' + user.photo : null },
    issues: open,
    outstanding: open.reduce((s, i) => s + i.outstanding, 0),
  })
})

r.post('/returns', requireCap('stock.issue'), async (req, res) => {
  const cardId = String(req.body.cardId ?? '').trim()
  if (!cardId) return res.status(400).json({ error: 'Scan the card\'s QR code or type the card id' })
  const found = await personByCard(req.client.id, cardId)
  if (!found) return res.status(404).json({ error: 'Card not recognised' })
  const { worker, user } = found

  // Merge duplicate rows per issue line, exactly as the issue endpoint does.
  const wanted = new Map() // issueItemId → { good, damaged }
  for (const row of Array.isArray(req.body.items) ? req.body.items : []) {
    const id = +row.issueItemId
    const qty = Math.floor(Number(row.qty))
    if (!id || !(qty > 0)) continue
    const condition = row.condition === 'damaged' ? 'damaged' : 'good'
    const cell = wanted.get(id) ?? { good: 0, damaged: 0 }
    cell[condition] += qty
    wanted.set(id, cell)
  }
  if (!wanted.size) return res.status(400).json({ error: 'Enter at least one quantity to return' })

  // Every line must belong to an issue of this account made to THIS person, and
  // cannot give back more than is still outstanding.
  const lines = await db.stockIssueItem.findMany({
    where: { id: { in: [...wanted.keys()] }, issue: { clientId: req.client.id } },
    include: { issue: { select: { id: true, workerId: true, userId: true } }, stockItem: true },
  })
  if (lines.length !== wanted.size) return res.status(404).json({ error: 'One of those hand-outs no longer exists' })

  const issueIds = new Set(lines.map(l => l.issueId))
  if (issueIds.size !== 1)
    return res.status(400).json({ error: 'Return the items of one hand-out at a time' })
  const issueId = [...issueIds][0]

  for (const line of lines) {
    const belongs = worker ? line.issue.workerId === worker.id : line.issue.userId === user.id
    if (!belongs) return res.status(403).json({ error: 'Those items were handed out to somebody else' })
    const { good, damaged } = wanted.get(line.id)
    const outstanding = line.qty - line.returnedQty
    if (good + damaged > outstanding)
      return res.status(400).json({
        error: `${line.nameSnap}: only ${outstanding} ${line.unitSnap} still out${line.returnedQty ? ` (${line.returnedQty} already returned)` : ''}`,
      })
  }

  const note = String(req.body.note ?? '').trim() || null
  const damagedLog = []
  const restocked = []

  const created = await db.$transaction(async (tx) => {
    const ret = await tx.stockReturn.create({
      data: {
        clientId: req.client.id, issueId, receivedById: req.user.id,
        workerId: worker?.id ?? null, userId: user?.id ?? null,
        viaCard: true, note,
      },
    })
    for (const line of lines) {
      const { good, damaged } = wanted.get(line.id)
      for (const [condition, qty] of [['good', good], ['damaged', damaged]]) {
        if (!qty) continue
        await tx.stockReturnItem.create({
          data: {
            returnId: ret.id, issueItemId: line.id, stockItemId: line.stockItemId,
            nameSnap: line.nameSnap, unitSnap: line.unitSnap, qty,
            unitCostSnap: line.unitCostSnap, condition,
          },
        })
      }
      const total = good + damaged
      // Guard against two people recording the same hand-back at once: only
      // advance the line if it still has room for this quantity.
      const bumped = await tx.stockIssueItem.updateMany({
        where: { id: line.id, returnedQty: { lte: line.qty - total } },
        data: { returnedQty: { increment: total } },
      })
      if (!bumped.count) {
        const err = new Error(`${line.nameSnap} was already returned by someone else - refresh and try again`)
        err.status = 409
        throw err
      }
      if (good) {
        await tx.stockItem.update({ where: { id: line.stockItemId }, data: { qty: { increment: good } } })
        restocked.push(`${good} ${line.unitSnap} ${line.nameSnap}`)
      }
      if (damaged) {
        // Damaged goods do NOT go back into the usable quantity - they are
        // logged so the admin can decide what happens to them.
        await tx.damagedItem.create({
          data: {
            clientId: req.client.id,
            projectId: line.stockItem?.projectId ?? null,
            name: line.nameSnap,
            serial: line.stockItem?.serial ?? null,
            note: `${damaged} ${line.unitSnap} returned damaged by ${worker?.name ?? user.name}${note ? ` - ${note}` : ''}`,
          },
        })
        damagedLog.push(`${damaged} ${line.unitSnap} ${line.nameSnap}`)
      }
    }
    return ret
  })

  const person = worker ? `${worker.name} (${worker.type})` : `${user.name} (${user.role})`
  await audit(req.client.id, req.user.name, 'stock.returned',
    `${person} returned ${[...restocked, ...damagedLog.map(d => d + ' damaged')].join(', ')}`)
  res.json({ ok: true, id: created.id, person, restocked, damaged: damagedLog })
})

r.get('/returns', requireCap('stock.view'), async (req, res) => {
  const showMoney = can(req, 'stock.amounts')
  const managed = await managedStoreIds(req)
  const returns = await db.stockReturn.findMany({
    where: {
      clientId: req.client.id,
      ...(managed ? {
        OR: [
          { receivedById: req.user.id },
          { items: { some: { stockItem: { storeId: { in: managed } } } } },
        ],
      } : {}),
    },
    include: {
      items: true,
      receivedBy: { select: { name: true } },
      worker: { select: { name: true, type: true, photo: true } },
      user: { select: { name: true, role: true, photo: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  res.json(returns.map(rt => ({
    id: rt.id, issueId: rt.issueId, createdAt: rt.createdAt, note: rt.note,
    receivedBy: rt.receivedBy.name,
    person: recipientOf(rt),
    items: rt.items.map(it => ({
      name: it.nameSnap, qty: it.qty, unit: it.unitSnap, condition: it.condition,
      cost: showMoney ? it.qty * it.unitCostSnap : null,
    })),
    returnedQty: rt.items.reduce((s, it) => s + it.qty, 0),
    damagedQty: rt.items.filter(it => it.condition === 'damaged').reduce((s, it) => s + it.qty, 0),
    total: showMoney ? rt.items.reduce((s, it) => s + it.qty * it.unitCostSnap, 0) : null,
  })))
})

// ---- Requests (Stock Manager submits; Senior Engineer approves - PRD 7.1 default) ----

r.get('/requests', requireCap('stock.view'), async (req, res) => {
  const ids = await scopedProjectIds(req)
  const requests = await db.stockRequest.findMany({
    where: { clientId: req.client.id, ...projectScopeWhere(ids) },
    include: { requestedBy: { select: { name: true } }, project: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200, // unbounded before: this grows for the life of the account
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
    take: 200, // unbounded before
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
