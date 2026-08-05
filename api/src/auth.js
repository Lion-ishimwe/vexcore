import jwt from 'jsonwebtoken'
import { db } from './db.js'
import { subscriptionOf } from './plans.js'

// No fallback secret. A missing JWT_SECRET used to silently become the string
// 'dev', which makes every session token on the deployment forgeable - refuse
// to start instead, so the mistake is loud at boot rather than silent forever.
const SECRET = process.env.JWT_SECRET
if (!SECRET || SECRET.length < 32) {
  console.error(
    '\nFATAL: JWT_SECRET is ' + (SECRET ? 'too short' : 'not set') + '.\n' +
    'Set it to at least 32 random characters before starting the API, e.g.\n' +
    "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"\n")
  process.exit(1)
}
// Pin the algorithm on every verify: without it the library will honour
// whatever alg the token itself declares.
const JWT_OPTS = { algorithms: ['HS256'] }

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
  // Email notifications (Settings › Access control) - each one the company's
  // users receive can be switched off individually by the admin.
  emailPhaseDone: true,
  emailDailyReport: true,
  emailLowStock: true,
  // Senior Engineers may suspend/activate/delete team members when the admin
  // grants it (admins always can).
  seniorTeamManage: false,
  // Attendance access per role - the admin grants it individually (admins
  // always have it). Off = the role loses the Attendance page and endpoints.
  attSenior: true,
  attSite: true,
  attStock: true,
  // Projects access for Stock Managers - granted individually by the admin
  // (view-only: their assigned projects and phase boards, no editing).
  projStock: false,
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
  // Audit trail is platform-level: only the SUPER admin can see it.
  CLIENT: ['dashboard', 'projects.view', 'projects.create', 'phases.view', 'schedule.view', 'updates.view',
    'stock.amounts', 'damaged.view', 'chat', 'reports', 'settings.edit', 'team.view',
    'team.create', 'team.manage', 'billing', 'docs.view', 'docs.upload', 'docs.admin',
    'attendance.view', 'attendance.session'],
  SENIOR: ['dashboard', 'projects.view', 'phases.view', 'schedule.view', 'phases.edit', 'updates.view',
    'updates.submit', 'updates.forward', 'stock.view', 'stock.amounts', 'stock.edit',
    'stock.approve', 'stock.issue', 'damaged.view', 'chat', 'reports', 'team.view', 'team.create',
    'docs.view', 'docs.upload', 'attendance.view', 'attendance.record', 'attendance.session', 'workers.manage'],
  SITE: ['dashboard', 'projects.view', 'phases.view', 'schedule.view', 'updates.view', 'updates.submit', 'chat',
    'docs.view', 'docs.upload', 'attendance.view', 'attendance.record', 'workers.manage'],
  // Stock Managers submit daily reports by default (received by the Senior
  // Engineers and the Admin through the usual submit → forward chain).
  STOCK: ['dashboard', 'stock.view', 'stock.request', 'stock.issue', 'chat', 'docs.view', 'docs.upload',
    'attendance.view', 'attendance.record', 'updates.view', 'updates.submit'],
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
  if (user.role === 'STOCK' && s.projStock) { caps.add('projects.view'); caps.add('phases.view') }
  if (user.role === 'SENIOR' && s.seniorTeamManage) caps.add('team.manage')
  // Attendance is granted per role by the admin (admins always keep it).
  // For Stock Managers the grant is FULL access: sessions (open/close),
  // recording/scanning, enrolling workers and generating cards.
  const attOff = { SENIOR: !s.attSenior, SITE: !s.attSite, STOCK: !s.attStock }
  if (attOff[user.role])
    for (const c of ['attendance.view', 'attendance.record', 'attendance.session']) caps.delete(c)
  if (user.role === 'STOCK' && s.attStock) { caps.add('attendance.session'); caps.add('workers.manage') }
  if (s.mediaDownload) caps.add('media.download')
  // Guest areas are opt-in/out individually (Settings → Guest access).
  if (user.role === 'GUEST') {
    // The master switch used to be declared but never read, so an admin who
    // turned guest access OFF still left guests with the dashboard, projects
    // and documents - they believed they had revoked access and had not.
    if (!s.guestAccess) return []
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

// Sessions are sliding 30-minute windows: every authenticated request gets a
// fresh token (see authRequired), so active users never expire - but 30
// minutes without any use forces a logout.
export const SESSION_MINUTES = 30

export function sign(user) {
  return jwt.sign({ uid: user.id }, SECRET, { expiresIn: `${SESSION_MINUTES}m` })
}

// Support mode: the Super Admin opens a company's workspace acting as its
// admin. The token carries who they really are (uid) and which client they
// act inside (actAs).
// Deliberately short-lived: this token bypasses suspension, 2FA and
// subscription gates, cannot be revoked server-side, and a leaked one is full
// admin of that tenant until it expires. Eight hours was a whole working day.
export function signImpersonation(user, client) {
  return jwt.sign({ uid: user.id, actAs: client.id }, SECRET, { expiresIn: '60m' })
}

// Short-lived token that only allows completing 2FA setup during login
// (issued when the account enforces 2FA and the user hasn't set it up yet).
export function signSetupToken(user) {
  return jwt.sign({ uid: user.id, scope: '2fa-setup' }, SECRET, { expiresIn: '15m' })
}

export function verifySetupToken(token) {
  try {
    const payload = jwt.verify(token ?? '', SECRET, JWT_OPTS)
    return payload.scope === '2fa-setup' ? payload : null
  } catch {
    return null
  }
}

// ---- Session cookie ----
// The token lives in localStorage for API calls, but <img src="/uploads/...">
// cannot send an Authorization header, so the same token is mirrored into an
// httpOnly cookie that the uploads route reads. httpOnly means script cannot
// read it back out, so this does not widen the XSS surface.
const COOKIE = 'bridge_session'
const secureCookies = (process.env.APP_URL || '').startsWith('https://')

export function setSessionCookie(res, token) {
  res.append('Set-Cookie', [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MINUTES * 60}`,
    ...(secureCookies ? ['Secure'] : []),
  ].join('; '))
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export function readCookie(req, name) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

// Resolve a token to its user without the full request gating in authRequired -
// used by the uploads route, which needs identity but not subscription locks.
export async function userFromToken(token) {
  if (!token) return null
  let payload
  try {
    payload = jwt.verify(token, SECRET, JWT_OPTS)
  } catch {
    return null
  }
  if (payload.scope) return null
  const user = await db.user.findUnique({ where: { id: payload.uid } })
  if (!user) return null
  if (sessionRevoked(user, payload)) return null
  if (payload.actAs) {
    if (user.role !== 'SUPER') return null
    return { user, clientId: payload.actAs }
  }
  if (user.role !== 'SUPER' && user.suspended) return null
  return { user, clientId: user.clientId }
}

// Tokens minted before the account's last password change are dead, so a
// stolen session cannot outlive the password it was obtained with.
function sessionRevoked(user, payload) {
  if (!user.sessionsValidFrom || !payload.iat) return false
  return payload.iat * 1000 < new Date(user.sessionsValidFrom).getTime()
}

// The cut-off to store in sessionsValidFrom. JWT `iat` has whole-second
// resolution, so this is floored to the same second - otherwise the very token
// issued alongside the change would compare as older than the cut-off and be
// rejected immediately.
export const revocationStamp = () => new Date(Math.floor(Date.now() / 1000) * 1000)

export async function authRequired(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Not authenticated' })
  let payload
  try {
    payload = jwt.verify(token, SECRET, JWT_OPTS)
  } catch {
    clearSessionCookie(res)
    return res.status(401).json({ error: 'Session expired - log in again', sessionExpired: true })
  }
  // Scoped tokens (e.g. 2FA setup) are not full sessions.
  if (payload.scope) return res.status(401).json({ error: 'Not authenticated' })
  const user = await db.user.findUnique({ where: { id: payload.uid }, include: { client: true } })
  if (!user) return res.status(401).json({ error: 'Account not found', sessionExpired: true })
  if (sessionRevoked(user, payload)) {
    clearSessionCookie(res)
    return res.status(401).json({ error: 'Your password was changed - log in again', sessionExpired: true })
  }
  // Support mode: Super Admin acting as a company's admin. Status/2FA/expiry
  // gates are skipped on purpose - support must reach locked accounts too.
  if (payload.actAs) {
    if (user.role !== 'SUPER') return res.status(401).json({ error: 'Not authenticated' })
    const client = await db.client.findUnique({ where: { id: payload.actAs } })
    if (!client) return res.status(404).json({ error: 'Company not found' })
    req.user = { ...user, role: 'CLIENT', clientId: client.id }
    req.client = client
    req.impersonating = true
    // Support sessions slide like normal ones. Without this the token was a
    // hard deadline from the moment support mode opened: it expired mid-action
    // however busy the operator was, and the client turned that into a forced
    // logout rather than a renewal.
    if (payload.iat && Date.now() / 1000 - payload.iat > 60) {
      const fresh = signImpersonation(user, client)
      res.setHeader('x-refresh-token', fresh)
      setSessionCookie(res, fresh)
    } else if (readCookie(req, COOKIE) !== token) {
      setSessionCookie(res, token)
    }
    return next()
  }
  if (user.role !== 'SUPER') {
    // accountClosed tells the web client to end the session rather than leave a
    // fully rendered UI whose every button silently fails.
    if (!user.client) return res.status(403).json({ error: 'No client account', accountClosed: true })
    if (user.suspended)
      return res.status(403).json({ error: 'Your account was suspended by your admin', accountClosed: true })
    if (['SUSPENDED', 'TERMINATED'].includes(user.client.status))
      return res.status(403).json({ error: `Account ${user.client.status.toLowerCase()} - contact support`, accountClosed: true })
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
  // Sliding renewal: hand back a fresh 30-minute token once the current one is
  // over a minute old - the web client swaps it in transparently, so the
  // session only dies after 30 minutes of NO requests at all.
  if (payload.iat && Date.now() / 1000 - payload.iat > 60) {
    const fresh = sign(user)
    res.setHeader('x-refresh-token', fresh)
    setSessionCookie(res, fresh) // keep the uploads cookie in step with the session
  } else if (readCookie(req, COOKIE) !== token) {
    // Cookie out of step with the presented token - e.g. the very first request
    // of a session, or entering/leaving support mode.
    setSessionCookie(res, token)
  }
  req.user = user
  req.client = user.client
  next()
}

// Every workspace route reads req.client. A plain Super Admin has no company of
// their own, so those routes used to blow up on `req.client.id` and return a
// bare 500 - which reads as "the app is broken" when the real answer is "open a
// company workspace first (Companies → Open as support)".
export function requireClient(req, res, next) {
  if (req.client) return next()
  if (req.user?.role === 'SUPER')
    return res.status(400).json({
      error: 'Super Admin accounts have no company workspace of their own - open one from Companies to act inside it.',
      needsWorkspace: true,
    })
  return res.status(403).json({ error: 'No client account', accountClosed: true })
}

export function requireCap(cap) {
  return (req, res, next) => {
    if (!can(req, cap)) return res.status(403).json({ error: 'No permission: ' + cap })
    next()
  }
}
