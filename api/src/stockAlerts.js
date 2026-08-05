import { db } from './db.js'
import { sendMail, APP_URL } from './mail.js'
import { settingsOf } from './auth.js'

// Low-stock email alert: fires only when an item CROSSES its threshold
// (was above before the operation, at/below after) - so one email per event,
// not one per draw while it sits low. Goes to everyone stock-responsible.
// Callers deliberately do not await this (an alert must never delay or fail a
// stock draw), which means an unhandled rejection in here would take the whole
// process down. Everything is wrapped.
export async function checkLowStock(client, item, prevQty) {
  try {
    await runLowStockCheck(client, item, prevQty)
  } catch (e) {
    console.error('[stock] low-stock alert failed:', e.message)
  }
}

async function runLowStockCheck(client, item, prevQty) {
  if (!settingsOf(client).emailLowStock) return
  if (!item.lowThreshold || item.lowThreshold <= 0) return
  if (prevQty <= item.lowThreshold) return // was already low - no repeat spam
  if (item.qty > item.lowThreshold) return // still above the threshold
  // Name WHERE the shortage is: the specific store (with its project), the
  // project's unassigned stock, or the general store.
  let where = 'the general store'
  if (item.storeId) {
    const store = await db.stockStore.findUnique({
      where: { id: item.storeId },
      include: { project: { select: { name: true } } },
    })
    if (store) where = `the "${store.name}" store (${store.project.name})`
  } else if (item.projectId) {
    const project = await db.project.findUnique({ where: { id: item.projectId } })
    if (project) where = `${project.name}'s stock`
  }
  const recipients = await db.user.findMany({
    where: { clientId: client.id, role: { in: ['CLIENT', 'SENIOR', 'STOCK'] } },
  })
  sendMail(recipients.map(u => u.email), `Low stock: ${item.name} - ${where.replace(/^the /, '')}`, {
    title: '⚠ Low stock alert',
    lines: [
      `<b>${item.name}</b> just dropped to <b>${item.qty} ${item.unit}</b> in <b>${where}</b> - at or below its low-stock threshold of ${item.lowThreshold} ${item.unit}.`,
      'Restock it - or request a transfer from another store that still has it.',
    ],
    buttonText: 'Open stock',
    buttonUrl: `${APP_URL}/#/stock`,
  })
}
