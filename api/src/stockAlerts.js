import { db } from './db.js'
import { sendMail, APP_URL } from './mail.js'
import { settingsOf } from './auth.js'

// Low-stock email alert: fires only when an item CROSSES its threshold
// (was above before the operation, at/below after) - so one email per event,
// not one per draw while it sits low. Goes to everyone stock-responsible.
export async function checkLowStock(client, item, prevQty) {
  if (!settingsOf(client).emailLowStock) return
  if (!item.lowThreshold || item.lowThreshold <= 0) return
  if (prevQty <= item.lowThreshold) return // was already low - no repeat spam
  if (item.qty > item.lowThreshold) return // still above the threshold
  const recipients = await db.user.findMany({
    where: { clientId: client.id, role: { in: ['CLIENT', 'SENIOR', 'STOCK'] } },
  })
  sendMail(recipients.map(u => u.email), `Low stock: ${item.name}`, {
    title: '⚠ Low stock alert',
    lines: [
      `<b>${item.name}</b> just dropped to <b>${item.qty} ${item.unit}</b> - at or below its low-stock threshold of ${item.lowThreshold} ${item.unit}.`,
      'Restock it before the sites run dry.',
    ],
    buttonText: 'Open stock',
    buttonUrl: `${APP_URL}/#/stock`,
  })
}
