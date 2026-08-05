import { Router } from 'express'
import crypto from 'node:crypto'
import { db, audit } from '../db.js'
import { requireCap } from '../auth.js'
import { PLANS, MOMO, subscriptionOf } from '../plans.js'
import { sendMail, APP_URL } from '../mail.js'

const r = Router()
r.use(requireCap('billing'))

const shape = (p) => ({
  id: p.id, plan: p.plan, months: p.months, amount: p.amount, currency: p.currency,
  reference: p.reference, method: p.method, payerPhone: p.payerPhone, status: p.status,
  submittedAt: p.submittedAt, confirmedAt: p.confirmedAt, note: p.note, createdAt: p.createdAt,
})

// Subscription overview: current state, plans, payment instructions, history.
r.get('/', async (req, res) => {
  const payments = await db.payment.findMany({
    where: { clientId: req.client.id },
    orderBy: { createdAt: 'desc' },
    take: 24,
  })
  res.json({
    subscription: subscriptionOf(req.client),
    plans: PLANS,
    momo: MOMO,
    pending: payments.filter((p) => p.status === 'PENDING').map(shape)[0] ?? null,
    payments: payments.map(shape),
  })
})

// Start a checkout: creates (or reuses) the one open payment intent.
r.post('/checkout', async (req, res) => {
  const planKey = String(req.body.plan ?? '')
  const plan = PLANS[planKey]
  if (!plan || plan.price == null)
    return res.status(400).json({ error: planKey === 'ENTERPRISE' ? 'Enterprise is arranged directly - contact support' : 'Pick a valid plan' })
  const months = Math.min(12, Math.max(1, parseInt(req.body.months) || 1))

  const open = await db.payment.findFirst({ where: { clientId: req.client.id, status: 'PENDING' } })
  if (open) {
    if (open.plan === planKey && open.months === months) return res.json(shape(open))
    // plan or duration changed - retire the old intent
    await db.payment.update({ where: { id: open.id }, data: { status: 'CANCELED' } })
  }

  let payment = null
  let lastError = null
  for (let i = 0; i < 5 && !payment; i++) {
    const reference = 'BR-' + crypto.randomBytes(3).toString('hex').toUpperCase()
    try {
      payment = await db.payment.create({
        data: { clientId: req.client.id, plan: planKey, months, amount: plan.price * months, reference },
      })
    } catch (e) {
      // Only a reference collision is worth retrying. The bare catch used to
      // swallow real failures (database down, constraint violation) and burn
      // all five attempts before reporting a generic error.
      lastError = e
      if (e?.code !== 'P2002') break
    }
  }
  if (!payment) {
    if (lastError && lastError.code !== 'P2002') throw lastError
    return res.status(500).json({ error: 'Could not create the payment - try again' })
  }

  // Two checkouts submitted at once can each pass the findFirst above and both
  // create an intent. Keep the newest and retire any other open one, so the
  // client is never shown two references to pay against.
  const strays = await db.payment.findMany({
    where: { clientId: req.client.id, status: 'PENDING', NOT: { id: payment.id } },
    select: { id: true },
  })
  if (strays.length) {
    await db.payment.updateMany({
      where: { id: { in: strays.map(s => s.id) } },
      data: { status: 'CANCELED', note: 'superseded by a newer checkout' },
    })
  }
  await audit(req.client.id, req.user.name, 'billing.checkout', `${planKey} × ${months} month(s) · ${payment.amount} RWF · ${payment.reference}`)
  res.json(shape(payment))
})

// "I've sent the money" - records the payer number for the confirmation queue.
r.post('/payments/:id/submit', async (req, res) => {
  const payment = await db.payment.findFirst({
    where: { id: +req.params.id, clientId: req.client.id, status: 'PENDING' },
  })
  if (!payment) return res.status(404).json({ error: 'Payment not found' })
  const phone = String(req.body.payerPhone ?? '').trim()
  if (!/^\+?\d[\d ]{6,15}$/.test(phone))
    return res.status(400).json({ error: 'Enter the MoMo number you paid from (e.g. 078xxxxxxx)' })
  const updated = await db.payment.update({
    where: { id: payment.id },
    data: { payerPhone: phone, submittedAt: new Date() },
  })
  await audit(req.client.id, req.user.name, 'billing.submitted', `${payment.reference} paid from ${phone}`)
  // Ping the platform operators: a payment is waiting to be matched & confirmed.
  const supers = await db.user.findMany({ where: { role: 'SUPER' } })
  sendMail(supers.map(s => s.email), `Payment to confirm: ${payment.reference} · ${req.client.company}`, {
    title: 'Payment waiting for confirmation',
    lines: [
      `<b>${req.client.company}</b> reports having paid <b>${payment.amount.toLocaleString()} ${payment.currency}</b> for <b>${payment.plan} × ${payment.months} month${payment.months === 1 ? '' : 's'}</b>.`,
      `Reference: <b>${payment.reference}</b> · paid from <b>${phone}</b>.`,
      'Match it against the MoMo statement and confirm or reject it in the Payments tab.',
    ],
    buttonText: 'Open the payment queue',
    buttonUrl: `${APP_URL}/#/admin/payments`,
  })
  res.json(shape(updated))
})

r.post('/payments/:id/cancel', async (req, res) => {
  const payment = await db.payment.findFirst({
    where: { id: +req.params.id, clientId: req.client.id, status: 'PENDING' },
  })
  if (!payment) return res.status(404).json({ error: 'Payment not found' })
  await db.payment.update({ where: { id: payment.id }, data: { status: 'CANCELED' } })
  await audit(req.client.id, req.user.name, 'billing.canceled', payment.reference)
  res.json({ ok: true })
})

export default r
