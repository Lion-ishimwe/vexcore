import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { db, audit } from '../db.js'
import { requireCap } from '../auth.js'
import { planLimits } from '../plans.js'
import { sendMail, mailConfigured, APP_URL } from '../mail.js'

const r = Router()

// Who each role is allowed to create (PRD §3).
const CAN_CREATE = { CLIENT: ['SENIOR', 'SITE', 'STOCK', 'GUEST'], SENIOR: ['SITE', 'STOCK'], SUPER: ['CLIENT', 'SENIOR', 'SITE', 'STOCK', 'GUEST'] }

r.get('/', requireCap('team.view'), async (req, res) => {
  const users = await db.user.findMany({
    where: { clientId: req.client.id },
    select: { id: true, name: true, email: true, role: true, createdAt: true, totpEnabled: true, photo: true },
    orderBy: { id: 'asc' },
  })
  res.json(users.map(u => ({ ...u, photo: u.photo ? '/uploads/' + u.photo : null })))
})

r.post('/', requireCap('team.create'), async (req, res) => {
  const { name, email, password, role } = req.body
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'Name, email, password and role are required' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  const allowed = CAN_CREATE[req.user.role] ?? []
  if (!allowed.includes(role))
    return res.status(403).json({ error: `A ${req.user.role.toLowerCase()} account cannot create ${role} users` })
  // Plan limit: which team roles the subscription includes
  const limits = planLimits(req.client)
  if (req.user.role !== 'SUPER' && !limits.roles.includes(role))
    return res.status(403).json({
      error: `The ${limits.name} plan does not include ${role === 'SITE' ? 'Site Engineer' : role === 'STOCK' ? 'Stock Manager' : role} accounts - upgrade to Pro in Billing`,
      planLimit: true,
    })
  if (await db.user.findUnique({ where: { email } }))
    return res.status(409).json({ error: 'An account with this email already exists' })
  const user = await db.user.create({
    data: { clientId: req.client.id, name, email, passwordHash: await bcrypt.hash(password, 10), role },
  })
  await audit(req.client.id, req.user.name, 'team.created', `${role}: ${name} (${email})`)
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role })
})

// Owners can reset anyone; other roles only those they could have created.
async function resetTarget(req, res) {
  const target = await db.user.findUnique({ where: { id: Number(req.params.id) } })
  if (!target || target.clientId !== req.client.id) {
    res.status(404).json({ error: 'Team member not found' })
    return null
  }
  if (target.id === req.user.id) {
    res.status(400).json({ error: 'Use My Account to change your own password' })
    return null
  }
  const allowed = req.user.role === 'CLIENT' || (CAN_CREATE[req.user.role] ?? []).includes(target.role)
  if (!allowed) {
    res.status(403).json({ error: `A ${req.user.role.toLowerCase()} account cannot reset a ${target.role.toLowerCase()}'s password` })
    return null
  }
  return target
}

// Generate a one-hour password-reset link for a team member; with
// { sendEmail: true } the invitation is also emailed to them directly.
r.post('/:id/reset-link', requireCap('team.create'), async (req, res) => {
  const target = await resetTarget(req, res)
  if (!target) return
  const token = crypto.randomBytes(24).toString('hex')
  await db.resetToken.create({
    data: { userId: target.id, token, expiresAt: new Date(Date.now() + 3600 * 1000) },
  })
  let emailed = false
  if (req.body?.sendEmail && mailConfigured) {
    sendMail(target.email, 'Reset your Bridge password', {
      title: 'Reset your password',
      lines: [
        `Hi ${target.name},`,
        `${req.user.name} (${req.client.company}) sent you this link to reset your Bridge password. It works for 1 hour.`,
      ],
      buttonText: 'Choose a new password',
      buttonUrl: `${APP_URL}/#/login?reset=${token}`,
    })
    emailed = true
  }
  await audit(req.client.id, req.user.name, 'team.reset_link', `for ${target.email}${emailed ? ' (emailed)' : ''}`)
  res.json({ token, emailed })
})

// Set a team member's password directly - no invitation, effective immediately.
r.post('/:id/password', requireCap('team.create'), async (req, res) => {
  const target = await resetTarget(req, res)
  if (!target) return
  const password = String(req.body.password ?? '')
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  await db.user.update({ where: { id: target.id }, data: { passwordHash: await bcrypt.hash(password, 10) } })
  await db.resetToken.deleteMany({ where: { userId: target.id } }) // outstanding links die with the old password
  await audit(req.client.id, req.user.name, 'team.password_set', `for ${target.email}`)
  res.json({ ok: true })
})

export default r
