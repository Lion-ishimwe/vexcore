import { useEffect, useState } from 'react'
import {
  CreditCard, CheckCircle2, Clock3, Copy, Smartphone, XCircle, BadgeCheck,
} from 'lucide-react'
import { api, fmtMoney, fmtDay } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Modal, Field, ErrorNote } from '../ui.jsx'

const STATUS_BADGE = { PENDING: 'amber', CONFIRMED: 'green', REJECTED: 'red', CANCELED: 'gray' }
// Every plan includes the full product - they differ only in project count.
const ALL_FEATURES = ['Every feature included', 'Full team: engineers, stock managers, guests', 'Attendance, stock, schedule & reports', 'Email notifications & branding']
const PLAN_BULLETS = {
  STARTER: ['1 active project', ...ALL_FEATURES],
  PRO: ['Up to 5 active projects', ...ALL_FEATURES],
  ENTERPRISE: ['Unlimited projects', ...ALL_FEATURES],
}

export default function Billing() {
  const { client, refresh } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [checkout, setCheckout] = useState(null) // payment being paid
  const [months, setMonths] = useState(1)
  const [phone, setPhone] = useState('')
  const [copied, setCopied] = useState(false)
  const [modalErr, setModalErr] = useState(null)

  // refresh() re-pulls the session too, so an expired-lock lifts as soon as a
  // confirmed payment makes the account active again.
  const load = () => api('/billing').then((d) => { setData(d); refresh() }).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])

  const choose = async (planKey) => {
    setBusy(true); setError(null)
    try {
      const p = await api('/billing/checkout', { method: 'POST', body: { plan: planKey, months } })
      setCheckout(p); setModalErr(null); setCopied(false)
      setPhone('')
      load()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const submitPaid = async (e) => {
    e.preventDefault()
    setBusy(true); setModalErr(null)
    try {
      await api(`/billing/payments/${checkout.id}/submit`, { method: 'POST', body: { payerPhone: phone } })
      setCheckout(null)
      load()
    } catch (err) { setModalErr(err.message) } finally { setBusy(false) }
  }

  const cancelPending = async (id) => {
    setBusy(true); setError(null)
    try { await api(`/billing/payments/${id}/cancel`, { method: 'POST' }); setCheckout(null); load() }
    catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  if (error && !data) return <div className="error-note">{error}</div>
  if (!data) return <div className="spin">Loading billing…</div>

  const sub = data.subscription
  const pending = data.pending
  const statusLine = sub.status === 'TRIAL'
    ? (sub.expired ? 'Trial ended' : `Free trial - ends ${fmtDay(sub.trialEndsAt)}`)
    : sub.status === 'ACTIVE'
      ? (sub.expired ? `${data.plans[sub.plan]?.name ?? sub.plan} - expired ${fmtDay(sub.paidUntil)}` : `${data.plans[sub.plan]?.name ?? sub.plan} - paid until ${fmtDay(sub.paidUntil)}`)
      : sub.status

  return (
    <>
      <ErrorNote error={error} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CreditCard size={18} />
            <div>
              <b style={{ fontSize: 15 }}>{client.company}</b>
              <div className="small muted">{statusLine}</div>
            </div>
          </div>
          <span className={`badge ${sub.expired ? 'red' : sub.status === 'ACTIVE' ? 'green' : 'amber'}`}>
            {sub.expired ? 'EXPIRED' : sub.status}
          </span>
        </div>
        {pending && (
          <div className="ok-note" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Clock3 size={14} />
            <span>
              Payment <b>{pending.reference}</b> ({fmtMoney(pending.amount, pending.currency)} · {data.plans[pending.plan]?.name} × {pending.months} month{pending.months > 1 ? 's' : ''})
              {pending.submittedAt
                ? ' is awaiting confirmation - your account activates as soon as we match it on the MoMo statement.'
                : ' is waiting for you to send the money.'}
            </span>
            <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <button className="btn sm" onClick={() => { setCheckout(pending); setPhone(pending.payerPhone ?? ''); setCopied(false); setModalErr(null) }}>
                {pending.submittedAt ? 'View' : 'Finish payment'}
              </button>
              <button className="btn ghost sm" onClick={() => cancelPending(pending.id)} disabled={busy}>Cancel</button>
            </span>
          </div>
        )}
      </div>

      <div className="flex-between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>
          Pay by MTN MoMo. Your account activates as soon as the payment is confirmed - usually within a few hours.
        </p>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Duration
          <select value={months} onChange={(e) => setMonths(+e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
            {[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m} month{m > 1 ? 's' : ''}</option>)}
          </select>
        </label>
      </div>

      <div className="grid grid-3">
        {Object.entries(data.plans).map(([key, p]) => {
          const current = sub.status === 'ACTIVE' && !sub.expired && sub.plan === key
          return (
            <div className="card" key={key} style={key === 'PRO' ? { border: '2px solid var(--accent)' } : {}}>
              {key === 'PRO' && <span className="badge amber" style={{ marginBottom: 10, display: 'inline-block' }}>Most popular</span>}
              {current && <span className="badge green" style={{ marginBottom: 10, display: 'inline-block', marginLeft: key === 'PRO' ? 8 : 0 }}><BadgeCheck size={11} /> Current plan</span>}
              <div style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</div>
              <div style={{ margin: '8px 0 14px' }}>
                <span style={{ fontSize: 24, fontWeight: 800 }}>
                  {p.price == null ? 'Custom' : fmtMoney(p.price * months, p.currency)}
                </span>
                {p.price != null && <span className="muted small"> / {months} month{months > 1 ? 's' : ''}</span>}
              </div>
              <div className="small" style={{ lineHeight: 2, marginBottom: 14 }}>
                {(PLAN_BULLETS[key] ?? []).map((b) => <div key={b}>✓ {b}</div>)}
              </div>
              {p.price == null ? (
                <button className="btn ghost" style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => setError('Enterprise plans are arranged directly - email support@bridge.app or call +250 788 000 000.')}>
                  Contact us
                </button>
              ) : (
                <button className="btn" style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => choose(key)} disabled={busy || current}>
                  {current ? 'Active' : sub.status === 'ACTIVE' && sub.plan ? (sub.plan === key ? 'Renew' : 'Switch to ' + p.name) : 'Subscribe'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {data.payments.length > 0 && (
        <div className="card table-card" style={{ marginTop: 16 }}>
          <h3 style={{ padding: '14px 14px 0' }}>Payment history</h3>
          <table>
            <thead><tr><th>Reference</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td><code>{p.reference}</code></td>
                  <td>{data.plans[p.plan]?.name ?? p.plan} × {p.months}m</td>
                  <td>{fmtMoney(p.amount, p.currency)}</td>
                  <td><span className={`badge ${STATUS_BADGE[p.status] ?? 'gray'}`}>{p.status}</span></td>
                  <td className="muted">{fmtDay(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {checkout && (
        <Modal title={`Pay ${fmtMoney(checkout.amount, checkout.currency)} - ${data.plans[checkout.plan]?.name} plan`} onClose={() => setCheckout(null)}>
          <ErrorNote error={modalErr} />
          <div className="pay-steps small">
            <p><b>1.</b> On the phone registered for MoMo, dial <code>*182*1*1#</code> (send money) or use the MoMo app.</p>
            <p><b>2.</b> Send <b>{fmtMoney(checkout.amount, checkout.currency)}</b> to:</p>
            <div className="tm-link-box" style={{ margin: '6px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Smartphone size={14} />
                <b style={{ fontSize: 15 }}>{data.momo.number}</b>
                <span className="muted">({data.momo.name})</span>
              </div>
            </div>
            <p><b>3.</b> Put this reference in the payment note, and keep it for your records:</p>
            <div className="tm-link-box" style={{ margin: '6px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <code style={{ fontSize: 15, fontWeight: 700 }}>{checkout.reference}</code>
              <button type="button" className="btn ghost sm"
                onClick={() => { navigator.clipboard?.writeText(checkout.reference); setCopied(true) }}>
                {copied ? <><CheckCircle2 size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
          </div>
          <form onSubmit={submitPaid} className="mt">
            <Field label="4. Which MoMo number did you pay from?">
              <input value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="078xxxxxxx" inputMode="tel" required />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" style={{ flex: 1, justifyContent: 'center' }} disabled={busy}>
                <CheckCircle2 size={14} /> I've sent the money
              </button>
              <button type="button" className="btn ghost" onClick={() => cancelPending(checkout.id)} disabled={busy}>
                <XCircle size={14} /> Cancel
              </button>
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              We match your payment against the MoMo statement and activate the account - you'll see the status here.
            </p>
          </form>
        </Modal>
      )}
    </>
  )
}
