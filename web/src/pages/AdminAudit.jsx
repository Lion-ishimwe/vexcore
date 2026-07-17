import { useEffect, useState } from 'react'
import { History, Search } from 'lucide-react'
import { api, fmtDate } from '../api.js'

// Platform audit trail - every action across ALL companies. Super Admin only;
// client roles have no audit access at all.
export default function AdminAudit() {
  const [rows, setRows] = useState(null)
  const [clients, setClients] = useState([])
  const [error, setError] = useState(null)
  const [clientId, setClientId] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    const params = new URLSearchParams()
    if (clientId) params.set('clientId', clientId)
    api('/admin/audit' + (params.size ? '?' + params : ''))
      .then(setRows).catch((e) => setError(e.message))
  }, [clientId])
  useEffect(() => { api('/admin/clients').then(setClients).catch(() => {}) }, [])

  if (error) return <div className="error-note">{error}</div>
  if (!rows) return <div className="spin">Loading audit trail…</div>

  const shown = rows.filter((a) =>
    !q || `${a.company} ${a.userName} ${a.action} ${a.detail ?? ''}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <div className="rep-filters no-print">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">All companies</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.company}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Search size={13} className="muted" />
          <input placeholder="Filter by company, user, action, detail…" value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ padding: '8px 11px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 12.5, minWidth: 260 }} />
        </div>
        <div style={{ flex: 1 }} />
        <span className="small muted">{shown.length} entr{shown.length === 1 ? 'y' : 'ies'} (latest 300 per load)</span>
      </div>

      <div className="card">
        <div className="small" style={{ lineHeight: 2.2 }}>
          {shown.map((a) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <History size={12} style={{ flexShrink: 0, transform: 'translateY(1px)' }} />
              <span>
                <span className="badge gray" style={{ marginRight: 7 }}>{a.company}</span>
                <b>{a.userName}</b> - {a.action}{a.detail ? `: ${a.detail}` : ''}
                <span className="muted"> · {fmtDate(a.createdAt)}</span>
              </span>
            </div>
          ))}
          {!shown.length && <span className="muted">No audit entries match.</span>}
        </div>
      </div>
    </>
  )
}
