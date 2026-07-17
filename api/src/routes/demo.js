import { Router } from 'express'
import { db } from '../db.js'
import { sendMail, APP_URL } from '../mail.js'

const r = Router()

// Bookable slots: Mon–Sat, CAT (UTC+2)
export const SLOT_HOURS = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00']

function slotDate(day, hour) {
  return new Date(`${day}T${hour}:00+02:00`)
}

// Which slots are already taken for a given day (public - no personal data returned)
r.get('/slots', async (req, res) => {
  const day = req.query.day
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return res.status(400).json({ error: 'Bad day' })
  const start = slotDate(day, '00:00')
  const end = new Date(start.getTime() + 24 * 3600 * 1000)
  const taken = await db.demoBooking.findMany({
    where: { slot: { gte: start, lt: end } },
    select: { slot: true },
  })
  res.json(taken.map((t) => t.slot.toISOString()))
})

r.post('/', async (req, res) => {
  const { day, time, name, email, company, phone, teamSize, interests } = req.body
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !SLOT_HOURS.includes(time))
    return res.status(400).json({ error: 'Pick a date and time slot' })
  const slot = slotDate(day, time)
  if (slot.getTime() < Date.now()) return res.status(400).json({ error: 'That slot is in the past - pick a later one' })
  if (slot.getDay() === 0) return res.status(400).json({ error: 'We take Sundays off - pick Monday to Saturday' })
  try {
    const booking = await db.demoBooking.create({
      data: {
        slot, name, email,
        company: company || null, phone: phone || null, teamSize: teamSize || null,
        interests: interests ?? [],
      },
    })
    // Email the platform operators alongside the in-app popup notification.
    const supers = await db.user.findMany({ where: { role: 'SUPER' } })
    sendMail(supers.map(s => s.email), `New demo booking: ${name}${company ? ` (${company})` : ''}`, {
      title: 'New demo booked 🔔',
      lines: [
        `<b>${name}</b>${company ? ` from <b>${company}</b>` : ''} booked a demo for <b>${slot.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kigali' })}</b> (CAT).`,
        `Contact: ${email}${phone ? ` · ${phone}` : ''}${teamSize ? ` · team size ${teamSize}` : ''}`,
        (interests ?? []).length ? `Wants to see: ${interests.join(', ')}` : '',
      ].filter(Boolean),
      buttonText: 'Open the Demos tab',
      buttonUrl: `${APP_URL}/#/admin/demos`,
    })
    res.json({ id: booking.id, slot: booking.slot })
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Sorry - that slot was just taken. Pick another time.' })
    throw e
  }
})

export default r
