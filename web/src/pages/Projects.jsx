import { useEffect, useState } from 'react'
import { MapPin, Paperclip, Users, Pencil, Trash2 } from 'lucide-react'
import { api, fmtMoney } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Modal, Field, ErrorNote, useForm } from '../ui.jsx'

const statusBadge = { 'In progress': 'blue', Planning: 'gray', Done: 'green' }
const ROLE_LABEL = { SENIOR: 'Senior Engineer', SITE: 'Site Engineer', STOCK: 'Stock Manager', GUEST: 'Guest' }

export default function Projects() {
  const { client, can } = useAuth()
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null) // project being edited
  const [v, set, setAll] = useForm({ name: '', location: '', budget: '', status: 'Planning' })
  const [formError, setFormError] = useState(null)
  // per-project team assignment
  const [teamFor, setTeamFor] = useState(null) // project being edited
  const [staff, setStaff] = useState(null) // assignable client users
  const [picked, setPicked] = useState([])
  const [teamErr, setTeamErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = () => api('/projects').then(setProjects).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])

  const emptyForm = { name: '', location: '', budget: '', status: 'Planning' }

  const save = async (e) => {
    e.preventDefault()
    setFormError(null)
    try {
      if (editing) await api(`/projects/${editing.id}`, { method: 'PATCH', body: v })
      else await api('/projects', { method: 'POST', body: v })
      setCreating(false); setEditing(null); setAll(emptyForm)
      load()
    } catch (err) { setFormError(err.message) }
  }

  const openEdit = (p) => {
    setFormError(null)
    setAll({ name: p.name, location: p.location ?? '', budget: p.budget || '', status: p.status })
    setEditing(p)
  }

  const deleteProject = async (p) => {
    const sure = window.confirm(
      `Delete project "${p.name}"? This permanently removes its phases, daily reports, attendance and team assignments.\n\n` +
      'Workers and stock items assigned to it are kept - they move back to "all projects" / the general store.\n\nThis cannot be undone.'
    )
    if (!sure) return
    setError(null)
    try { await api(`/projects/${p.id}`, { method: 'DELETE' }); load() }
    catch (err) { setError(err.message) }
  }

  const openTeam = async (p) => {
    setTeamErr(null)
    setTeamFor(p)
    setPicked(p.team.map((m) => m.id))
    if (!staff) {
      try {
        const all = await api('/team')
        setStaff(all.filter((u) => ['SENIOR', 'SITE', 'STOCK', 'GUEST'].includes(u.role)))
      } catch (err) { setTeamErr(err.message) }
    }
  }

  const saveTeam = async (e) => {
    e.preventDefault()
    setBusy(true); setTeamErr(null)
    try {
      await api(`/projects/${teamFor.id}/team`, { method: 'PUT', body: { userIds: picked } })
      setTeamFor(null)
      load()
    } catch (err) { setTeamErr(err.message) } finally { setBusy(false) }
  }

  if (error) return <div className="error-note">{error}</div>
  if (!projects) return <div className="spin">Loading projects…</div>
  const showMoney = can('stock.amounts')
  const cur = client?.currency
  const canAssign = can('team.create')

  return (
    <>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <p className="muted">All projects for this account. Each holds its documents, designs, phases, team, stock and workers.</p>
        {can('projects.create') && <button className="btn" onClick={() => setCreating(true)}>+ New Project</button>}
      </div>
      <div className="grid grid-3">
        {projects.map((p) => (
          <div className="card" key={p.id}>
            <div className="flex-between">
              <b style={{ fontSize: 15 }}>{p.name}</b>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span className={`badge ${statusBadge[p.status] ?? 'gray'}`}>{p.status}</span>
                {can('projects.create') && <>
                  <Pencil size={13} className="kaction" title="Edit project" onClick={() => openEdit(p)} />
                  <Trash2 size={13} className="kaction danger" title="Delete project" onClick={() => deleteProject(p)} />
                </>}
              </div>
            </div>
            <div className="sub"><MapPin size={12} /> {p.location ?? '-'}</div>
            <div className="bar mt"><span style={{ width: `${p.percent}%` }} /></div>
            <div className="flex-between mt small">
              <span className="muted">Progress</span><b>{p.percent}%</b>
            </div>
            {showMoney && (
              <div className="flex-between small" style={{ marginTop: 6 }}>
                <span className="muted">Spent / Budget</span>
                <b>{fmtMoney(p.spent, cur)} / {fmtMoney(p.budget, cur)}</b>
              </div>
            )}
            <div className="flex-between small" style={{ marginTop: 6 }}>
              <span className="muted">Phases</span><b>{p.phases.length}</b>
            </div>
            <div className="flex-between small" style={{ marginTop: 6 }}>
              <span className="muted">Team</span>
              <b>{p.team.length ? `${p.team.length} assigned` : 'Admins only'}</b>
            </div>
            {p.team.length > 0 && (
              <div className="chips mt">
                {p.team.map((m) => <span className="chip" key={m.id}>{m.name}</span>)}
              </div>
            )}
            {p.documents.length > 0 && (
              <div className="chips mt">
                {p.documents.map((d) => <span className="chip" key={d}><Paperclip size={11} /> {d}</span>)}
              </div>
            )}
            {canAssign && (
              <button className="btn ghost sm mt" onClick={() => openTeam(p)}>
                <Users size={13} /> Assign team
              </button>
            )}
          </div>
        ))}
        {!projects.length && <div className="muted">No projects yet - create your first one.</div>}
      </div>

      {(creating || editing) && (
        <Modal title={editing ? `Edit project - ${editing.name}` : 'New Project'}
          onClose={() => { setCreating(false); setEditing(null); setAll(emptyForm) }}>
          <ErrorNote error={formError} />
          <form onSubmit={save}>
            <Field label="Project name *"><input value={v.name} onChange={set('name')} required autoFocus /></Field>
            <Field label="Location"><input value={v.location} onChange={set('location')} placeholder="City / site" /></Field>
            <Field label={`Budget (${cur})`}><input type="number" min="0" value={v.budget} onChange={set('budget')} /></Field>
            {editing && (
              <Field label="Status">
                <select value={v.status} onChange={set('status')}>
                  {['Planning', 'In progress', 'Done'].map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
            )}
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>
              {editing ? 'Save changes' : 'Create project'}
            </button>
          </form>
        </Modal>
      )}

      {teamFor && (
        <Modal title={`Team - ${teamFor.name}`} onClose={() => setTeamFor(null)}>
          <ErrorNote error={teamErr} />
          <p className="small muted" style={{ marginBottom: 12 }}>
            Pick who works on this project. Assigned members see only their projects'
            phases, stock, workers and attendance. Members on no project see no projects at all.
          </p>
          {!staff ? <div className="spin">Loading team…</div> : (
            <form onSubmit={saveTeam}>
              <div className="assign-list">
                {staff.map((u) => (
                  <label key={u.id} className="assign-row">
                    <input type="checkbox" checked={picked.includes(u.id)}
                      onChange={(e) => setPicked((s) => e.target.checked ? [...s, u.id] : s.filter((x) => x !== u.id))} />
                    <span className="assign-name"><b>{u.name}</b> <span className="muted small">{ROLE_LABEL[u.role] ?? u.role}</span></span>
                  </label>
                ))}
                {!staff.length && <p className="muted small">No team members yet - add them on the Team page first.</p>}
              </div>
              <button className="btn mt" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
                Save team ({picked.length ? `${picked.length} member${picked.length > 1 ? 's' : ''}` : 'no members - admins only'})
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  )
}
