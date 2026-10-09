import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, UserRound, Banknote, Package, CheckCircle2, Camera, X, Plus, FileText, Pencil, Trash2, BarChart3, FileSpreadsheet, Upload } from 'lucide-react'
import { api, fmtMoney, fmtDay } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Modal, Field, ErrorNote, Lightbox, useForm, useDialog } from '../ui.jsx'

const COLS = [
  { key: 'todo', label: 'To do', action: 'Start phase', next: 'active' },
  { key: 'active', label: 'In progress', action: 'Mark done', next: 'done' },
  { key: 'done', label: 'Done' },
]

export default function Kanban() {
  const { client, can } = useAuth()
  const { confirm } = useDialog()
  const [projects, setProjects] = useState(null)
  const [projectId, setProjectId] = useState(null)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null) // phase being edited
  const [team, setTeam] = useState([])
  const [v, set, setAll] = useForm({ name: '', budget: '', startDate: '', endDate: '', assigneeId: '' })
  // Daily rate per crew type for this phase's crew-cost estimate, keyed by the
  // company's own worker types (builder, technician, cable installer, ...).
  const [rates, setRates] = useState({})
  const [formError, setFormError] = useState(null)
  const [newIns, setNewIns] = useState({}) // draft insight title per phase id
  const [lightbox, setLightbox] = useState(null)
  const [dragging, setDragging] = useState(null) // phase being dragged
  const [overCol, setOverCol] = useState(null) // column hovered during drag
  const [bulkResult, setBulkResult] = useState(null) // { added, skipped[] }
  const bulkRef = useRef(null)
  // Without this a second tap on a slow connection creates the phase twice.
  const [savingPhase, setSavingPhase] = useState(false)

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
  const workerTypes = client?.settings?.workerTypes ?? ['builder', 'helper']
  const label = (t) => t.charAt(0).toUpperCase() + t.slice(1)
  // Hidden from roles that may not see money; their edits must leave rates alone.
  const ratesVisible = !editing || editing.crewRates !== null
  const rateTypes = [...new Set([...workerTypes, ...Object.keys(editing?.crewRates ?? {})])]

  const patchPhase = async (phaseId, body) => {
    setToast(null)
    try {
      await api(`/projects/phases/${phaseId}`, { method: 'PATCH', body })
      load()
    } catch (err) { setToast(err.message) }
  }

  const emptyForm = { name: '', budget: '', startDate: '', endDate: '', assigneeId: '' }

  const savePhase = async (e) => {
    e.preventDefault()
    setFormError(null)
    if (savingPhase) return
    setSavingPhase(true)
    try {
      const body = ratesVisible ? { ...v, crewRates: rates } : v
      if (editing) await api(`/projects/phases/${editing.id}`, { method: 'PATCH', body })
      else await api(`/projects/${project.id}/phases`, { method: 'POST', body })
      setCreating(false); setEditing(null); setAll(emptyForm); setRates({})
      load()
    } catch (err) { setFormError(err.message) } finally { setSavingPhase(false) }
  }

  const openEdit = (ph) => {
    setFormError(null)
    setAll({
      name: ph.name, budget: ph.budget || '',
      startDate: ph.startDate ? ph.startDate.slice(0, 10) : '',
      endDate: ph.endDate ? ph.endDate.slice(0, 10) : '',
      assigneeId: ph.assignee?.id ?? '',
    })
    setRates(ph.crewRates ?? {})
    setEditing(ph)
  }

  const deletePhase = async (ph) => {
    // Only materials drawn via the phase go back to stock - items consumed
    // through daily reports stay consumed.
    const note = ph.materials.some((m) => !m.fromUpdate)
      ? '\n\nMaterials drawn by this phase will be returned to stock.' : ''
    const ok = await confirm(`This cannot be undone.${note}`,
      { title: `Delete phase "${ph.name}"?`, confirmText: 'Delete phase', danger: true })
    if (!ok) return
    setToast(null)
    try { await api(`/projects/phases/${ph.id}`, { method: 'DELETE' }); load() }
    catch (err) { setToast(err.message) }
  }

  // ---- Phase CSV template + bulk upload (rows land in "To do") ----

  const downloadTemplate = () => {
    // One "rate <type>" column per crew type the company uses.
    const rateCols = workerTypes.map((t) => `rate ${t}`)
    const sample = workerTypes.map((_, i) => (i === 0 ? '9000' : i === 1 ? '5000' : ''))
    const csv = [
      ['name', 'startDate', 'endDate', 'budget', ...rateCols].join(','),
      ['Phase 1,2026-08-01,2026-09-15,5000000', ...sample].join(','),
      ['Phase 2,2026-09-16,2026-10-20,3500000', ...workerTypes.map(() => '')].join(','),
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = 'phases-template.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // Minimal CSV parsing with quoted-field support - enough for the template.
  const parseCsvLine = (line) => {
    const out = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (c === '"') inQ = false
        else cur += c
      } else if (c === '"') inQ = true
      else if (c === ',') { out.push(cur); cur = '' }
      else cur += c
    }
    out.push(cur)
    return out.map((s) => s.trim())
  }

  const bulkUpload = async (file) => {
    setToast(null)
    try {
      const text = await file.text()
      const lines = text.split(/\r?\n/).filter((l) => l.trim())
      if (lines.length < 2) throw new Error('The file has no data rows - download the template to see the format')
      const rawHeaders = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase())
      const headers = rawHeaders.map((h) => h.replace(/[^a-z]/g, ''))
      // "rate technician" -> technician. Files from the earlier template carry
      // costPerBuilder / costPerHelper instead.
      const rateCols = rawHeaders.flatMap((h, i) => {
        const m = h.match(/^rate[\s:_-]+(.+)$/)
        if (m) return [[i, m[1].trim()]]
        if (headers[i] === 'costperbuilder') return [[i, 'builder']]
        if (headers[i] === 'costperhelper') return [[i, 'helper']]
        return []
      })
      const col = (h) => headers.indexOf(h)
      if (col('name') === -1) throw new Error('The first line must be the template header (name, startDate, endDate, budget, then one "rate <type>" column per crew type)')
      const rows = lines.slice(1).map((line) => {
        const cells = parseCsvLine(line)
        const pick = (h) => (col(h) === -1 ? '' : cells[col(h)] ?? '')
        return {
          name: pick('name'), startDate: pick('startdate'), endDate: pick('enddate'),
          budget: pick('budget'),
          crewRates: Object.fromEntries(rateCols.map(([i, type]) => [type, cells[i] ?? ''])),
        }
      })
      const r = await api(`/projects/${project.id}/phases/bulk`, { method: 'POST', body: { phases: rows } })
      setBulkResult(r)
      load()
    } catch (err) { setToast(err.message) }
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
        {canEdit && project && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn ghost sm" onClick={downloadTemplate} title="CSV template - uploaded rows land in To do">
              <FileSpreadsheet size={13} /> Template
            </button>
            <input type="file" accept=".csv,text/csv" hidden ref={bulkRef}
              onChange={(e) => { if (e.target.files[0]) bulkUpload(e.target.files[0]); e.target.value = '' }} />
            <button className="btn ghost sm" onClick={() => bulkRef.current.click()}>
              <Upload size={13} /> Bulk upload
            </button>
            <button className="btn sm" onClick={() => setCreating(true)}>+ New Phase</button>
          </div>
        )}
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
                onDrop={async (e) => {
                  e.preventDefault()
                  setOverCol(null)
                  const moved = dragging
                  setDragging(null)
                  if (!moved || moved.status === col.key) return
                  if (moved.status === 'done') {
                    const ok = await confirm(
                      `Move it back to ${col.label}? The client will be notified and the sign-off is reopened.`,
                      { title: `"${moved.name}" is signed off`, confirmText: `Move to ${col.label}` })
                    if (!ok) return
                  }
                  patchPhase(moved.id, { status: col.key })
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
                      {showMoney && ph.spent > 0 && (
                        <span className="muted">
                          {[
                            ph.wagesSpent > 0 && `wages ${fmtMoney(ph.wagesSpent, cur)} (${ph.workerDays} worker-day${ph.workerDays === 1 ? '' : 's'})`,
                            ph.laborSpent > 0 && `crew est. ${fmtMoney(ph.laborSpent, cur)}`,
                            ph.materialsSpent > 0 && `materials ${fmtMoney(ph.materialsSpent, cur)}`,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      {showMoney && ph.budget > 0 && ph.spent / ph.budget > ph.percent / 100 + 0.05 && (
                        <span className="badge red" style={{ alignSelf: 'flex-start' }}>Over budget pace</span>
                      )}
                      {ph.status === 'active' && !ph.hasPhotoProof && (
                        <span className="badge amber" style={{ alignSelf: 'flex-start' }}>Photo proof required to close</span>
                      )}
                      {ph.materials.length > 0 && (
                        <span className="muted"><Package size={12} /> {ph.materials.map((m) => `${m.qty.toLocaleString()} ${m.name}`).join(' · ')}</span>
                      )}
                      {ph.status === 'done' && (
                        <Link to={`/phases/${ph.id}/report`} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                          <BarChart3 size={12} /> View phase report
                        </Link>
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

      {bulkResult && (
        <Modal title="Bulk upload result" onClose={() => setBulkResult(null)}>
          <p style={{ marginBottom: 12 }}>
            <b>{bulkResult.added}</b> phase{bulkResult.added === 1 ? '' : 's'} added to <b>To do</b>.
          </p>
          {bulkResult.skipped?.length > 0 && (
            <>
              <p className="small muted" style={{ marginBottom: 8 }}>Skipped rows - fix them in the file and upload again:</p>
              <div className="small" style={{ display: 'grid', gap: 4, marginBottom: 14 }}>
                {bulkResult.skipped.map((s, i) => (
                  <div key={i}>Line {s.line}: <b>{s.name || '(no name)'}</b> - {s.reason}</div>
                ))}
              </div>
            </>
          )}
          <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setBulkResult(null)}>OK</button>
        </Modal>
      )}

      {(creating || editing) && (
        <Modal title={editing ? `Edit phase - ${editing.name}` : `New phase - ${project.name}`}
          onClose={() => { setCreating(false); setEditing(null); setAll(emptyForm); setRates({}) }}>
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
            </div>
            {ratesVisible && (
              <>
                <div className="small muted" style={{ margin: '4px 0 6px' }}>
                  Daily rate per crew type - estimates crew cost on days without attendance records.
                </div>
                <div className="grid grid-2" style={{ gap: 0, columnGap: 12 }}>
                  {rateTypes.map((t) => (
                    <Field key={t} label={`${label(t)} / day (${cur})`}>
                      <input type="number" min="0" value={rates[t] ?? ''}
                        onChange={(e) => setRates((r) => ({ ...r, [t]: e.target.value }))} />
                    </Field>
                  ))}
                </div>
              </>
            )}
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={savingPhase}>
              {savingPhase ? 'Saving…' : editing ? 'Save changes' : 'Create phase'}
            </button>
          </form>
        </Modal>
      )}
    </>
  )
}
