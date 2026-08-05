import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { generateSecret, verifySync, generateURI } from 'otplib'
import QRCode from 'qrcode'
import { db, audit } from '../db.js'
import { settingsOf, sign, setSessionCookie, revocationStamp } from '../auth.js'
import { uploader, removeStoredFile } from '../uploads.js'

const r = Router()

// The old filter trusted the client-declared mimetype while taking the
// extension from the filename, so "image/png" + "x.html" stored an .html file.
// The shared uploader derives the extension from an allowlist instead.
export const photoUpload = uploader({ sizeMb: 8, files: 1 })

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
// Backup codes are compared case-insensitively, ignoring dashes/spaces.
const normalizeCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '')

const logFor = (req, action, detail) => {
  if (req.client) return audit(req.client.id, req.user.name, action, detail)
}

// ---- Profile (name / email) ----

r.patch('/profile', async (req, res) => {
  const data = {}
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim()
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' })
    data.name = name
  }
  if (req.body.email !== undefined) {
    const email = String(req.body.email).trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' })
    const taken = await db.user.findUnique({ where: { email } })
    if (taken && taken.id !== req.user.id) return res.status(409).json({ error: 'That email is already in use' })
    data.email = email
  }
  if (req.body.language !== undefined) {
    const language = String(req.body.language)
    if (!['en', 'fr', 'rw'].includes(language)) return res.status(400).json({ error: 'Unsupported language' })
    data.language = language
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to change' })
  const user = await db.user.update({ where: { id: req.user.id }, data })
  await logFor(req, 'account.profile', `${req.user.email} updated their profile`)
  res.json({ name: user.name, email: user.email, language: user.language })
})

// ---- Profile photo (optional - initials avatar otherwise) ----

r.post('/photo', photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pick an image file' })
  const previous = req.user.photo
  await db.user.update({ where: { id: req.user.id }, data: { photo: req.file.filename } })
  removeStoredFile(previous) // the replaced photo is no longer referenced
  await logFor(req, 'account.photo', `${req.user.name} updated their photo`)
  res.json({ photo: '/uploads/' + req.file.filename })
})

r.delete('/photo', async (req, res) => {
  await db.user.update({ where: { id: req.user.id }, data: { photo: null } })
  removeStoredFile(req.user.photo)
  await logFor(req, 'account.photo', `${req.user.name} removed their photo`)
  res.json({ photo: null })
})

// ---- Password ----

r.post('/password', async (req, res) => {
  const { current, next } = req.body
  if (!(await bcrypt.compare(current ?? '', req.user.passwordHash)))
    return res.status(401).json({ error: 'Current password is wrong' })
  if (!next || next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' })
  const user = await db.user.update({
    where: { id: req.user.id },
    // Every session issued before this instant stops working, so changing the
    // password actually evicts anyone holding a stolen token.
    data: { passwordHash: await bcrypt.hash(next, 10), sessionsValidFrom: revocationStamp() },
  })
  await logFor(req, 'account.password', `${req.user.name} changed their password`)
  // ...including this one, so hand the caller a replacement rather than logging
  // them out of the tab they just changed their password in.
  const token = sign(user)
  setSessionCookie(res, token)
  res.setHeader('x-refresh-token', token)
  res.json({ ok: true, token })
})

// ---- Two-factor authentication (TOTP) ----
// The two steps below are shared with the login-time forced setup flow
// (routes/auth.js) used when an account enforces 2FA for all its users.

// Step 1: generate a secret + QR code. 2FA is NOT active until verified.
export async function beginTotpSetup(user) {
  const secret = generateSecret()
  await db.user.update({ where: { id: user.id }, data: { totpSecret: secret, totpEnabled: false } })
  const otpauth = generateURI({ issuer: 'CMS', label: user.email, secret })
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 })
  return { qr, secret, otpauth }
}

// Step 2: verify a code from the authenticator app → activate + issue backup codes.
export async function activateTotp(user, rawCode) {
  if (!user.totpSecret) return { error: 'Run setup first' }
  const code = String(rawCode ?? '').trim()
  let valid = false
  if (/^\d{6}$/.test(code)) {
    try { valid = verifySync({ token: code, secret: user.totpSecret }).valid } catch { valid = false }
  }
  if (!valid)
    return { error: 'That code is not valid - check your authenticator app and try again' }
  // 8 one-time backup codes, shown to the user exactly once.
  const plain = Array.from({ length: 8 }, () => {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase()
    return `${raw.slice(0, 4)}-${raw.slice(4)}`
  })
  await db.user.update({
    where: { id: user.id },
    data: { totpEnabled: true, backupCodes: plain.map((c) => sha256(normalizeCode(c))) },
  })
  if (user.clientId) await audit(user.clientId, user.name, 'account.2fa.enabled', user.name)
  return { backupCodes: plain }
}

r.post('/2fa/setup', async (req, res) => {
  res.json(await beginTotpSetup(req.user))
})

r.post('/2fa/enable', async (req, res) => {
  const result = await activateTotp(req.user, req.body.code)
  if (result.error) return res.status(400).json({ error: result.error })
  res.json({ ok: true, backupCodes: result.backupCodes })
})

// Disable requires the account password.
r.post('/2fa/disable', async (req, res) => {
  if (req.client && settingsOf(req.client).twoFA)
    return res.status(403).json({ error: 'Two-factor authentication is required for all users in this account - it can only be turned off in the account Settings' })
  if (!(await bcrypt.compare(req.body.password ?? '', req.user.passwordHash)))
    return res.status(401).json({ error: 'Password is wrong' })
  await db.user.update({
    where: { id: req.user.id },
    data: { totpEnabled: false, totpSecret: null, backupCodes: null },
  })
  await logFor(req, 'account.2fa.disabled', req.user.name)
  res.json({ ok: true })
})

export default r
export { sha256, normalizeCode }
