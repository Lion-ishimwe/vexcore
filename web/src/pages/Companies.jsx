import { useEffect, useState } from 'react'
import {
  Search, LayoutGrid, List, Download, MoreHorizontal, Wrench, PauseCircle,
  PlayCircle, XCircle, Building2, Trash2, AlertTriangle,
} from 'lucide-react'
import { api, setToken, fmtDay } from '../api.js'
import { Avatar, ErrorNote, Modal, Field } from '../ui.jsx'

const STATUS_BADGE = { TRIAL: 'amber', ACTIVE: 'green', SUSPENDED: 'red', TERMINATED: 'gray' }

export default function Companies() {
  const [companies, setCompanies] = useState(null)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [statusF, setStatusF] = useState('')
  const [view, setView] = useState('grid')
  const [menuFor, setMenuFor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [remDays, setRemDays] = useState(5)

  const load = () => {
    api('/admin/clients').then(setCompanies).catch((e) => setError(e.message))
    api('/admin/settings').then((s) => setRemDays(s.renewalReminderDays)).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const daysLeft = (c) => c.renewalAt == null ? null
    : Math.ceil((new Date(c.renewalAt).getTime() - Date.now()) / 86400000)

  // Renewal cell: date + a reminder badge once inside the configured window
  const renewalCell = (c) => {
    const d = daysLeft(c)
    if (d == null) return <span className="muted">-</span>
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {fmtDay(c.renewalAt)}
        {d < 0 && <span className="badge red">overdue {-d}d</span>}
        {d >= 0 && d <= remDays && <span className="badge amber">{d === 0 ? 'today' : `in ${d}d`}</span>}
      </span>
    )
  }

  const setStatus = async (id, status) => {
    setMenuFor(null); setError(null)
    try { await api(`/admin/clients/${id}`, { method: 'PATCH', body: { status } }); load() }
    catch (err) { setError(err.message) }
  }

  // ---- Permanent deletion ----
  // No undo and no soft-delete, so this is deliberately harder than a click:
  // the word DELETE has to be typed, and the server re-checks it. (It used to
  // be the company name, which failed whenever the stored name carried a stray
  // space.) Suspending is the reversible option and stays one click.
  const [deleting, setDeleting] = useState(null) // the company being deleted
  const [typed, setTyped] = useState('')
  const CONFIRM_WORD = 'DELETE'
  const confirmed = typed.trim() === CONFIRM_WORD
  const [delErr, setDelErr] = useState(null)
  const [delBusy, setDelBusy] = useState(false)
  const [deleted, setDeleted] = useState(null) // summary of what went

  const openDelete = (c) => {
    setMenuFor(null); setError(null)
    setDeleting(c); setTyped(''); setDelErr(null); setDeleted(null)
  }

  const confirmDelete = async (e) => {
    e.preventDefault()
    if (delBusy || !confirmed) return
    setDelBusy(true); setDelErr(null)
    try {
      const r = await api(`/admin/clients/${deleting.id}`, { method: 'DELETE', body: { confirm: CONFIRM_WORD } })
      setDeleting(null)
      setDeleted(r)
      load()
    } catch (err) { setDelErr(err.message) } finally { setDelBusy(false) }
  }

  // Open the company's workspace as its admin (support mode). The super token
  // is parked in localStorage so "Exit support" can restore it.
  const openAs = async (c) => {
    setBusy(true); setError(null)
    try {
      const r = await api(`/auth/impersonate/${c.id}`, { method: 'POST' })
      localStorage.setItem('bridge_super_token', localStorage.getItem('bridge_token'))
      setToken(r.token)
      window.location.hash = '#/'
      window.location.reload()
    } catch (err) { setError(err.message); setBusy(false) }
  }

  const filtered = (companies ?? []).filter((c) =>
    (!q || c.company.toLowerCase().includes(q.toLowerCase())) &&
    (!statusF || c.status === statusF)
  )

  const exportCsv = () => {
    const rows = [
      ['Company', 'Country', 'Status', 'Plan', 'Paid until', 'Users', 'Projects', 'Signed up'],
      ...filtered.map((c) => [c.company, c.country ?? '', c.status, c.plan ?? '', c.paidUntil ? fmtDay(c.paidUntil) : '', c.users, c.projects, fmtDay(c.createdAt)]),
    ]
    const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = 'bridge-companies.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (error && !companies) return <div className="error-note">{error}</div>
  if (!companies) return <div className="spin">Loading companies…</div>

  const coverage = (c) =>
    c.status === 'TRIAL' ? `Trial ends ${fmtDay(c.trialEndsAt)}`
      : c.status === 'ACTIVE' && c.paidUntil ? `${c.plan ?? ''} until ${fmtDay(c.paidUntil)}`
      : c.status.charAt(0) + c.status.slice(1).toLowerCase()

  return (
    <>
      <ErrorNote error={error} />
      <div className="team-toolbar">
        <div className="tt-search">
          <Search size={14} />
          <input placeholder="Search company" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="">Status - all</option>
          {['TRIAL', 'ACTIVE', 'SUSPENDED', 'TERMINATED'].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
        </select>
        <div className="tt-views">
          <button className={view === 'grid' ? 'on' : ''} title="Card view" onClick={() => setView('grid')}><LayoutGrid size={15} /></button>
          <button className={view === 'list' ? 'on' : ''} title="List view" onClick={() => setView('list')}><List size={15} /></button>
          <button title="Export CSV" onClick={exportCsv}><Download size={15} /></button>
        </div>
        <b className="tt-count">All Companies ({filtered.length})</b>
      </div>

      {view === 'grid' ? (
        <div className="team-grid">
          {filtered.map((c) => (
            <div className="card tm-card" key={c.id}>
              <div className="tm-top">
                <span className={`badge ${STATUS_BADGE[c.status] ?? 'gray'}`}>
                  <span className="tm-dot" /> {c.status.charAt(0) + c.status.slice(1).toLowerCase()}
                </span>
                <button className="tm-more" onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}>
                  <MoreHorizontal size={17} />
                </button>
                {menuFor === c.id && (
                  <>
                    <div className="tm-menu-back" onClick={() => setMenuFor(null)} />
                    <div className="tm-menu">
                      <button onClick={() => openAs(c)} disabled={busy}><Wrench size={13} /> Open as admin</button>
                      {c.status !== 'ACTIVE' && <button onClick={() => setStatus(c.id, 'ACTIVE')}><PlayCircle size={13} /> Activate</button>}
                      {c.status !== 'SUSPENDED' && c.status !== 'TERMINATED' &&
                        <button onClick={() => setStatus(c.id, 'SUSPENDED')}><PauseCircle size={13} /> Suspend</button>}
                      {c.status === 'SUSPENDED' && <button onClick={() => setStatus(c.id, 'TERMINATED')}><XCircle size={13} /> Terminate</button>}
                      <button className="danger" onClick={() => openDelete(c)}>
                        <Trash2 size={13} /> Delete permanently
                      </button>
                    </div>
                  </>
                )}
              </div>
              <div className="tm-body" onClick={() => openAs(c)} style={{ cursor: 'pointer' }} title="Open this workspace as its admin (support)">
                <Avatar name={c.company} />
                <div className="tm-id">
                  <b>{c.company}</b>
                  <span>{c.country ?? '-'} · {c.currency}</span>
                  <span>{c.users} user{c.users === 1 ? '' : 's'} · {c.projects} project{c.projects === 1 ? '' : 's'}</span>
                </div>
              </div>
              <div className="tm-foot">
                <span className="small muted">{coverage(c)}</span>
                <span className="small">{renewalCell(c)}</span>
              </div>
            </div>
          ))}
          {!filtered.length && <p className="muted">No companies match.</p>}
        </div>
      ) : (
        <div className="card table-card">
          <table>
            <thead><tr><th>Company</th><th>Country</th><th>Users</th><th>Projects</th><th>Status</th><th>Plan</th><th>Renewal</th><th>Signed up</th><th></th></tr></thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Avatar name={c.company} /><b>{c.company}</b></td>
                  <td className="muted">{c.country ?? '-'}</td>
                  <td>{c.users}</td>
                  <td>{c.projects}</td>
                  <td><span className={`badge ${STATUS_BADGE[c.status] ?? 'gray'}`}>{c.status}</span></td>
                  <td className="muted">{c.status === 'TRIAL' ? 'Trial' : c.plan ?? '-'}</td>
                  <td>{renewalCell(c)}</td>
                  <td className="muted">{fmtDay(c.createdAt)}</td>
                  <td>
                    <button className="btn ghost sm" onClick={() => openAs(c)} disabled={busy}>
                      <Wrench size={12} /> Open as admin
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>
        <Building2 size={12} /> Clicking a company opens its workspace in support mode - you act as its
        admin with full access to every feature and setting, and your visit is recorded in the company's audit trail.
      </p>

      {deleting && (
        <Modal title={`Delete "${deleting.company}" permanently`} onClose={() => setDeleting(null)}>
          <ErrorNote error={delErr} />
          <div className="error-note" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 14 }}>
            <AlertTriangle size={18} style={{ flex: 'none', marginTop: 1 }} />
            <div>
              <b>This cannot be undone.</b> Everything belonging to this company is erased:
              its {deleting.users} user account{deleting.users === 1 ? '' : 's'} and {deleting.projects} project
              {deleting.projects === 1 ? '' : 's'}, plus every phase, daily report, photo, document,
              attendance record, worker, stock item, message and payment record.
              Uploaded files are deleted from disk too.
            </div>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Looking to stop access without losing the data? Close this and use <b>Suspend</b> instead -
            that is reversible.
          </p>
          <form onSubmit={confirmDelete}>
            <Field label={<>Type <b>{CONFIRM_WORD}</b> to confirm</>}>
              <input value={typed} autoFocus autoComplete="off" autoCapitalize="characters"
                spellCheck={false} placeholder={CONFIRM_WORD}
                onChange={(e) => setTyped(e.target.value)} />
            </Field>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost" onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn danger" disabled={delBusy || !confirmed}>
                {delBusy ? 'Deleting…' : 'Delete this company for ever'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleted && (
        <Modal title="Company deleted" onClose={() => setDeleted(null)}>
          <div className="ok-note" style={{ marginBottom: 12 }}>
            <b>{deleted.company}</b> and all of its data have been permanently removed.
          </div>
          <table style={{ width: '100%' }}>
            <tbody>
              {Object.entries(deleted.counts ?? {}).filter(([, n]) => n > 0).map(([k, n]) => (
                <tr key={k}>
                  <td className="muted small" style={{ textTransform: 'capitalize' }}>{k.replace(/([A-Z])/g, ' $1')}</td>
                  <td className="small" style={{ textAlign: 'right' }}><b>{n.toLocaleString()}</b></td>
                </tr>
              ))}
              {deleted.files > 0 && (
                <tr><td className="muted small">Uploaded files</td><td className="small" style={{ textAlign: 'right' }}><b>{deleted.files}</b></td></tr>
              )}
            </tbody>
          </table>
          <p className="small muted">A record of this deletion is kept on the platform.</p>
          <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setDeleted(null)}>Close</button>
        </Modal>
      )}
    </>
  )
}
