import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { db, audit } from '../db.js'
import { requireCap } from '../auth.js'
import { planLimits } from '../plans.js'

const r = Router()

// Who each role is allowed to create (PRD §3).
const CAN_CREATE = { CLIENT: ['SENIOR', 'SITE', 'STOCK', 'GUEST'], SENIOR: ['SITE', 'STOCK'], SUPER: ['CLIENT', 'SENIOR', 'SITE', 'STOCK', 'GUEST'] }

r.get('/', requireCap('team.view'), async (req, res) => {
  const users = await db.user.findMany({
    where: { clientId: req.client.id },
    select: { id: true, name: true, email: true, role: true, createdAt: true, totpEnabled: true },
    orderBy: { id: 'asc' },
  })
  res.json(users)
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

// Generate a one-hour password-reset link for a team member (no mailer in dev,
// so the admin copies the link and shares it directly).
r.post('/:id/reset-link', requireCap('team.create'), async (req, res) => {
  const target = await db.user.findUnique({ where: { id: Number(req.params.id) } })
  if (!target || target.clientId !== req.client.id)
    return res.status(404).json({ error: 'Team member not found' })
  if (target.id === req.user.id)
    return res.status(400).json({ error: 'Use My Account to change your own password' })
  // Owners can reset anyone; other roles only those they could have created.
  const allowed = req.user.role === 'CLIENT' || (CAN_CREATE[req.user.role] ?? []).includes(target.role)
  if (!allowed)
    return res.status(403).json({ error: `A ${req.user.role.toLowerCase()} account cannot reset a ${target.role.toLowerCase()}'s password` })
  const token = crypto.randomBytes(24).toString('hex')
  await db.resetToken.create({
    data: { userId: target.id, token, expiresAt: new Date(Date.now() + 3600 * 1000) },
  })
  await audit(req.client.id, req.user.name, 'team.reset_link', `for ${target.email}`)
  res.json({ token })
})

export default r
