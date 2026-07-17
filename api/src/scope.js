import { db } from './db.js'

// Project-level scoping: returns the project ids this user is limited to,
// or null for "no restriction".
// - Admins (CLIENT) and SUPER see every project in the account.
// - Everyone else (SENIOR / SITE / STOCK / GUEST) sees ONLY the projects they
//   are assigned to (Projects › Assign team) - even the project count. A user
//   assigned to nothing sees no projects at all until the admin assigns them.
export async function scopedProjectIds(req) {
  if (!req.client || ['CLIENT', 'SUPER'].includes(req.user.role)) return null
  const rows = await db.projectMember.findMany({
    where: { userId: req.user.id, project: { clientId: req.client.id } },
    select: { projectId: true },
  })
  return rows.map((r) => r.projectId) // [] = strictly nothing
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
