import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { verifySync } from 'otplib'
import { db, audit } from '../db.js'
import { sign, authRequired, capsFor, settingsOf, signSetupToken, verifySetupToken, signImpersonation } from '../auth.js'
import { subscriptionOf } from '../plans.js'
import { sha256, normalizeCode, beginTotpSetup, activateTotp } from './account.js'

const r = Router()

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, clientId: u.clientId,
    totpEnabled: !!u.totpEnabled, language: u.language ?? 'en',
  }
}

function sessionPayload(user, client) {
  return {
    token: sign(user),
    user: publicUser(user),
    client: client ? {
      id: client.id, company: client.company, currency: client.currency, tin: client.tin,
      location: client.location, country: client.country,
      status: client.status, trialEndsAt: client.trialEndsAt, settings: settingsOf(client),
    } : null,
    subscription: subscriptionOf(client),
    caps: capsFor(user, client),
  }
}

// Client sign-up: creates company account + owner user, starts 14-day trial.
r.post('/signup', async (req, res) => {
  const { company, name, email, password, contact, country, location, tin, currency } = req.body
  if (!company || !email || !password || !contact || !country || !location)
    return res.status(400).json({ error: 'Company, email, password, contact number, country and location are required' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  const existing = await db.user.findUnique({ where: { email } })
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' })

  const client = await db.client.create({
    data: {
      company, contact, country, location, tin: tin || null,
      currency: currency || 'RWF',
      status: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
    },
  })
  const user = await db.user.create({
    data: {
      clientId: client.id, name: name || company, email,
      passwordHash: await bcrypt.hash(password, 10), role: 'CLIENT',
    },
  })
  await audit(client.id, user.name, 'account.created', `${company} signed up (trial)`)
  res.json(sessionPayload(user, client))
})

r.post('/login', async (req, res) => {
  const { email, password } = req.body
  const user = await db.user.findUnique({ where: { email: email ?? '' }, include: { client: true } })
  if (!user || !(await bcrypt.compare(password ?? '', user.passwordHash)))
    return res.status(401).json({ error: 'Wrong email or password' })
  if (user.role !== 'SUPER' && ['SUSPENDED', 'TERMINATED'].includes(user.client?.status))
    return res.status(403).json({ error: `Account ${user.client.status.toLowerCase()} - contact support` })

  // Account-wide 2FA enforcement: the password checked out, but this account
  // requires 2FA and the user hasn't set it up yet. Hand back a short-lived
  // setup token so the login screen can walk them through QR + backup codes.
  if (user.role !== 'SUPER' && user.client && settingsOf(user.client).twoFA && !user.totpEnabled)
    return res.status(401).json({
      error: 'Your account requires two-factor authentication - set it up to continue',
      need2faSetup: true,
      setupToken: signSetupToken(user),
    })

  // Second factor: a TOTP code from the authenticator app, or a one-time backup code.
  if (user.totpEnabled) {
    const code = String(req.body.totp ?? '').trim()
    if (!code) return res.status(401).json({ error: 'Enter your two-factor code', need2fa: true })
    // otplib throws on tokens that aren't 6 digits, so guard before verifying
    let okTotp = false
    if (/^\d{6}$/.test(code)) {
      try { okTotp = verifySync({ token: code, secret: user.totpSecret }).valid } catch { okTotp = false }
    }
    if (!okTotp) {
      const codes = Array.isArray(user.backupCodes) ? [...user.backupCodes] : []
      const idx = codes.indexOf(sha256(normalizeCode(code)))
      if (idx === -1) return res.status(401).json({ error: 'Invalid two-factor code', need2fa: true })
      codes.splice(idx, 1) // backup codes are single-use
      await db.user.update({ where: { id: user.id }, data: { backupCodes: codes } })
      if (user.clientId) await audit(user.clientId, user.name, 'account.2fa.backup_used', `${codes.length} backup codes left`)
    }
  }

  res.json(sessionPayload(user, user.client))
})

// ---- Forced 2FA setup during login ----
// Used when the account enforces 2FA for all users. The setup token issued by
// /login is the only credential; it expires after 15 minutes and grants
// nothing beyond these two endpoints.

async function userFromSetupToken(req, res) {
  const payload = verifySetupToken(req.body.setupToken)
  if (!payload) {
    res.status(401).json({ error: 'Setup session expired - log in again' })
    return null
  }
  const user = await db.user.findUnique({ where: { id: payload.uid }, include: { client: true } })
  if (!user) {
    res.status(401).json({ error: 'Account not found' })
    return null
  }
  if (user.role !== 'SUPER' && ['SUSPENDED', 'TERMINATED'].includes(user.client?.status)) {
    res.status(403).json({ error: `Account ${user.client.status.toLowerCase()} - contact support` })
    return null
  }
  return user
}

r.post('/2fa/setup', async (req, res) => {
  const user = await userFromSetupToken(req, res)
  if (!user) return
  res.json(await beginTotpSetup(user))
})

r.post('/2fa/enable', async (req, res) => {
  const user = await userFromSetupToken(req, res)
  if (!user) return
  const result = await activateTotp(user, req.body.code)
  if (result.error) return res.status(400).json({ error: result.error })
  // 2FA is now active - log the user straight in with a full session.
  const fresh = await db.user.findUnique({ where: { id: user.id }, include: { client: true } })
  res.json({ backupCodes: result.backupCodes, session: sessionPayload(fresh, fresh.client) })
})

r.get('/me', authRequired, (req, res) => {
  const s = sessionPayload(req.user, req.client)
  if (req.impersonating) {
    s.token = null // never hand out a plain super token from a support session
    s.impersonating = { clientId: req.client.id, company: req.client.company }
  }
  res.json(s)
})

// Support mode: Super Admin opens a company's workspace as its admin.
r.post('/impersonate/:clientId', authRequired, async (req, res) => {
  if (req.user.role !== 'SUPER' || req.impersonating)
    return res.status(403).json({ error: 'Super Admin only' })
  const client = await db.client.findUnique({ where: { id: +req.params.clientId } })
  if (!client) return res.status(404).json({ error: 'Company not found' })
  await audit(client.id, req.user.name, 'admin.support', 'Super Admin opened the workspace (support mode)')
  res.json({ token: signImpersonation(req.user, client), company: client.company })
})

// Forgot password. No mailer configured in dev, so the reset token is returned
// directly; in production this would be emailed instead.
r.post('/forgot', async (req, res) => {
  const user = await db.user.findUnique({ where: { email: req.body.email ?? '' } })
  if (!user) return res.json({ ok: true }) // do not reveal which emails exist
  const token = crypto.randomBytes(24).toString('hex')
  await db.resetToken.create({
    data: { userId: user.id, token, expiresAt: new Date(Date.now() + 3600 * 1000) },
  })
  res.json({ ok: true, devToken: token })
})

r.post('/reset', async (req, res) => {
  const { token, password } = req.body
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  const rt = await db.resetToken.findUnique({ where: { token: token ?? '' } })
  if (!rt || rt.expiresAt < new Date()) return res.status(400).json({ error: 'Invalid or expired reset link' })
  await db.user.update({ where: { id: rt.userId }, data: { passwordHash: await bcrypt.hash(password, 10) } })
  await db.resetToken.deleteMany({ where: { userId: rt.userId } })
  res.json({ ok: true })
})

export default r
