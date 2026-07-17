import { useEffect, useState } from 'react'
import {
  Search, LayoutGrid, List, Download, MoreHorizontal, Eye, KeyRound, Copy,
  ShieldCheck, ShieldOff, CheckCircle2,
} from 'lucide-react'
import { api, fmtDate, fmtDay } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Modal, Field, ErrorNote, Avatar, useForm } from '../ui.jsx'

const ROLE_LABEL = { CLIENT: 'Admin', SENIOR: 'Senior Engineer', SITE: 'Site Engineer', STOCK: 'Stock Manager', GUEST: 'Guest' }
const ROLE_BADGE = { CLIENT: 'amber', SENIOR: 'blue', SITE: 'gray', STOCK: 'gray', GUEST: 'green' }
const CREATABLE = { CLIENT: ['SENIOR', 'SITE', 'STOCK', 'GUEST'], SENIOR: ['SITE', 'STOCK'] }

export default function Team() {
  const { user } = useAuth()
  const [team, setTeam] = useState(null)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const creatable = CREATABLE[user.role] ?? []
  const [v, set, setAll] = useForm({ name: '', email: '', password: '', role: creatable[0] ?? '' })
  const [formError, setFormError] = useState(null)
  // toolbar state
  const [q, setQ] = useState('')
  const [roleF, setRoleF] = useState('')
  const [faF, setFaF] = useState('')
  const [view, setView] = useState('grid') // grid | list
  // card actions
  const [menuFor, setMenuFor] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [resetFor, setResetFor] = useState(null) // { member, link } | { member, error }
  const [copied, setCopied] = useState(false)

  const load = () => api('/team').then(setTeam).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])

  const create = async (e) => {
    e.preventDefault(); setFormError(null)
    try {
      await api('/team', { method: 'POST', body: v })
      setCreating(false); setAll({ name: '', email: '', password: '', role: creatable[0] ?? '' })
      load()
    } catch (err) { setFormError(err.message) }
  }

  // Owners can reset anyone's password; other roles only those they can create.
  const canReset = (t) => t.id !== user.id &&
    (user.role === 'CLIENT' || (CREATABLE[user.role] ?? []).includes(t.role))

  const resetLink = async (t) => {
    setMenuFor(null); setCopied(false)
    try {
      const r = await api(`/team/${t.id}/reset-link`, { method: 'POST' })
      setResetFor({ member: t, link: `${window.location.origin}/#/login?reset=${r.token}` })
    } catch (err) { setResetFor({ member: t, error: err.message }) }
  }

  const copyLink = () => {
    navigator.clipboard?.writeText(resetFor.link)
    setCopied(true)
  }

  const filtered = (team ?? []).filter((t) =>
    (!q || (t.name + ' ' + t.email).toLowerCase().includes(q.toLowerCase())) &&
    (!roleF || t.role === roleF) &&
    (!faF || (faF === 'on') === !!t.totpEnabled)
  )

  const exportCsv = () => {
    const rows = [
      ['Name', 'Email', 'Role', '2FA', 'Joined'],
      ...filtered.map((t) => [t.name, t.email, ROLE_LABEL[t.role] ?? t.role, t.totpEnabled ? 'On' : 'Off', fmtDay(t.createdAt)]),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = 'bridge-team.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (error) return <div className="error-note">{error}</div>
  if (!team) return <div className="spin">Loading team…</div>

  const roles = [...new Set(team.map((t) => t.role))]

  return (
    <>
      <div className="team-toolbar">
        <div className="tt-search">
          <Search size={14} />
          <input placeholder="Search team member" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={roleF} onChange={(e) => setRoleF(e.target.value)}>
          <option value="">Role - all</option>
          {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}
        </select>
        <select value={faF} onChange={(e) => setFaF(e.target.value)}>
          <option value="">2FA - all</option>
          <option value="on">2FA on</option>
          <option value="off">2FA off</option>
        </select>
        <div className="tt-views">
          <button className={view === 'grid' ? 'on' : ''} title="Card view" onClick={() => setView('grid')}><LayoutGrid size={15} /></button>
          <button className={view === 'list' ? 'on' : ''} title="List view" onClick={() => setView('list')}><List size={15} /></button>
          <button title="Export CSV" onClick={exportCsv}><Download size={15} /></button>
        </div>
        <b className="tt-count">All Members ({filtered.length})</b>
        {creatable.length > 0 && <button className="btn" onClick={() => setCreating(true)}>+ Add Team Member</button>}
      </div>

      {view === 'grid' ? (
        <div className="team-grid">
          {filtered.map((t) => (
            <div className="card tm-card" key={t.id}>
              <div className="tm-top">
                <span className={`badge ${ROLE_BADGE[t.role] ?? 'gray'}`}>
                  <span className="tm-dot" /> {ROLE_LABEL[t.role] ?? t.role}
                </span>
                <button className="tm-more" onClick={() => setMenuFor(menuFor === t.id ? null : t.id)}>
                  <MoreHorizontal size={17} />
                </button>
                {menuFor === t.id && (
                  <>
                    <div className="tm-menu-back" onClick={() => setMenuFor(null)} />
                    <div className="tm-menu">
                      <button onClick={() => { setViewing(t); setMenuFor(null) }}><Eye size={13} /> View more</button>
                      {canReset(t) && (
                        <button onClick={() => resetLink(t)}><KeyRound size={13} /> Reset password</button>
                      )}
                    </div>
                  </>
                )}
              </div>
              <div className="tm-body">
                <Avatar name={t.name} photo={t.photo} />
                <div className="tm-id">
                  <b>{t.name}{t.id === user.id ? ' (you)' : ''}</b>
                  <span>{ROLE_LABEL[t.role] ?? t.role}</span>
                  <span>{t.email}</span>
                </div>
              </div>
              <div className="tm-foot">
                <span className="small muted">Joined {fmtDay(t.createdAt)}</span>
                <span className={`badge ${t.totpEnabled ? 'green' : 'gray'}`}>
                  {t.totpEnabled ? <ShieldCheck size={11} /> : <ShieldOff size={11} />} 2FA {t.totpEnabled ? 'On' : 'Off'}
                </span>
              </div>
            </div>
          ))}
          {!filtered.length && <p className="muted">No team members match.</p>}
        </div>
      ) : (
        <div className="card table-card">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Joined</th></tr></thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Avatar name={t.name} photo={t.photo} /><b>{t.name}</b></td>
                  <td className="muted">{t.email}</td>
                  <td><span className={`badge ${ROLE_BADGE[t.role] ?? 'gray'}`}>{ROLE_LABEL[t.role] ?? t.role}</span></td>
                  <td><span className={`badge ${t.totpEnabled ? 'green' : 'gray'}`}>{t.totpEnabled ? 'On' : 'Off'}</span></td>
                  <td className="muted">{fmtDate(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <Modal title="Add team member" onClose={() => setCreating(false)}>
          <ErrorNote error={formError} />
          <form onSubmit={create}>
            <Field label="Role">
              <select value={v.role} onChange={set('role')}>
                {creatable.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </Field>
            <Field label="Full name *"><input value={v.name} onChange={set('name')} required autoFocus /></Field>
            <Field label="Email *"><input type="email" value={v.email} onChange={set('email')} required /></Field>
            <Field label="Password * (they can change it later)"><input type="password" value={v.password} onChange={set('password')} required minLength={8} /></Field>
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>Create account</button>
          </form>
        </Modal>
      )}

      {viewing && (
        <Modal title="Team member" onClose={() => setViewing(null)}>
          <div className="tm-view">
            <Avatar name={viewing.name} photo={viewing.photo} />
            <div>
              <b style={{ fontSize: 16 }}>{viewing.name}</b>
              <div className="small muted">{viewing.email}</div>
            </div>
          </div>
          <div className="tm-view-rows">
            <div><span>Role</span><b>{ROLE_LABEL[viewing.role] ?? viewing.role}</b></div>
            <div><span>Two-factor auth</span>
              <span className={`badge ${viewing.totpEnabled ? 'green' : 'gray'}`}>{viewing.totpEnabled ? 'On' : 'Off'}</span>
            </div>
            <div><span>Joined</span><b>{fmtDate(viewing.createdAt)}</b></div>
          </div>
        </Modal>
      )}

      {resetFor && (
        <Modal title={`Reset password - ${resetFor.member.name}`} onClose={() => setResetFor(null)}>
          {resetFor.error ? <ErrorNote error={resetFor.error} /> : (
            <>
              <p className="small muted" style={{ marginBottom: 12 }}>
                Share this link with {resetFor.member.name}. It lets them set a new password
                and expires in <b>1 hour</b>. Their current password keeps working until they use it.
              </p>
              <div className="tm-link-box">
                <code>{resetFor.link}</code>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={copyLink}>
                  {copied ? <><CheckCircle2 size={13} /> Copied</> : <><Copy size={13} /> Copy link</>}
                </button>
                <button className="btn ghost" onClick={() => setResetFor(null)}>Close</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  )
}
