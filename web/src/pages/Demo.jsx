import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PartyPopper, CalendarPlus, CalendarCheck } from 'lucide-react'
import { api } from '../api.js'
import { PubNav, PubFoot } from './GetStarted.jsx'
import { Field, ErrorNote, useForm } from '../ui.jsx'

const SLOT_HOURS = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00']
const INTERESTS = ['Daily site updates', 'Phases & costs', 'Stock & inventory', 'Reports for banks', 'Team & permissions', 'Pricing']

const AGENDA = [
  { t: '0–5 min', title: 'A day on site', text: 'Watch a site engineer log workers and photos in under two minutes.' },
  { t: '5–10 min', title: 'Where the money goes', text: 'Phase budgets, labor and materials - and the variance the client sees.' },
  { t: '10–15 min', title: 'Stock without surprises', text: 'Requests, approvals, low-stock alerts, and what each role can see.' },
  { t: '15–20 min', title: 'Your project, your questions', text: 'Bring a live project - we set it up together on the call.' },
]

function pad(n) { return String(n).padStart(2, '0') }
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

function nextDays(count) {
  const out = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    out.push(d)
  }
  return out
}

function icsFor(booking, form) {
  const start = new Date(booking.slot)
  const end = new Date(start.getTime() + 30 * 60000)
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bridge Construction//Demo//EN',
    'BEGIN:VEVENT',
    `UID:bridge-demo-${booking.id}@bridge.app`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    'SUMMARY:Bridge Construction - Live Demo',
    `DESCRIPTION:One-on-one walkthrough for ${form.name}${form.company ? ' (' + form.company + ')' : ''}. We will call you on ${form.phone || form.email}.`,
    'LOCATION:Video call / WhatsApp',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }))
  const a = document.createElement('a')
  a.href = url; a.download = 'bridge-demo.ics'; a.click()
  URL.revokeObjectURL(url)
}

export default function Demo() {
  const days = useMemo(() => nextDays(14), [])
  const [day, setDay] = useState(null)      // 'YYYY-MM-DD'
  const [time, setTime] = useState(null)    // 'HH:MM'
  const [taken, setTaken] = useState([])
  const [step, setStep] = useState(1)
  const [v, set] = useForm({ name: '', email: '', company: '', phone: '', teamSize: '' })
  const [interests, setInterests] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [booking, setBooking] = useState(null)

  useEffect(() => {
    if (!day) return
    setTaken([])
    api(`/demo/slots?day=${day}`).then(setTaken).catch(() => setTaken([]))
  }, [day])

  const isTaken = (hour) => {
    const iso = new Date(`${day}T${hour}:00+02:00`).toISOString()
    return taken.includes(iso)
  }
  const isPast = (hour) => new Date(`${day}T${hour}:00+02:00`).getTime() < Date.now()

  const pickDay = (d) => {
    if (d.getDay() === 0) return
    setDay(dayKey(d)); setTime(null); setStep(2)
  }

  const toggleInterest = (i) =>
    setInterests((cur) => cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const b = await api('/demo', { method: 'POST', body: { day, time, ...v, interests } })
      setBooking(b); setStep(4)
    } catch (err) {
      setError(err.message)
      if (err.message.includes('taken')) { setTime(null); setStep(2); api(`/demo/slots?day=${day}`).then(setTaken) }
    } finally { setBusy(false) }
  }

  const monthLabel = days[0].toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) +
    (days[13].getMonth() !== days[0].getMonth() ? ' – ' + days[13].toLocaleDateString('en-GB', { month: 'long' }) : '')

  const prettySlot = day && time &&
    new Date(`${day}T${time}:00+02:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ` · ${time} (CAT)`

  return (
    <div className="public mk">
      <PubNav />

      <div className="demo-wrap">
        <div className="demo-copy">
          <span className="mk-eyebrow">Book a demo</span>
          <h1>20 minutes. Your project.<br />No slides.</h1>
          <p className="mk-sub">
            One-on-one with someone who has stood on a site, not a sales script.
            In Kinyarwanda, English, or French - on a video call or WhatsApp.
          </p>

          <div className="demo-agenda">
            {AGENDA.map((a, i) => (
              <div className="demo-step" key={i}>
                <div className="demo-step-dot"><span /></div>
                <div>
                  <div className="demo-step-t">{a.t}</div>
                  <div className="demo-step-title">{a.title}</div>
                  <div className="demo-step-text">{a.text}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="demo-alt">
            Prefer to talk now? <a href="tel:+250788000000">+250 788 000 000</a> ·{' '}
            <a href="mailto:demo@bridge.app">demo@bridge.app</a>
          </div>
        </div>

        <div className="demo-card">
          <div className="demo-progress">
            {['Date', 'Time', 'Details'].map((label, i) => (
              <div key={label} className={`demo-prog-item ${step > i ? 'done' : ''} ${step === i + 1 ? 'now' : ''}`}>
                <b>{step > i + 1 ? '✓' : i + 1}</b> {label}
              </div>
            ))}
          </div>

          {step === 4 ? (
            <div className="demo-done">
              <div className="demo-done-icon"><PartyPopper size={40} color="var(--accent-dark)" /></div>
              <h3>You're booked, {v.name.split(' ')[0]}!</h3>
              <p className="demo-done-slot">{prettySlot}</p>
              <p className="small muted">
                We'll reach you on {v.phone || v.email}. Bring a real project if you can -
                we'll set it up live on the call.
              </p>
              <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 16 }}
                onClick={() => icsFor(booking, v)}>
                <CalendarPlus size={14} /> Add to calendar (.ics)
              </button>
              <Link to="/" className="btn ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>
                Back to home
              </Link>
            </div>
          ) : (
            <>
              <div className="demo-month">{monthLabel} <span className="muted small">· Kigali time (CAT)</span></div>
              <div className="demo-days">
                {days.map((d) => {
                  const key = dayKey(d)
                  const off = d.getDay() === 0
                  return (
                    <button key={key} disabled={off}
                      className={`demo-day ${day === key ? 'sel' : ''} ${off ? 'off' : ''}`}
                      onClick={() => pickDay(d)}>
                      <span>{d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                      <b>{d.getDate()}</b>
                    </button>
                  )
                })}
              </div>

              {step >= 2 && (
                <>
                  <div className="demo-label">Available times</div>
                  <div className="demo-slots">
                    {SLOT_HOURS.map((h) => {
                      const gone = isTaken(h) || isPast(h)
                      return (
                        <button key={h} disabled={gone}
                          className={`demo-slot ${time === h ? 'sel' : ''} ${gone ? 'gone' : ''}`}
                          onClick={() => { setTime(h); setStep(3) }}>
                          {h}{gone && <em>{isPast(h) ? 'past' : 'taken'}</em>}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              {step >= 3 && (
                <form onSubmit={submit} className="demo-form">
                  <div className="demo-picked"><CalendarCheck size={13} /> {prettySlot}</div>
                  <ErrorNote error={error} />
                  <div className="grid grid-2" style={{ gap: 0, columnGap: 10 }}>
                    <Field label="Your name *"><input value={v.name} onChange={set('name')} required /></Field>
                    <Field label="Company"><input value={v.company} onChange={set('company')} /></Field>
                    <Field label="Email *"><input type="email" value={v.email} onChange={set('email')} required /></Field>
                    <Field label="Phone / WhatsApp"><input value={v.phone} onChange={set('phone')} placeholder="+250 …" /></Field>
                  </div>
                  <Field label="Team size">
                    <select value={v.teamSize} onChange={set('teamSize')}>
                      <option value="">- Select -</option>
                      <option>Just me</option><option>2–5</option><option>6–20</option><option>20+</option>
                    </select>
                  </Field>
                  <div className="demo-label">What should we focus on?</div>
                  <div className="demo-chips">
                    {INTERESTS.map((i) => (
                      <button type="button" key={i}
                        className={`demo-chip ${interests.includes(i) ? 'sel' : ''}`}
                        onClick={() => toggleInterest(i)}>
                        {i}
                      </button>
                    ))}
                  </div>
                  <button className="btn big" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
                    {busy ? 'Booking…' : 'Confirm my demo'}
                  </button>
                  <div className="small muted" style={{ textAlign: 'center', marginTop: 10 }}>
                    Free · 20 minutes · no obligation
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>

      <PubFoot />
    </div>
  )
}
