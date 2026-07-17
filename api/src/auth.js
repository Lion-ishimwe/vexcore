import jwt from 'jsonwebtoken'
import { db } from './db.js'
import { subscriptionOf } from './plans.js'

const SECRET = process.env.JWT_SECRET || 'dev'

export const DEFAULT_SETTINGS = {
  stockVisibleToSite: true,
  stockVisibleToClient: true,
  mediaDownload: false,
  stockMgrEdit: false,
  twoFA: false,
  guestAccess: true,
  // Granular guest access - each area is enabled individually by the Admin.
  guestPhases: true,
  guestUpdates: true,
  guestStock: false,
  guestSchedule: true,
  // Worker types available when enrolling (Settings › Access control) - the
  // admin can add site roles beyond the two defaults.
  workerTypes: ['builder', 'helper'],
  // Attendance time windows: when enabled, clock-ins/outs are only accepted
  // inside these ranges (late arrivals are not recorded).
  attWindows: false,
  attInStart: '07:00',
  attInEnd: '08:00',
  attOutStart: '17:00',
  attOutEnd: '20:00',
}

const ROLE_CAPS = {
  SUPER: ['*'],
  CLIENT: ['dashboard', 'projects.view', 'projects.create', 'phases.view', 'schedule.view', 'updates.view',
    'stock.amounts', 'damaged.view', 'chat', 'reports', 'settings.edit', 'team.view',
    'team.create', 'billing', 'audit.view', 'docs.view', 'docs.upload', 'docs.admin',
    'attendance.view', 'attendance.session'],
  SENIOR: ['dashboard', 'projects.view', 'phases.view', 'schedule.view', 'phases.edit', 'updates.view',
    'updates.submit', 'updates.forward', 'stock.view', 'stock.amounts', 'stock.edit',
    'stock.approve', 'damaged.view', 'chat', 'reports', 'team.view', 'team.create', 'audit.view',
    'docs.view', 'docs.upload', 'attendance.view', 'attendance.record', 'attendance.session', 'workers.manage'],
  SITE: ['dashboard', 'projects.view', 'phases.view', 'schedule.view', 'updates.view', 'updates.submit', 'chat',
    'docs.view', 'docs.upload', 'attendance.view', 'attendance.record', 'workers.manage'],
  STOCK: ['dashboard', 'stock.view', 'stock.request', 'chat', 'docs.view', 'docs.upload',
    'attendance.view', 'attendance.record'],
  GUEST: ['dashboard', 'projects.view', 'phases.view', 'schedule.view', 'updates.view', 'docs.view'],
}
// The account admin (CLIENT role) can do everything the roles below them can.
ROLE_CAPS.CLIENT = [...new Set([
  ...ROLE_CAPS.CLIENT, ...ROLE_CAPS.SENIOR, ...ROLE_CAPS.SITE, ...ROLE_CAPS.STOCK,
])]

export function settingsOf(client) {
  return { ...DEFAULT_SETTINGS, ...(client?.settings ?? {}) }
}

// Full capability list for a user, with settings-conditional grants applied.
export function capsFor(user, client) {
  const caps = new Set(ROLE_CAPS[user.role] ?? [])
  const s = settingsOf(client)
  if (user.role === 'SITE' && s.stockVisibleToSite) caps.add('stock.view')
  if (user.role === 'STOCK' && s.stockMgrEdit) caps.add('stock.edit')
  if (s.mediaDownload) caps.add('media.download')
  // Guest areas are opt-in/out individually (Settings → Guest access).
  if (user.role === 'GUEST') {
    if (!s.guestPhases) caps.delete('phases.view')
    if (!s.guestUpdates) caps.delete('updates.view')
    if (!s.guestSchedule) caps.delete('schedule.view')
    if (s.guestStock) caps.add('stock.view')
  }
  return [...caps]
}

export function can(req, cap) {
  if (req.user.role === 'SUPER') return true
  return capsFor(req.user, req.client).includes(cap)
}

export function sign(user) {
  return jwt.sign({ uid: user.id }, SECRET, { expiresIn: '7d' })
}

// Support mode: the Super Admin opens a company's workspace acting as its
// admin. The token carries who they really are (uid) and which client they
// act inside (actAs).
export function signImpersonation(user, client) {
  return jwt.sign({ uid: user.id, actAs: client.id }, SECRET, { expiresIn: '8h' })
}

// Short-lived token that only allows completing 2FA setup during login
// (issued when the account enforces 2FA and the user hasn't set it up yet).
export function signSetupToken(user) {
  return jwt.sign({ uid: user.id, scope: '2fa-setup' }, SECRET, { expiresIn: '15m' })
}

export function verifySetupToken(token) {
  try {
    const payload = jwt.verify(token ?? '', SECRET)
    return payload.scope === '2fa-setup' ? payload : null
  } catch {
    return null
  }
}

export async function authRequired(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Not authenticated' })
  let payload
  try {
    payload = jwt.verify(token, SECRET)
  } catch {
    return res.status(401).json({ error: 'Session expired - log in again' })
  }
  // Scoped tokens (e.g. 2FA setup) are not full sessions.
  if (payload.scope) return res.status(401).json({ error: 'Not authenticated' })
  const user = await db.user.findUnique({ where: { id: payload.uid }, include: { client: true } })
  if (!user) return res.status(401).json({ error: 'Account not found' })
  // Support mode: Super Admin acting as a company's admin. Status/2FA/expiry
  // gates are skipped on purpose - support must reach locked accounts too.
  if (payload.actAs) {
    if (user.role !== 'SUPER') return res.status(401).json({ error: 'Not authenticated' })
    const client = await db.client.findUnique({ where: { id: payload.actAs } })
    if (!client) return res.status(404).json({ error: 'Company not found' })
    req.user = { ...user, role: 'CLIENT', clientId: client.id }
    req.client = client
    req.impersonating = true
    return next()
  }
  if (user.role !== 'SUPER') {
    if (!user.client) return res.status(403).json({ error: 'No client account' })
    if (['SUSPENDED', 'TERMINATED'].includes(user.client.status))
      return res.status(403).json({ error: `Account ${user.client.status.toLowerCase()} - contact support` })
    // Account-wide 2FA enforcement: existing sessions of users who haven't set
    // up 2FA are invalidated so they go through setup at their next login.
    if (settingsOf(user.client).twoFA && !user.totpEnabled)
      return res.status(401).json({
        error: 'Two-factor authentication is now required for your account - log in again to set it up',
        need2faSetup: true,
      })
    // Expired trial / lapsed subscription → READ-ONLY lockdown: everyone can
    // still log in, see everything and download as usual (GET requests pass),
    // but nothing can be changed until payment. Billing, auth and the user's
    // own account page stay fully open so the admin can pay.
    const sub = subscriptionOf(user.client)
    if (sub.expired &&
      !['GET', 'HEAD'].includes(req.method) &&
      !['/api/billing', '/api/auth', '/api/account'].some((p) => req.originalUrl.startsWith(p)))
      return res.status(403).json({
        error: user.role === 'CLIENT'
          ? (sub.status === 'TRIAL' ? 'Your free trial has ended - subscribe to make changes again' : 'Your subscription has expired - renew to make changes again')
          : 'This account\'s subscription has expired - viewing is open, but changes need your admin to renew',
        expired: true,
      })
  }
  req.user = user
  req.client = user.client
  next()
}

export function requireCap(cap) {
  return (req, res, next) => {
    if (!can(req, cap)) return res.status(403).json({ error: 'No permission: ' + cap })
    next()
  }
}
