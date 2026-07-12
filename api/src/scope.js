import { db } from './db.js'

// Project-level scoping: returns the project ids this user is limited to,
// or null for "no restriction".
// - Admins (CLIENT), SUPER and guests see every project in the account.
// - SENIOR / SITE / STOCK assigned to projects see only those projects.
// - Staff assigned to no project keep full visibility (legacy default, and
//   how single-project accounts keep working without any setup).
export async function scopedProjectIds(req) {
  if (!req.client || ['CLIENT', 'SUPER', 'GUEST'].includes(req.user.role)) return null
  const rows = await db.projectMember.findMany({
    where: { userId: req.user.id, project: { clientId: req.client.id } },
    select: { projectId: true },
  })
  return rows.length ? rows.map((r) => r.projectId) : null
}

// Prisma `where` fragment for records that carry an optional projectId:
// scoped users see their projects' records plus unassigned ("general") ones.
export function projectScopeWhere(ids) {
  return ids ? { OR: [{ projectId: null }, { projectId: { in: ids } }] } : {}
}

// True when the user may touch this specific project.
export function inScope(ids, projectId) {
  return !ids || ids.includes(projectId)
}
