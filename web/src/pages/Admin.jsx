import { useEffect, useState } from 'react'
import { Wallet, Clock3, CalendarClock, BellRing, Wrench, Settings2 } from 'lucide-react'
import { api, fmtDay, fmtMoney, setToken } from '../api.js'
import { ErrorNote } from '../ui.jsx'

const PAY_BADGE = { PENDING: 'amber', CONFIRMED: 'green', REJECTED: 'red', CANCELED: 'gray' }
const STATUS_BADGE = { TRIAL: 'amber', ACTIVE: 'green', SUSPENDED: 'red', TERMINATED: 'gray' }

export default function Admin() {
  const [stats, setStats] = useState(null)
  const [payments, setPayments] = useState([])
  const [demos, setDemos] = useState([])
  const [error, setError] = useState(null)
  const [remDays, setRemDays] = useState('')
  const [savedDays, setSavedDays] = useState(false)

  const load = () => {
    api('/admin/dashboard').then((s) => { setStats(s); setRemDays(String(s.reminders.days)) }).catch((e) => setError(e.message))
    api('/admin/payments').then(setPayments).catch(() => {})
    api('/admin/demos').then(setDemos).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const decide = async (id, action) => {
    setError(null)
    try { await api(`/admin/payments/${id}`, { method: 'PATCH', body: { action } }); load() }
    catch (err) { setError(err.message) }
  }

  const saveDays = async () => {
    setError(null); setSavedDays(false)
    try {
      await api('/admin/settings', { method: 'PATCH', body: { renewalReminderDays: +remDays } })
      setSavedDays(true)
      setTimeout(() => setSavedDays(false), 2000)
      load()
    } catch (err) { setError(err.message) }
  }

  // Jump into the company's workspace (same support mode as the Companies tab)
  const openAs = async (id) => {
    setError(null)
    try {
      const r = await api(`/auth/impersonate/${id}`, { method: 'POST' })
      localStorage.setItem('bridge_super_token', localStorage.getItem('bridge_token'))
      setToken(r.token)
      window.location.hash = '#/'
      window.location.reload()
    } catch (err) { setError(err.message) }
  }

  if (error && !stats) return <div className="error-note">{error}</div>
  if (!stats) return <div className="spin">Loading platform dashboard…</div>

  return (
    <>
      <p className="muted" style={{ marginBottom: 16 }}>
        Platform overview for <b>{stats.month}</b> -{' '}
        {Object.entries(stats.statusCounts).map(([s, n], i) => (
          <span key={s}>{i > 0 && ' · '}{n} {s.toLowerCase()}</span>
        ))}
      </p>
      <ErrorNote error={error} />

      <div className="grid grid-3">
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Wallet size={14} color="var(--green)" /> Received this month</h3>
          <div className="big" style={{ color: 'var(--green)' }}>{fmtMoney(stats.received.total, 'RWF')}</div>
          <div className="sub">{stats.received.count} confirmed payment{stats.received.count === 1 ? '' : 's'}</div>
        </div>
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><CalendarClock size={14} color="var(--accent-dark, #b45309)" /> Due this month</h3>
          <div className="big">{fmtMoney(stats.due.total, 'RWF')}</div>
          <div className="sub">{stats.due.count} compan{stats.due.count === 1 ? 'y' : 'ies'} with trial or coverage ending</div>
        </div>
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Clock3 size={14} /> Pending to confirm</h3>
          <div className="big">{fmtMoney(stats.pending.total, 'RWF')}</div>
          <div className="sub">{stats.pending.count} payment{stats.pending.count === 1 ? '' : 's'} awaiting confirmation</div>
        </div>
      </div>

      {stats.reminders.companies.length > 0 && (
        <div className="card" style={{ marginTop: 16, border: '1.5px solid var(--accent)', background: '#fffbeb' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <BellRing size={14} color="var(--accent-dark, #b45309)" />
            Renewal reminders - within {stats.reminders.days} day{stats.reminders.days === 1 ? '' : 's'}
          </h3>
          <div className="mt" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stats.reminders.companies.map((c) => (
              <div key={c.id} className="flex-between" style={{ gap: 10, flexWrap: 'wrap' }}>
                <span>
                  <b>{c.company}</b>
                  <span className="small muted"> - {c.status === 'TRIAL' ? 'trial' : (c.plan ?? 'plan')} ends {fmtDay(c.endsAt)}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`badge ${c.daysLeft < 0 ? 'red' : 'amber'}`}>
                    {c.daysLeft < 0 ? `overdue ${-c.daysLeft} day${c.daysLeft === -1 ? '' : 's'}`
                      : c.daysLeft === 0 ? 'ends today'
                      : `${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'} left`}
                  </span>
                  <button className="btn ghost sm" onClick={() => openAs(c.id)}><Wrench size={12} /> Open</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.due.companies.length > 0 && (
        <>
          <div className="section-title">Falling due in {stats.month}</div>
          <div className="card table-card">
            <table>
              <thead><tr><th>Company</th><th>Status</th><th>Plan</th><th>Ends</th></tr></thead>
              <tbody>
                {stats.due.companies.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.company}</b></td>
                    <td><span className={`badge ${STATUS_BADGE[c.status] ?? 'gray'}`}>{c.status}</span></td>
                    <td>{c.plan ?? '-'}</td>
                    <td className="muted">{fmtDay(c.endsAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-title">Subscription payments (MoMo)</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr><th>Reference</th><th>Company</th><th>Plan</th><th>Amount</th><th>Paid from</th><th>Status</th><th>Date</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td><code>{p.reference}</code></td>
                <td><b>{p.client?.company}</b></td>
                <td>{p.plan} × {p.months}m</td>
                <td>{fmtMoney(p.amount, p.currency)}</td>
                <td className="muted">
                  {p.payerPhone ?? '-'}
                  {p.submittedAt && <div className="small muted">claimed {fmtDay(p.submittedAt)}</div>}
                </td>
                <td><span className={`badge ${PAY_BADGE[p.status] ?? 'gray'}`}>{p.status}</span></td>
                <td className="muted">{fmtDay(p.createdAt)}</td>
                <td>
                  {p.status === 'PENDING' && (
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button className="btn sm" onClick={() => decide(p.id, 'confirm')}>Confirm</button>
                      <button className="btn ghost sm" onClick={() => decide(p.id, 'reject')}>Reject</button>
                    </div>
                  )}
                  {p.status === 'CONFIRMED' && <span className="small muted">by {p.confirmedBy}</span>}
                </td>
              </tr>
            ))}
            {!payments.length && <tr><td colSpan="8" className="muted">No payments yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="section-title">Demo bookings</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr><th>When</th><th>Name</th><th>Company</th><th>Contact</th><th>Team size</th><th>Wants to see</th></tr>
          </thead>
          <tbody>
            {demos.map((d) => (
              <tr key={d.id}>
                <td><b>{new Date(d.slot).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b></td>
                <td>{d.name}</td>
                <td className="muted">{d.company ?? '-'}</td>
                <td className="muted">{d.email}{d.phone ? ` · ${d.phone}` : ''}</td>
                <td>{d.teamSize ?? '-'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {(d.interests ?? []).map((i) => <span className="badge gray" key={i}>{i}</span>)}
                  </div>
                </td>
              </tr>
            ))}
            {!demos.length && <tr><td colSpan="6" className="muted">No demo bookings yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="section-title">Platform settings</div>
      <div className="card">
        <div className="toggle-row" style={{ borderBottom: 'none' }}>
          <div>
            <div className="t-label" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Settings2 size={14} /> Renewal reminder window
            </div>
            <div className="t-sub">Show a reminder when a company's trial or paid coverage ends within this many days</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" min="1" max="60" value={remDays}
              onChange={(e) => setRemDays(e.target.value)}
              style={{ width: 70, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }} />
            <span className="small muted">days</span>
            <button className="btn sm" onClick={saveDays} disabled={+remDays === stats.reminders.days}>Save</button>
            {savedDays && <span className="badge green">Saved ✓</span>}
          </div>
        </div>
      </div>
    </>
  )
}
