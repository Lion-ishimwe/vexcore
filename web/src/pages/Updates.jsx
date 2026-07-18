import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { HardHat, Users, MapPin, Clock, Send, Banknote, Package, X } from 'lucide-react'
import { api, fmtDate, fmtMoney } from '../api.js'
import { useAuth } from '../auth.jsx'
import { useT } from '../i18n.jsx'
import { Modal, Field, ErrorNote, Avatar, Lightbox, useForm } from '../ui.jsx'

export default function Updates() {
  const { user, can, client } = useAuth()
  const { t } = useT()
  const loc = useLocation()
  const [updates, setUpdates] = useState(null)
  const [projects, setProjects] = useState([])
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [v, set, setAll] = useForm({ projectId: '', phaseId: '', note: '' })
  const [files, setFiles] = useState([])
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [attCounts, setAttCounts] = useState(null) // today's attendance for the picked project/phase
  const [stock, setStock] = useState([]) // pickable stock for "items used"
  const [items, setItems] = useState([]) // { stockItemId, name, unit, qty }
  const [draft, setDraft] = useState({ stockItemId: '', qty: '' })
  // Crew on site: pulled automatically from today's attendance (per worker
  // type), plus manual rows for extra types working the same day.
  const workerTypes = client?.settings?.workerTypes ?? ['builder', 'helper']
  const [crew, setCrew] = useState([]) // { type, count, auto }
  const [crewDraft, setCrewDraft] = useState({ type: '', count: '' })

  useEffect(() => {
    if (!creating) return
    api('/stock').then(setStock).catch(() => {}) // no stock rights → picker stays empty
  }, [creating])

  // Switching project invalidates project-scoped stock picks.
  useEffect(() => { setItems([]); setDraft({ stockItemId: '', qty: '' }) }, [v.projectId])

  // Workers pull in automatically from the attendance feature: per-type
  // counts become editable crew rows; the attended names + phases are shown.
  useEffect(() => {
    setAttCounts(null)
    setCrew((rows) => rows.filter((r) => !r.auto)) // project/phase changed → drop old auto rows
    if (!creating || !v.projectId) return
    const q = new URLSearchParams({ projectId: v.projectId })
    if (v.phaseId) q.set('phaseId', v.phaseId)
    api('/attendance/counts?' + q)
      .then((c) => {
        if (!(c.workers ?? []).length) return
        setAttCounts(c)
        setCrew((rows) => [
          ...Object.entries(c.byType ?? {}).map(([type, count]) => ({ type, count, auto: true })),
          ...rows.filter((r) => !r.auto && !c.byType?.[r.type]),
        ])
      })
      .catch(() => {})
  }, [creating, v.projectId, v.phaseId])

  // The Admin only receives reports (submit → forward chain) - no submitting.
  const canSubmit = can('updates.submit') && user.role !== 'CLIENT'

  const load = () => api('/projects/updates').then(setUpdates).catch((e) => setError(e.message))
  useEffect(() => {
    load()
    if (can('projects.view') || can('updates.submit'))
      api('/projects').then(setProjects).catch(() => {})
  }, [])

  // The mobile FAB navigates here asking to open the form immediately
  useEffect(() => {
    if (loc.state?.openNew && canSubmit) setCreating(true)
  }, [loc.state?.openNew]) // eslint-disable-line

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setFormError(null)
    try {
      const form = new FormData()
      for (const [k, val] of Object.entries(v)) form.append(k, val)
      // Geotag from the browser if available (auto-timestamped server-side)
      const geo = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null)
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve(`${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`),
          () => resolve(null), { timeout: 3000 })
      })
      if (geo) form.append('geotag', geo)
      if (crew.length) form.append('crew', JSON.stringify(crew.map((c) => ({ type: c.type, count: c.count }))))
      if (items.length) form.append('items', JSON.stringify(items.map((i) => ({ stockItemId: i.stockItemId, qty: i.qty }))))
      for (const f of files) form.append('media', f)
      await api('/projects/updates', { method: 'POST', form })
      setCreating(false); setAll({ projectId: '', phaseId: '', note: '' }); setFiles([])
      setItems([]); setDraft({ stockItemId: '', qty: '' })
      setCrew([]); setCrewDraft({ type: '', count: '' })
      load()
    } catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const forward = async (id) => {
    try { await api(`/projects/updates/${id}/forward`, { method: 'POST' }); load() }
    catch (err) { setError(err.message) }
  }

  if (error) return <div className="error-note">{error}</div>
  if (!updates) return <div className="spin">Loading updates…</div>
  const selectedProject = projects.find((p) => p.id === +v.projectId)
  const cur = client?.currency

  // Consumables available to the picked project (own stock + general store),
  // excluding items already added to this report.
  const pickable = stock.filter((s) =>
    s.category !== 'Machine' && s.qty > 0 &&
    (s.projectId == null || s.projectId === +v.projectId) &&
    !items.some((i) => i.stockItemId === s.id))

  const addItem = () => {
    const s = stock.find((x) => x.id === +draft.stockItemId)
    const qty = Number(draft.qty)
    if (!s || !qty || qty <= 0) return
    if (qty > s.qty) { setFormError(`Only ${s.qty} ${s.unit} of ${s.name} in stock`); return }
    setFormError(null)
    setItems((list) => [...list, { stockItemId: s.id, name: s.name, unit: s.unit, qty }])
    setDraft({ stockItemId: '', qty: '' })
  }

  // Extra crew row: a worker type (from Settings) + how many were on site.
  const addCrew = () => {
    const type = crewDraft.type
    const count = Number(crewDraft.count)
    if (!type || !count || count <= 0) return
    setCrew((list) => {
      const existing = list.find((c) => c.type === type)
      return existing
        ? list.map((c) => c.type === type ? { ...c, count: c.count + count } : c)
        : [...list, { type, count }]
    })
    setCrewDraft({ type: '', count: '' })
  }

  return (
    <>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <p className="muted">Daily site reports - worker counts, photos, and videos, timestamped and geotagged.</p>
        {canSubmit && <button className="btn" onClick={() => setCreating(true)}>+ {t('upd.submit')}</button>}
      </div>

      {updates.map((u) => (
        <div className="card" style={{ marginBottom: 14 }} key={u.id}>
          <div className="update">
            <Avatar name={u.by} photo={u.byPhoto} />
            <div className="update-card">
              <div className="update-head">
                <b>{u.by} - {u.project}{u.phase ? ` · ${u.phase}` : ''}</b>
                <span className="time">
                  {fmtDate(u.createdAt)}
                  {/* The badge is only meaningful to the engineers tracking what's
                      been sent - Admin/Guest only ever see forwarded reports, and
                      the Stock Manager doesn't handle the forward chain. */}
                  {u.forwarded && !['CLIENT', 'GUEST', 'STOCK'].includes(user.role) &&
                    <span className="badge blue" style={{ marginLeft: 8 }}>Forwarded to Admin</span>}
                </span>
              </div>
              {u.note && <div className="update-note">{u.note}</div>}
              <div className="chips">
                {u.crew?.length ? (
                  u.crew.map((c, i) => (
                    <span className="chip" key={i}>
                      {c.type === 'helper' ? <Users size={12} /> : <HardHat size={12} />} {c.count} {c.type}{c.count === 1 ? '' : 's'}
                    </span>
                  ))
                ) : (
                  <>
                    <span className="chip"><HardHat size={12} /> {u.builders} builders</span>
                    <span className="chip"><Users size={12} /> {u.helpers} helpers</span>
                  </>
                )}
                {u.geotag && <span className="chip"><MapPin size={12} /> {u.geotag}</span>}
                <span className="chip"><Clock size={12} /> Auto-timestamped</span>
              </div>
              {(u.attendance || u.materialsUsed) && (
                <div className="update-costs">
                  {u.attendance && (
                    <div className="cost-block">
                      <div className="cost-head">
                        <span><Users size={13} /> Workers attended ({u.attendance.workers.length})</span>
                        {u.attendance.total != null && <b><Banknote size={13} /> {fmtMoney(u.attendance.total, cur)}</b>}
                      </div>
                      {u.attendance.workers.map((w, i) => (
                        <div className="cost-line" key={i}>
                          <span>{w.name} <span className="muted">· {w.type}</span></span>
                          {w.amount != null && <span>{fmtMoney(w.amount, cur)}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {u.materialsUsed && (
                    <div className="cost-block">
                      <div className="cost-head">
                        <span><Package size={13} /> Items used ({u.materialsUsed.items.length})</span>
                        {u.materialsUsed.total != null && <b><Banknote size={13} /> {fmtMoney(u.materialsUsed.total, cur)}</b>}
                      </div>
                      {u.materialsUsed.items.map((m, i) => (
                        <div className="cost-line" key={i}>
                          <span>{m.qty.toLocaleString()} × {m.name}</span>
                          {m.cost != null && <span>{fmtMoney(m.cost, cur)}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {u.media.length > 0 && (
                <div className="media-strip">
                  {u.media.map((m) => m.kind === 'photo' ? (
                    <img key={m.id} className="media-img" src={m.url} alt="progress"
                      title="Click to view"
                      onClick={() => setLightbox({ url: m.url, name: `${u.project} - ${fmtDate(u.createdAt)}`, download: u.canDownload })} />
                  ) : (
                    <video key={m.id} className="media-img" src={m.url} controls
                      controlsList={u.canDownload ? undefined : 'nodownload'} />
                  ))}
                </div>
              )}
              {can('updates.forward') && !u.forwarded && (
                <div style={{ marginTop: 12 }}>
                  <button className="btn ghost sm" onClick={() => forward(u.id)}><Send size={12} /> Forward to Admin</button>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
      {!updates.length && (
        <div className="card muted">
          {user.role === 'CLIENT'
            ? 'No updates forwarded to you yet - the Senior Engineer forwards progress from the field.'
            : 'No updates yet.'}
        </div>
      )}

      <Lightbox img={lightbox} onClose={() => setLightbox(null)} />

      {creating && (
        <Modal title="Submit daily update" onClose={() => { setCreating(false); setItems([]); setDraft({ stockItemId: '', qty: '' }) }}>
          <ErrorNote error={formError} />
          <form onSubmit={submit}>
            <Field label="Project *">
              <select value={v.projectId} onChange={set('projectId')} required>
                <option value="">- Select -</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Phase">
              <select value={v.phaseId} onChange={set('phaseId')}>
                <option value="">- None -</option>
                {(selectedProject?.phases ?? []).map((ph) => <option key={ph.id} value={ph.id}>{ph.name}</option>)}
              </select>
            </Field>
            <Field label="Workers on site">
              {attCounts ? (
                <div className="att-prefill" style={{ display: 'block' }}>
                  <b>{attCounts.workers.length} attended today</b>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {attCounts.workers.map((w, i) => (
                      <span key={i}>{i > 0 && ' · '}{w.name} ({w.type}{w.phase ? ` – ${w.phase}` : ''})</span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="small muted" style={{ marginBottom: 6 }}>
                  {v.projectId ? 'No attendance recorded today - add the crew below.' : 'Pick a project first.'}
                </div>
              )}
              {crew.map((c, idx) => (
                <div className="cost-line" key={c.type}>
                  <span>
                    <HardHat size={12} /> {c.count} × {c.type}
                    {c.auto && <span className="badge blue" style={{ marginLeft: 6 }}>from attendance</span>}
                  </span>
                  <X size={13} style={{ cursor: 'pointer' }} title="Remove"
                    onClick={() => setCrew((l) => l.filter((_, j) => j !== idx))} />
                </div>
              ))}
              {/* Many worker types work the site the same day - add each one. */}
              <div className="item-add" style={{ marginTop: crew.length ? 8 : 0 }}>
                <select value={crewDraft.type} onChange={(e) => setCrewDraft((d) => ({ ...d, type: e.target.value }))}>
                  <option value="">- Worker type -</option>
                  {workerTypes.filter((wt) => !crew.some((c) => c.type === wt)).map((wt) => (
                    <option key={wt} value={wt}>{wt}</option>
                  ))}
                </select>
                <input type="number" min="1" placeholder="How many" value={crewDraft.count}
                  onChange={(e) => setCrewDraft((d) => ({ ...d, count: e.target.value }))} style={{ width: 100 }} />
                <button type="button" className="btn ghost sm" onClick={addCrew}>Add</button>
              </div>
            </Field>
            <Field label="Notes"><textarea rows="3" value={v.note} onChange={set('note')} placeholder="What happened on site today?" /></Field>
            <Field label="Items used today (deducted from stock)">
              <div className="item-add">
                <select value={draft.stockItemId} onChange={(e) => setDraft((d) => ({ ...d, stockItemId: e.target.value }))}>
                  <option value="">- Select item -</option>
                  {pickable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.qty.toLocaleString()} {s.unit} left{s.projectId == null ? ' (general store)' : ''}
                    </option>
                  ))}
                </select>
                <input type="number" min="1" placeholder="Qty" value={draft.qty}
                  onChange={(e) => setDraft((d) => ({ ...d, qty: e.target.value }))} style={{ width: 84 }} />
                <button type="button" className="btn ghost sm" onClick={addItem}>Add</button>
              </div>
              {items.map((i, idx) => (
                <div className="cost-line" key={i.stockItemId}>
                  <span><Package size={12} /> {i.qty.toLocaleString()} {i.unit} × {i.name}</span>
                  <X size={13} style={{ cursor: 'pointer' }} title="Remove"
                    onClick={() => setItems((l) => l.filter((_, j) => j !== idx))} />
                </div>
              ))}
            </Field>
            <Field label="Photos / videos">
              <input type="file" multiple accept="image/*,video/*" onChange={(e) => setFiles([...e.target.files])} />
            </Field>
            {files.length > 0 && <div className="small muted" style={{ marginBottom: 10 }}>{files.length} file(s) attached</div>}
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              {busy ? 'Uploading…' : 'Submit update'}
            </button>
          </form>
        </Modal>
      )}
    </>
  )
}
