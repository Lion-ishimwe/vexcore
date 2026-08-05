import { useEffect, useState } from 'react'
import { Wallet, Clock3, Download, Search, Hourglass } from 'lucide-react'
import { api, fmtDay, fmtMoney } from '../api.js'
import { ErrorNote, useDialog } from '../ui.jsx'

const PAY_BADGE = { PENDING: 'amber', CONFIRMED: 'green', REJECTED: 'red', CANCELED: 'gray' }
const STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELED']
// Baseline for the trial pipeline - matches the API's "due" fallback (Starter).
const STARTER_PRICE = 30000

export default function Payments() {
  const { confirm } = useDialog()
  const [payments, setPayments] = useState(null)
  const [clients, setClients] = useState([])
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')

  const load = () => {
    api('/admin/payments').then(setPayments).catch((e) => setError(e.message))
    api('/admin/clients').then(setClients).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const decide = async (id, action) => {
    setError(null)
    if (action === 'reject') {
      const ok = await confirm('The company keeps its current status and is not credited.',
        { title: 'Reject this payment?', confirmText: 'Reject payment', danger: true })
      if (!ok) return
    }
    try { await api(`/admin/payments/${id}`, { method: 'PATCH', body: { action } }); load() }
    catch (err) { setError(err.message) }
  }

  if (error && !payments) return <div className="error-note">{error}</div>
  if (!payments) return <div className="spin">Loading payments…</div>

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const confirmed = payments.filter((p) => p.status === 'CONFIRMED')
  const pending = payments.filter((p) => p.status === 'PENDING')
  const receivedThisMonth = confirmed.filter((p) => p.confirmedAt && new Date(p.confirmedAt) >= monthStart)
  const sum = (arr) => arr.reduce((s, p) => s + p.amount, 0)

  const shown = payments.filter((p) =>
    (!status || p.status === status) &&
    (!q || `${p.reference} ${p.client?.company ?? ''} ${p.payerPhone ?? ''} ${p.plan}`.toLowerCase().includes(q.toLowerCase())))

  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = [
      ['Reference', 'Company', 'Plan', 'Months', 'Amount', 'Currency', 'Paid from', 'Claimed at', 'Status', 'Created', 'Confirmed at', 'Confirmed by', 'Note'],
      ...shown.map((p) => [
        p.reference, p.client?.company ?? '', p.plan, p.months, p.amount, p.currency,
        p.payerPhone ?? '', p.submittedAt ? new Date(p.submittedAt).toLocaleString('en-GB') : '',
        p.status, new Date(p.createdAt).toLocaleString('en-GB'),
        p.confirmedAt ? new Date(p.confirmedAt).toLocaleString('en-GB') : '', p.confirmedBy ?? '', p.note ?? '',
      ]),
    ]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([rows.map((l) => l.map(esc).join(',')).join('\n')], { type: 'text/csv' }))
    a.download = 'subscription-payments.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <ErrorNote error={error} />
      <div className="grid grid-4">
        <div className="card">
          <h3><Wallet size={13} color="var(--green)" /> Received this month</h3>
          <div className="big" style={{ color: 'var(--green)' }}>{fmtMoney(sum(receivedThisMonth), 'RWF')}</div>
          <div className="sub">{receivedThisMonth.length} confirmed payment{receivedThisMonth.length === 1 ? '' : 's'}</div>
        </div>
        <div className="card">
          <h3><Clock3 size={13} /> Pending to confirm</h3>
          <div className="big" style={{ color: pending.length ? '#b45309' : undefined }}>{fmtMoney(sum(pending), 'RWF')}</div>
          <div className="sub">{pending.length} payment{pending.length === 1 ? '' : 's'} awaiting confirmation</div>
        </div>
        <div className="card">
          <h3><Hourglass size={13} color="#b45309" /> Trial revenue</h3>
          <div className="big">{fmtMoney(clients.filter((c) => c.status === 'TRIAL').length * STARTER_PRICE, 'RWF')}</div>
          <div className="sub">
            {clients.filter((c) => c.status === 'TRIAL').length} compan{clients.filter((c) => c.status === 'TRIAL').length === 1 ? 'y' : 'ies'} on trial · monthly, if they subscribe at Starter
          </div>
        </div>
        <div className="card">
          <h3>Received all time</h3>
          <div className="big">{fmtMoney(sum(confirmed), 'RWF')}</div>
          <div className="sub">{confirmed.length} confirmed · {payments.filter((p) => p.status === 'REJECTED').length} rejected · {payments.filter((p) => p.status === 'CANCELED').length} canceled</div>
        </div>
      </div>

      <div className="rep-filters no-print" style={{ margin: '16px 0 0' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Search size={13} className="muted" />
          <input placeholder="Search reference, company, phone…" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ padding: '8px 11px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 12.5, minWidth: 230 }} />
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={exportCsv}><Download size={12} /> CSV</button>
      </div>

      <div className="card table-card mt">
        <table>
          <thead>
            <tr><th>Reference</th><th>Company</th><th>Plan</th><th>Amount</th><th>Paid from</th><th>Status</th><th>Created</th><th>Confirmed</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td><code>{p.reference}</code></td>
                <td>
                  <b>{p.client?.company}</b>
                  {p.client?.paidUntil && <div className="small muted">covered until {fmtDay(p.client.paidUntil)}</div>}
                </td>
                <td>{p.plan} × {p.months}m</td>
                <td>{fmtMoney(p.amount, p.currency)}</td>
                <td className="muted">
                  {p.payerPhone ?? '-'}
                  {p.submittedAt && <div className="small muted">claimed {fmtDay(p.submittedAt)}</div>}
                </td>
                <td><span className={`badge ${PAY_BADGE[p.status] ?? 'gray'}`}>{p.status}</span></td>
                <td className="muted">{fmtDay(p.createdAt)}</td>
                <td className="small muted">
                  {p.confirmedAt ? <>{fmtDay(p.confirmedAt)}{p.confirmedBy && <div>by {p.confirmedBy}</div>}</> : '-'}
                </td>
                <td>
                  {p.status === 'PENDING' && (
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button className="btn sm" onClick={() => decide(p.id, 'confirm')}>Confirm</button>
                      <button className="btn ghost sm" onClick={() => decide(p.id, 'reject')}>Reject</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan="9" className="muted">No payments match.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}
