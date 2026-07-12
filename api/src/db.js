import { PrismaClient } from '@prisma/client'

export const db = new PrismaClient()

export async function audit(clientId, userName, action, detail = null) {
  try {
    await db.auditLog.create({ data: { clientId, userName, action, detail } })
  } catch (e) {
    console.error('audit failed', e.message)
  }
}
