import { useEffect, useState } from 'react'
import { CalendarDays, Download, Pencil, Clock3, Search } from 'lucide-react'
import { api, fmtDate } from '../api.js'
import { Modal, Field, ErrorNote, Avatar } from '../ui.jsx'

const STATUS_META = {
  SCHEDULED: { label: 'Scheduled', badge: 'blue' },
  DONE: { label: 'Done', badge: 'green' },
  NO_SHOW: { label: 'No-show', badge: 'amber' },
  CANCELED: { label: 'Canceled', badge: 'gray' },
}

export default function Demos() {
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState(null) // booking being managed
  const [form, setForm] = useState({ status: 'SCHEDULED', duration: '', note: '' })
  const [formError, setFormError] = useState(null)

  const load = () => {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    api('/admin/demos' + (params.size ? '?' + params : ''))
      .then(setD).catch((e) => setError(e.message))
  }
  useEffect(load, [status])

  const openManage = (b) => {
    setFormError(null)
    setForm({ status: b.status, duration: b.duration ?? '', note: b.note ?? '' })
    setEditing(b)
  }

  const save = async (e) => {
    e.preventDefault()
    setFormError(null)
    try {
      await api(`/admin/demos/${editing.id}`, { method: 'PATCH', body: form })
      setEditing(null)
      load()
    } catch (err) { setFormError(err.message) }
  }

  if (error) return <div className="error-note">{error}</div>
  if (!d) return <div className="spin">Loading demos…</div>

  const shown = d.demos.filter((b) =>
    !q || `${b.name} ${b.company ?? ''} ${b.email} ${b.phone ?? ''}`.toLowerCase().includes(q.toLowerCase()))

  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = [
      ['Slot', 'Name', 'Company', 'Email', 'Phone', 'Team size', 'Interests', 'Booked at', 'Status', 'Held at', 'Duration (min)', 'Note'],
      ...shown.map((b) => [
        new Date(b.slot).toLocaleString('en-GB'), b.name, b.company ?? '', b.email, b.phone ?? '',
        b.teamSize ?? '', (b.interests ?? []).join(' / '), new Date(b.createdAt).toLocaleString('en-GB'),
        STATUS_META[b.status]?.label ?? b.status,
        b.heldAt ? new Date(b.heldAt).toLocaleString('en-GB') : '', b.duration ?? '', b.note ?? '',
      ]),
    ]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([rows.map((l) => l.map(esc).join(',')).join('\n')], { type: 'text/csv' }))
    a.download = 'demo-bookings.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <div className="grid grid-4">
        <div className="card"><h3>Upcoming</h3><div className="big">{d.counts.upcoming}</div><div className="sub">scheduled and still ahead</div></div>
        <div className="card"><h3>Held</h3><div className="big" style={{ color: 'var(--green)' }}>{d.counts.done}</div><div className="sub">demos completed</div></div>
        <div className="card"><h3>No-shows</h3><div className="big" style={{ color: '#b45309' }}>{d.counts.noShow}</div><div className="sub">{d.counts.canceled} canceled</div></div>
        <div className="card"><h3>All time</h3><div className="big">{d.counts.total}</div><div className="sub">bookings recorded</div></div>
      </div>

      <div className="rep-filters no-print" style={{ margin: '16px 0 0' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Search size={13} className="muted" />
          <input placeholder="Search name, company, contact…" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ padding: '8px 11px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 12.5, minWidth: 220 }} />
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={exportCsv}><Download size={12} /> CSV</button>
      </div>

      <div className="card table-card mt">
        <table>
          <thead>
            <tr><th>Demo slot</th><th>Prospect</th><th>Contact</th><th>Team</th><th>Wants to see</th><th>Booked</th><th>Status</th><th>Time spent</th><th>Note</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.id}>
                <td><b style={{ whiteSpace: 'nowrap' }}><CalendarDays size={12} /> {fmtDate(b.slot)}</b></td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Avatar name={b.name} />
                    <div><b>{b.name}</b><div className="small muted">{b.company ?? '-'}</div></div>
                  </div>
                </td>
                <td className="small">{b.email}{b.phone && <div className="muted">{b.phone}</div>}</td>
                <td className="muted">{b.teamSize ?? '-'}</td>
                <td className="small muted" style={{ maxWidth: 160 }}>{(b.interests ?? []).join(', ') || '-'}</td>
                <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(b.createdAt)}</td>
                <td><span className={`badge ${STATUS_META[b.status]?.badge ?? 'gray'}`}>{STATUS_META[b.status]?.label ?? b.status}</span></td>
                <td className="small">
                  {b.status === 'DONE'
                    ? <><Clock3 size={11} /> {b.duration ? `${b.duration} min` : 'not recorded'}{b.heldAt && <div className="muted">held {fmtDate(b.heldAt)}</div>}</>
                    : <span className="muted">-</span>}
                </td>
                <td className="small muted" style={{ maxWidth: 180 }}>{b.note ?? '-'}</td>
                <td>
                  <button className="btn ghost sm" onClick={() => openManage(b)}><Pencil size={12} /> Manage</button>
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan="10" className="muted">No demo bookings match.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal title={`Demo - ${editing.name}${editing.company ? ` (${editing.company})` : ''}`} onClose={() => setEditing(null)}>
          <ErrorNote error={formError} />
          <div className="small muted" style={{ marginBottom: 12, display: 'grid', gap: 3 }}>
            <span><b>Slot:</b> {fmtDate(editing.slot)}</span>
            <span><b>Contact:</b> {editing.email}{editing.phone ? ` · ${editing.phone}` : ''}</span>
            {editing.teamSize && <span><b>Team size:</b> {editing.teamSize}</span>}
            {(editing.interests ?? []).length > 0 && <span><b>Interested in:</b> {editing.interests.join(', ')}</span>}
            <span><b>Booked:</b> {fmtDate(editing.createdAt)}</span>
          </div>
          <form onSubmit={save}>
            <Field label="Status">
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
            </Field>
            {form.status === 'DONE' && (
              <Field label="Time spent (minutes)">
                <input type="number" min="1" value={form.duration} placeholder="e.g. 45"
                  onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))} />
              </Field>
            )}
            <Field label="Notes (outcome, follow-up…)">
              <textarea rows="3" value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="e.g. Very interested in attendance + reports, follow up Friday" />
            </Field>
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>Save</button>
          </form>
        </Modal>
      )}
    </>
  )
}
