// Permanently delete a company and everything belonging to it.
//
// Shared by the Super Admin endpoint and `npm run purge:demo -- --wipe`, so the
// two can never drift apart - a table added to one and forgotten in the other
// would leave orphan rows or a foreign key that blocks the delete entirely.
//
// The schema declares no `onDelete`, so MySQL applies Restrict: children have
// to go before parents, and the order below matters.
import { db } from './db.js'
import { removeStoredFile } from './uploads.js'

// Every uploaded file this company owns, so nothing is orphaned on disk.
async function filesOf(clientId) {
  const files = []
  const push = (name) => { if (name) files.push(name) }

  const [docs, media, workers, users, client, messages, insights] = await Promise.all([
    db.document.findMany({ where: { clientId }, select: { path: true } }),
    db.media.findMany({ where: { update: { clientId } }, select: { path: true } }),
    db.worker.findMany({ where: { clientId }, select: { photo: true } }),
    db.user.findMany({ where: { clientId }, select: { photo: true } }),
    db.client.findUnique({ where: { id: clientId }, select: { logo: true } }),
    db.message.findMany({ where: { clientId }, select: { attachments: true } }),
    db.keyInsight.findMany({ where: { phase: { project: { clientId } } }, select: { media: true } }),
  ])

  docs.forEach(d => push(d.path))
  media.forEach(m => push(m.path))
  workers.forEach(w => push(w.photo))
  users.forEach(u => push(u.photo))
  push(client?.logo)
  for (const m of messages) for (const a of m.attachments ?? []) push(a?.path)
  for (const i of insights) for (const m of i.media ?? []) push(m?.path)

  return files
}

// Row counts kept for the deletion record - "we removed a company" is a lot
// less useful after the fact than "we removed a company with 4 projects,
// 11 users and 1,300 attendance records".
async function countsOf(clientId) {
  const [users, projects, phases, updates, attendance, workers, stockItems, documents, messages, payments] =
    await Promise.all([
      db.user.count({ where: { clientId } }),
      db.project.count({ where: { clientId } }),
      db.phase.count({ where: { project: { clientId } } }),
      db.dailyUpdate.count({ where: { clientId } }),
      db.attendanceRecord.count({ where: { session: { clientId } } }),
      db.worker.count({ where: { clientId } }),
      db.stockItem.count({ where: { clientId } }),
      db.document.count({ where: { clientId } }),
      db.message.count({ where: { clientId } }),
      db.payment.count({ where: { clientId } }),
    ])
  return { users, projects, phases, updates, attendance, workers, stockItems, documents, messages, payments }
}

/**
 * Wipes a company. Returns { company, counts, files } describing what went.
 * Throws if the client does not exist.
 */
export async function deleteClientCascade(clientId, { deletedBy } = {}) {
  const client = await db.client.findUnique({ where: { id: clientId } })
  if (!client) throw Object.assign(new Error('Company not found'), { status: 404 })

  const counts = await countsOf(clientId)
  const files = await filesOf(clientId)

  await db.$transaction([
    // Written inside the same transaction as the deletion, so the record and
    // the removal succeed or fail together - a company must never disappear
    // leaving no trace of who removed it. DeletedClient has no FK to Client,
    // so it is safe to write before the parent row goes.
    ...(deletedBy ? [db.deletedClient.create({
      data: {
        clientId, company: client.company, country: client.country,
        plan: client.plan, status: client.status, signupAt: client.createdAt,
        deletedBy, removed: { ...counts, files: files.length },
      },
    })] : []),
    db.stockReturnItem.deleteMany({ where: { return: { clientId } } }),
    db.stockReturn.deleteMany({ where: { clientId } }),
    db.stockIssueItem.deleteMany({ where: { issue: { clientId } } }),
    db.stockIssue.deleteMany({ where: { clientId } }),
    db.stockTransfer.deleteMany({ where: { clientId } }),
    db.media.deleteMany({ where: { update: { clientId } } }),
    db.updateMaterial.deleteMany({ where: { update: { clientId } } }),
    db.dailyUpdate.deleteMany({ where: { clientId } }),
    db.attendanceRecord.deleteMany({ where: { session: { clientId } } }),
    db.attendanceSession.deleteMany({ where: { clientId } }),
    db.phaseMaterial.deleteMany({ where: { phase: { project: { clientId } } } }),
    db.keyInsight.deleteMany({ where: { phase: { project: { clientId } } } }),
    db.phase.deleteMany({ where: { project: { clientId } } }),
    db.projectMember.deleteMany({ where: { project: { clientId } } }),
    db.stockItem.deleteMany({ where: { clientId } }),
    db.stockStore.deleteMany({ where: { clientId } }),
    db.stockRequest.deleteMany({ where: { clientId } }),
    db.damagedItem.deleteMany({ where: { clientId } }),
    db.cardIssue.deleteMany({ where: { clientId } }),
    db.worker.deleteMany({ where: { clientId } }),
    db.document.deleteMany({ where: { clientId } }),
    db.folder.deleteMany({ where: { clientId } }),
    db.message.deleteMany({ where: { clientId } }),
    db.auditLog.deleteMany({ where: { clientId } }),
    db.payment.deleteMany({ where: { clientId } }),
    db.project.deleteMany({ where: { clientId } }),
    db.resetToken.deleteMany({ where: { user: { clientId } } }),
    db.user.deleteMany({ where: { clientId } }),
    db.client.delete({ where: { id: clientId } }),
  ])

  // Only once the rows are gone - a failed transaction must not have taken the
  // files with it.
  for (const f of files) removeStoredFile(f)

  return { company: client.company, counts, files: files.length }
}
