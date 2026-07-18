import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { db, audit } from '../db.js'
import { requireCap } from '../auth.js'
import { planLimits } from '../plans.js'
import { sendMail, mailConfigured, APP_URL } from '../mail.js'
import { genCardId } from '../cards.js'

const r = Router()

// Who each role is allowed to create (PRD §3).
const CAN_CREATE = { CLIENT: ['SENIOR', 'SITE', 'STOCK', 'GUEST'], SENIOR: ['SITE', 'STOCK'], SUPER: ['CLIENT', 'SENIOR', 'SITE', 'STOCK', 'GUEST'] }

r.get('/', requireCap('team.view'), async (req, res) => {
  const users = await db.user.findMany({
    where: { clientId: req.client.id },
    select: { id: true, name: true, email: true, role: true, createdAt: true, totpEnabled: true, photo: true, cardId: true, suspended: true },
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
    data: {
      clientId: req.client.id, name, email, passwordHash: await bcrypt.hash(password, 10), role,
      // Every team member gets a QR badge automatically, like workers do -
      // scanned when stock is issued to them.
      cardId: await genCardId(req.client.id),
    },
  })
  await audit(req.client.id, req.user.name, 'team.created', `${role}: ${name} (${email}) · card ${user.cardId}`)
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, cardId: user.cardId })
})

// ---- Member lifecycle: suspend / activate / delete ----
// Admins always may (never on themselves); Senior Engineers only when the
// admin granted it (Settings › Access control) and only for roles they can
// create (Site Engineers, Stock Managers).
async function manageTarget(req, res) {
  const target = await db.user.findUnique({ where: { id: Number(req.params.id) } })
  if (!target || target.clientId !== req.client.id) {
    res.status(404).json({ error: 'Team member not found' })
    return null
  }
  if (target.id === req.user.id) {
    res.status(400).json({ error: 'You cannot suspend or delete your own account' })
    return null
  }
  const allowed = req.user.role === 'CLIENT'
    || (CAN_CREATE[req.user.role] ?? []).includes(target.role)
  if (!allowed) {
    res.status(403).json({ error: `A ${req.user.role.toLowerCase()} account cannot manage a ${target.role.toLowerCase()}` })
    return null
  }
  return target
}

r.patch('/:id', requireCap('team.manage'), async (req, res) => {
  const target = await manageTarget(req, res)
  if (!target) return
  if (typeof req.body.suspended !== 'boolean') return res.status(400).json({ error: 'Nothing to change' })
  await db.user.update({ where: { id: target.id }, data: { suspended: req.body.suspended } })
  await audit(req.client.id, req.user.name,
    req.body.suspended ? 'team.suspended' : 'team.activated', `${target.name} (${target.email})`)
  res.json({ ok: true, suspended: req.body.suspended })
})

// Deleting is only allowed for members with no activity yet - otherwise the
// history (reports, messages, attendance…) would lose its author. Suspend instead.
r.delete('/:id', requireCap('team.manage'), async (req, res) => {
  const target = await manageTarget(req, res)
  if (!target) return
  const [updates, messages, issued, received, attendance, documents, phases, transfers] = await Promise.all([
    db.dailyUpdate.count({ where: { userId: target.id } }),
    db.message.count({ where: { OR: [{ userId: target.id }, { recipientId: target.id }] } }),
    db.stockIssue.count({ where: { issuedById: target.id } }),
    db.stockIssue.count({ where: { userId: target.id } }),
    db.attendanceRecord.count({ where: { userId: target.id } }),
    db.document.count({ where: { uploaderId: target.id } }),
    db.phase.count({ where: { assigneeId: target.id } }),
    db.stockTransfer.count({ where: { requestedById: target.id } }),
  ])
  const activity = updates + messages + issued + received + attendance + documents + phases + transfers
  if (activity > 0)
    return res.status(400).json({
      error: `${target.name} has recorded activity (reports, messages, attendance…) - suspend the account instead so the history keeps its author`,
    })
  await db.$transaction([
    db.projectMember.deleteMany({ where: { userId: target.id } }),
    db.resetToken.deleteMany({ where: { userId: target.id } }),
    db.stockRequest.deleteMany({ where: { requestedById: target.id } }),
    db.cardIssue.deleteMany({ where: { userId: target.id } }),
    db.stockStore.updateMany({ where: { managerId: target.id }, data: { managerId: null } }),
    db.user.delete({ where: { id: target.id } }),
  ])
  await audit(req.client.id, req.user.name, 'team.deleted', `${target.name} (${target.email})`)
  res.json({ ok: true })
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
