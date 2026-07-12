import { useEffect, useState } from 'react'
import { CalendarDays, UserRound, Banknote, Package, CheckCircle2, Camera, X, Plus, FileText, Pencil, Trash2 } from 'lucide-react'
import { api, fmtMoney, fmtDay } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Modal, Field, ErrorNote, Lightbox, useForm } from '../ui.jsx'

const COLS = [
  { key: 'todo', label: 'To do', action: 'Start phase', next: 'active' },
  { key: 'active', label: 'In progress', action: 'Mark done', next: 'done' },
  { key: 'done', label: 'Done' },
]

export default function Kanban() {
  const { client, can } = useAuth()
  const [projects, setProjects] = useState(null)
  const [projectId, setProjectId] = useState(null)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null) // phase being edited
  const [team, setTeam] = useState([])
  const [v, set, setAll] = useForm({ name: '', budget: '', costPerBuilder: '', costPerHelper: '', startDate: '', endDate: '', assigneeId: '' })
  const [formError, setFormError] = useState(null)
  const [newIns, setNewIns] = useState({}) // draft insight title per phase id
  const [lightbox, setLightbox] = useState(null)
  const [dragging, setDragging] = useState(null) // phase being dragged
  const [overCol, setOverCol] = useState(null) // column hovered during drag

  const load = () => api('/projects').then((ps) => {
    setProjects(ps)
    setProjectId((id) => id ?? ps.find((p) => p.phases.length)?.id ?? ps[0]?.id ?? null)
  }).catch((e) => setError(e.message))

  useEffect(() => {
    load()
    if (can('team.view')) api('/team').then(setTeam).catch(() => {})
  }, [])

  if (error) return <div className="error-note">{error}</div>
  if (!projects) return <div className="spin">Loading phases…</div>
  const project = projects.find((p) => p.id === projectId)
  const showMoney = can('stock.amounts')
  const canEdit = can('phases.edit')
  const cur = client?.currency

  const patchPhase = async (phaseId, body) => {
    setToast(null)
    try {
      await api(`/projects/phases/${phaseId}`, { method: 'PATCH', body })
      load()
    } catch (err) { setToast(err.message) }
  }

  const emptyForm = { name: '', budget: '', costPerBuilder: '', costPerHelper: '', startDate: '', endDate: '', assigneeId: '' }

  const savePhase = async (e) => {
    e.preventDefault()
    setFormError(null)
    try {
      if (editing) await api(`/projects/phases/${editing.id}`, { method: 'PATCH', body: v })
      else await api(`/projects/${project.id}/phases`, { method: 'POST', body: v })
      setCreating(false); setEditing(null); setAll(emptyForm)
      load()
    } catch (err) { setFormError(err.message) }
  }

  const openEdit = (ph) => {
    setFormError(null)
    setAll({
      name: ph.name, budget: ph.budget || '',
      costPerBuilder: ph.costPerBuilder || '', costPerHelper: ph.costPerHelper || '',
      startDate: ph.startDate ? ph.startDate.slice(0, 10) : '',
      endDate: ph.endDate ? ph.endDate.slice(0, 10) : '',
      assigneeId: ph.assignee?.id ?? '',
    })
    setEditing(ph)
  }

  const deletePhase = async (ph) => {
    const note = ph.materials.length
      ? '\n\nMaterials drawn by this phase will be returned to stock.' : ''
    if (!window.confirm(`Delete phase "${ph.name}"? This cannot be undone.${note}`)) return
    setToast(null)
    try { await api(`/projects/phases/${ph.id}`, { method: 'DELETE' }); load() }
    catch (err) { setToast(err.message) }
  }

  const siteEngineers = team.filter((t) => ['SITE', 'SENIOR'].includes(t.role))
  const canTick = can('updates.submit')
  const canDownload = can('media.download')

  const tickInsight = async (ins) => {
    setToast(null)
    try { await api(`/projects/insights/${ins.id}`, { method: 'PATCH', body: { done: !ins.done } }); load() }
    catch (err) { setToast(err.message) }
  }

  const addInsight = async (ph) => {
    const title = (newIns[ph.id] ?? '').trim()
    if (!title) return
    setToast(null)
    try {
      await api(`/projects/phases/${ph.id}/insights`, { method: 'POST', body: { title } })
      setNewIns((s) => ({ ...s, [ph.id]: '' }))
      load()
    } catch (err) { setToast(err.message) }
  }

  const delInsight = async (ins) => {
    setToast(null)
    try { await api(`/projects/insights/${ins.id}`, { method: 'DELETE' }); load() }
    catch (err) { setToast(err.message) }
  }

  const addProof = async (ins, files) => {
    if (!files.length) return
    setToast(null)
    try {
      const form = new FormData()
      for (const f of files) form.append('media', f)
      await api(`/projects/insights/${ins.id}/proof`, { method: 'POST', form })
      load()
    } catch (err) { setToast(err.message) }
  }

  return (
    <>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <select value={projectId ?? ''} onChange={(e) => setProjectId(+e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 13.5 }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {canEdit && <span className="small muted">Drag cards between columns to change stage</span>}
        </div>
        {canEdit && project && <button className="btn sm" onClick={() => setCreating(true)}>+ New Phase</button>}
      </div>
      {toast && <div className="error-note">{toast}</div>}

      {project ? (
        <div className="kanban">
          {COLS.map((col) => {
            const items = project.phases.filter((p) => p.status === col.key)
            return (
              <div className={`kanban-col ${overCol === col.key && dragging ? 'dragover' : ''}`} key={col.key}
                onDragOver={(e) => { if (dragging) { e.preventDefault(); setOverCol(col.key) } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverCol(null) }}
                onDrop={(e) => {
                  e.preventDefault()
                  setOverCol(null)
                  if (dragging && dragging.status !== col.key) {
                    if (dragging.status === 'done' &&
                      !window.confirm(`"${dragging.name}" is signed off. Move it back to ${col.label}? The client will be notified.`)) {
                      setDragging(null)
                      return
                    }
                    patchPhase(dragging.id, { status: col.key })
                  }
                  setDragging(null)
                }}>
                <h4>{col.label} <span>{items.length}</span></h4>
                {items.map((ph) => (
                  <div className={`kcard ${dragging?.id === ph.id ? 'dragging' : ''}`} key={ph.id}
                    draggable={canEdit}
                    onDragStart={(e) => {
                      // Don't hijack text selection / clicks inside controls
                      if (e.target.closest('input, textarea, button, label, select, a, img')) {
                        e.preventDefault()
                        return
                      }
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(ph.id))
                      setDragging(ph)
                    }}
                    onDragEnd={() => { setDragging(null); setOverCol(null) }}>
                    <div className="flex-between">
                      <div className="kname">{ph.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                        {ph.status === 'done' && <span className="badge green"><CheckCircle2 size={11} /> Signed off</span>}
                        {canEdit && <>
                          <Pencil size={13} className="kaction" onClick={() => openEdit(ph)} title="Edit phase" />
                          <Trash2 size={13} className="kaction danger" onClick={() => deletePhase(ph)} title="Delete phase" />
                        </>}
                      </div>
                    </div>
                    <div className="kmeta">
                      <span><CalendarDays size={12} /> {fmtDay(ph.startDate)} → {fmtDay(ph.endDate)}</span>
                      <span><UserRound size={12} /> {ph.assignee?.name ?? 'Unassigned'}</span>
                      {showMoney && <span><Banknote size={12} /> {fmtMoney(ph.spent, cur)} / {fmtMoney(ph.budget, cur)}</span>}
                      {showMoney && ph.budget > 0 && ph.spent / ph.budget > ph.percent / 100 + 0.05 && (
                        <span className="badge red" style={{ alignSelf: 'flex-start' }}>Over budget pace</span>
                      )}
                      {ph.status === 'active' && !ph.hasPhotoProof && (
                        <span className="badge amber" style={{ alignSelf: 'flex-start' }}>Photo proof required to close</span>
                      )}
                      {ph.materials.length > 0 && (
                        <span className="muted"><Package size={12} /> {ph.materials.map((m) => `${m.qty.toLocaleString()} ${m.name}`).join(' · ')}</span>
                      )}
                    </div>
                    <div className={`bar ${ph.percent === 100 ? 'green' : ''}`}>
                      <span style={{ width: `${ph.percent}%` }} />
                    </div>

                    {(ph.insights.length > 0 || (canEdit && ph.status !== 'done')) && (
                      <div className="ins-list">
                        {ph.insights.map((ins) => (
                          <div className="ins-row" key={ins.id}>
                            <input type="checkbox" checked={ins.done} disabled={!canTick || ph.status === 'done'}
                              onChange={() => tickInsight(ins)} />
                            <span className={`ins-title ${ins.done ? 'done' : ''}`}
                              title={ins.doneBy ? `Done by ${ins.doneBy}` : ins.title}>
                              {ins.title}
                            </span>
                            <span className="ins-share">{Math.round(100 / ph.insights.length)}%</span>
                            {ins.media.map((m, i) => m.kind === 'photo' ? (
                              <img key={i} className="ins-thumb" src={m.url} alt={m.name}
                                onClick={() => setLightbox({ url: m.url, name: `${ins.title} - proof`, download: canDownload })} />
                            ) : (
                              <a key={i} className="ins-proof" href={m.url} target="_blank" rel="noreferrer" title={m.name}>
                                <FileText size={13} />
                              </a>
                            ))}
                            {canTick && ph.status !== 'done' && (
                              <label className="ins-proof" title="Attach photo proof">
                                <Camera size={13} />
                                <input type="file" hidden multiple accept="image/*,video/*,.pdf"
                                  onChange={(e) => { addProof(ins, [...e.target.files]); e.target.value = '' }} />
                              </label>
                            )}
                            {canEdit && ph.status !== 'done' && (
                              <X size={12} className="ins-del" onClick={() => delInsight(ins)} />
                            )}
                          </div>
                        ))}
                        {canEdit && ph.status !== 'done' && (
                          <div className="ins-add">
                            <input placeholder="Add key insight…" value={newIns[ph.id] ?? ''}
                              onChange={(e) => setNewIns((s) => ({ ...s, [ph.id]: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addInsight(ph))} />
                            <button className="btn ghost sm" onClick={() => addInsight(ph)} title="Add insight">
                              <Plus size={13} />
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {canEdit && ph.status !== 'done' && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                        {ph.status === 'active' && !ph.insights.length && (
                          <input type="number" min="0" max="100" defaultValue={ph.percent}
                            onBlur={(e) => +e.target.value !== ph.percent && patchPhase(ph.id, { percent: +e.target.value })}
                            style={{ width: 62, padding: '4px 7px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 12 }}
                            title="Percent complete" />
                        )}
                        <button className="btn ghost sm" onClick={() => patchPhase(ph.id, { status: col.next })}>
                          {col.action}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      ) : <div className="muted">No project selected.</div>}

      <Lightbox img={lightbox} onClose={() => setLightbox(null)} />

      {(creating || editing) && (
        <Modal title={editing ? `Edit phase - ${editing.name}` : `New phase - ${project.name}`}
          onClose={() => { setCreating(false); setEditing(null); setAll(emptyForm) }}>
          <ErrorNote error={formError} />
          <form onSubmit={savePhase}>
            <Field label="Phase name *"><input value={v.name} onChange={set('name')} required autoFocus /></Field>
            <div className="grid grid-2" style={{ gap: 0, columnGap: 12 }}>
              <Field label="Start date"><input type="date" value={v.startDate} onChange={set('startDate')} /></Field>
              <Field label="End date"><input type="date" value={v.endDate} onChange={set('endDate')} /></Field>
              <Field label={`Budget (${cur})`}><input type="number" min="0" value={v.budget} onChange={set('budget')} /></Field>
              <Field label="Assign to">
                <select value={v.assigneeId} onChange={set('assigneeId')}>
                  <option value="">- Unassigned -</option>
                  {siteEngineers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.role === 'SITE' ? 'Site Eng.' : 'Senior Eng.'})</option>)}
                </select>
              </Field>
              <Field label={`Cost per builder / day (${cur})`}><input type="number" min="0" value={v.costPerBuilder} onChange={set('costPerBuilder')} /></Field>
              <Field label={`Cost per helper / day (${cur})`}><input type="number" min="0" value={v.costPerHelper} onChange={set('costPerHelper')} /></Field>
            </div>
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>
              {editing ? 'Save changes' : 'Create phase'}
            </button>
          </form>
        </Modal>
      )}
    </>
  )
}
