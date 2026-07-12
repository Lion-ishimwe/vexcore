import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { HardHat, Users, MapPin, Clock, Send } from 'lucide-react'
import { api, fmtDate } from '../api.js'
import { useAuth } from '../auth.jsx'
import { useT } from '../i18n.jsx'
import { Modal, Field, ErrorNote, Avatar, Lightbox, useForm } from '../ui.jsx'

export default function Updates() {
  const { user, can } = useAuth()
  const { t } = useT()
  const loc = useLocation()
  const [updates, setUpdates] = useState(null)
  const [projects, setProjects] = useState([])
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [v, set, setAll] = useForm({ projectId: '', phaseId: '', builders: '', helpers: '', note: '' })
  const [files, setFiles] = useState([])
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [attCounts, setAttCounts] = useState(null) // today's attendance for the picked project/phase

  useEffect(() => {
    setAttCounts(null)
    if (!creating || !v.projectId) return
    const q = new URLSearchParams({ projectId: v.projectId })
    if (v.phaseId) q.set('phaseId', v.phaseId)
    api('/attendance/counts?' + q)
      .then((c) => setAttCounts(c.builders + c.helpers > 0 ? c : null))
      .catch(() => {})
  }, [creating, v.projectId, v.phaseId])

  const load = () => api('/projects/updates').then(setUpdates).catch((e) => setError(e.message))
  useEffect(() => {
    load()
    if (can('projects.view') || can('updates.submit'))
      api('/projects').then(setProjects).catch(() => {})
  }, [])

  // The mobile FAB navigates here asking to open the form immediately
  useEffect(() => {
    if (loc.state?.openNew && can('updates.submit')) setCreating(true)
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
      for (const f of files) form.append('media', f)
      await api('/projects/updates', { method: 'POST', form })
      setCreating(false); setAll({ projectId: '', phaseId: '', builders: '', helpers: '', note: '' }); setFiles([])
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

  return (
    <>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <p className="muted">Daily site reports - worker counts, photos, and videos, timestamped and geotagged.</p>
        {can('updates.submit') && <button className="btn" onClick={() => setCreating(true)}>+ {t('upd.submit')}</button>}
      </div>

      {updates.map((u) => (
        <div className="card" style={{ marginBottom: 14 }} key={u.id}>
          <div className="update">
            <Avatar name={u.by} />
            <div className="update-card">
              <div className="update-head">
                <b>{u.by} - {u.project}{u.phase ? ` · ${u.phase}` : ''}</b>
                <span className="time">
                  {fmtDate(u.createdAt)}
                  {u.forwarded && <span className="badge blue" style={{ marginLeft: 8 }}>Forwarded to client</span>}
                </span>
              </div>
              {u.note && <div className="update-note">{u.note}</div>}
              <div className="chips">
                <span className="chip"><HardHat size={12} /> {u.builders} builders</span>
                <span className="chip"><Users size={12} /> {u.helpers} helpers</span>
                {u.geotag && <span className="chip"><MapPin size={12} /> {u.geotag}</span>}
                <span className="chip"><Clock size={12} /> Auto-timestamped</span>
              </div>
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
                  <button className="btn ghost sm" onClick={() => forward(u.id)}><Send size={12} /> Forward to client</button>
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
        <Modal title="Submit daily update" onClose={() => setCreating(false)}>
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
            {attCounts && (
              <div className="att-prefill">
                {t('upd.fromAtt')}: <b>{attCounts.builders} · {attCounts.helpers}</b>
                <button type="button" className="btn sm"
                  onClick={() => setAll((s) => ({ ...s, builders: String(attCounts.builders), helpers: String(attCounts.helpers) }))}>
                  {t('upd.useCounts')}
                </button>
              </div>
            )}
            <div className="grid grid-2" style={{ gap: 0, columnGap: 12 }}>
              <Field label={t('upd.builders')}><input type="number" min="0" value={v.builders} onChange={set('builders')} /></Field>
              <Field label={t('upd.helpers')}><input type="number" min="0" value={v.helpers} onChange={set('helpers')} /></Field>
            </div>
            <Field label="Notes"><textarea rows="3" value={v.note} onChange={set('note')} placeholder="What happened on site today?" /></Field>
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
