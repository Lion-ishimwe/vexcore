import crypto from 'node:crypto'
import { db } from './db.js'

// Card/badge ids: C<companyId>-<6 chars>, unique across workers AND team
// members - one scan namespace, so a QR resolves to exactly one person.
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I confusion

export async function genCardId(clientId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = ''
    const bytes = crypto.randomBytes(6)
    for (const b of bytes) code += ID_ALPHABET[b % ID_ALPHABET.length]
    const cardId = `C${clientId}-${code}`
    const takenWorker = await db.worker.findFirst({ where: { clientId, cardId } })
    const takenUser = await db.user.findFirst({ where: { cardId } })
    if (!takenWorker && !takenUser) return cardId
  }
  throw new Error('Could not generate a unique card id')
}
