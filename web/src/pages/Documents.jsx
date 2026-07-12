import { useEffect, useRef, useState } from 'react'
import {
  Folder, FolderPlus, Lock, Unlock, Search, List, LayoutGrid, Upload,
  FileText, Film, File, MoreHorizontal, Eye, EyeOff, Pencil, Trash2, Download,
  DraftingCompass, FolderKanban, ChevronRight, ExternalLink,
} from 'lucide-react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Lightbox } from '../ui.jsx'

const SYSTEM_ICON = { Design: DraftingCompass, 'Project Documents': FolderKanban }
const KIND_META = {
  pdf: { icon: FileText, bg: '#fee2e2', color: '#dc2626', label: 'PDF' },
  video: { icon: Film, bg: '#ede9fe', color: '#7c3aed', label: 'Video' },
  file: { icon: File, bg: '#f3f4f6', color: '#4b5563', label: 'File' },
}

const fmtCreated = (iso) =>
  'Created at ' + new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

export default function Documents() {
  const { user, can } = useAuth()
  const [data, setData] = useState(null)
  const [current, setCurrent] = useState('root')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [view, setView] = useState('grid')
  const [visibility, setVisibility] = useState('public')
  const [openMenu, setOpenMenu] = useState(null) // 'f<id>' | 'd<id>'
  const [error, setError] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const fileRef = useRef(null)
  const currentRef = useRef(current)
  currentRef.current = current

  const load = () =>
    api(`/docs?folder=${currentRef.current}`).then(setData).catch((e) => setError(e.message))
  useEffect(() => { load() }, [current])

  // Close kebab menus on any outside click
  useEffect(() => {
    if (!openMenu) return
    const close = () => setOpenMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenu])

  const canUpload = can('docs.upload')
  const isClient = user.role === 'CLIENT'
  const folder = current === 'root' ? null : data?.folders.find((f) => f.id === +current)

  const act = (fn) => async (...args) => {
    setOpenMenu(null); setError(null)
    try { await fn(...args); await load() } catch (err) { setError(err.message) }
  }

  const uploadFiles = act(async (files) => {
    if (!files.length) return
    const form = new FormData()
    for (const f of files) form.append('files', f)
    form.append('folderId', current)
    form.append('visibility', visibility)
    await api('/docs', { method: 'POST', form })
  })

  const createFolder = act(async () => {
    const name = window.prompt('New folder name')
    if (!name?.trim()) return
    await api('/docs/folders', { method: 'POST', body: { name: name.trim() } })
  })

  const renameFolder = act(async (f) => {
    const name = window.prompt('Rename folder', f.name)
    if (!name || name === f.name) return
    await api(`/docs/folders/${f.id}`, { method: 'PATCH', body: { name } })
  })

  const deleteFolder = act(async (f) => {
    if (!window.confirm(`Delete folder "${f.name}"?`)) return
    await api(`/docs/folders/${f.id}`, { method: 'DELETE' })
  })

  const toggleRestricted = act((f) =>
    api(`/docs/folders/${f.id}`, { method: 'PATCH', body: { restricted: !f.restricted } }))

  const renameDoc = act(async (d) => {
    const name = window.prompt('Rename document', d.name)
    if (!name || name === d.name) return
    await api(`/docs/${d.id}`, { method: 'PATCH', body: { name } })
  })

  const toggleDocVisibility = act((d) =>
    api(`/docs/${d.id}`, { method: 'PATCH', body: { visibility: d.visibility === 'public' ? 'private' : 'public' } }))

  const deleteDoc = act(async (d) => {
    if (!window.confirm(`Delete "${d.name}"?`)) return
    await api(`/docs/${d.id}`, { method: 'DELETE' })
  })

  const openDoc = (d) => {
    if (d.kind === 'image') setLightbox({ url: d.url, name: d.name, download: true })
    else window.open(d.url, '_blank')
  }

  if (error && !data) return <div className="error-note">{error}</div>
  if (!data) return <div className="spin">Loading documents…</div>

  const q = search.trim().toLowerCase()
  const folders = current === 'root'
    ? data.folders.filter((f) => !q || f.name.toLowerCase().includes(q))
    : []
  const documents = data.documents.filter((d) =>
    (!q || d.name.toLowerCase().includes(q)) && (filter === 'all' || d.kind === filter))

  const kebab = (key) => (e) => {
    e.stopPropagation()
    setOpenMenu(openMenu === key ? null : key)
  }

  return (
    <>
      {error && <div className="error-note">{error}</div>}

      {/* Toolbar */}
      <div className="doc-toolbar">
        <div className="doc-search">
          <Search size={15} />
          <input placeholder="Search documents…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="doc-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All types</option>
          <option value="image">Images</option>
          <option value="pdf">PDFs</option>
          <option value="video">Videos</option>
          <option value="file">Other files</option>
        </select>
        <div className="view-toggle">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="List view"><List size={15} /></button>
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="Grid view"><LayoutGrid size={15} /></button>
        </div>
        <div style={{ flex: 1 }} />
        {canUpload && !data.locked && (
          <>
            <select className="doc-filter" value={visibility} onChange={(e) => setVisibility(e.target.value)}
              title="Visibility for new uploads">
              <option value="public">Public</option>
              <option value="private">{isClient ? 'Private (only me)' : 'Private (me + client)'}</option>
            </select>
            <input type="file" multiple hidden ref={fileRef}
              onChange={(e) => { uploadFiles([...e.target.files]); e.target.value = '' }} />
            <button className="btn ghost" onClick={() => fileRef.current.click()}>
              <Upload size={14} /> Upload File
            </button>
            {current === 'root' && (
              <button className="btn" onClick={createFolder}><FolderPlus size={14} /> New Folder</button>
            )}
          </>
        )}
      </div>

      {/* Breadcrumb */}
      <div className="doc-crumb">
        <a className={current === 'root' ? 'here' : ''} onClick={() => setCurrent('root')}>Documents</a>
        {folder && <><ChevronRight size={13} /><a className="here">{folder.name}</a></>}
        {folder?.system && isClient && (
          <button className="btn ghost sm" style={{ marginLeft: 12 }} onClick={() => toggleRestricted(folder)}>
            {folder.restricted ? <><Unlock size={12} /> Open to team</> : <><Lock size={12} /> Restrict to me</>}
          </button>
        )}
        {folder?.system && !isClient && (
          <span className={`badge ${folder.restricted ? 'red' : 'green'}`} style={{ marginLeft: 12 }}>
            {folder.restricted ? 'Client only' : 'Team access'}
          </span>
        )}
      </div>

      {data.locked ? (
        <div className="card locked" style={{ padding: '54px 20px' }}>
          <div className="lock"><Lock size={34} /></div>
          This folder is restricted - only the client can see inside.
        </div>
      ) : (
        <>
          {/* Folders */}
          {folders.length > 0 && (
            <>
              <div className="doc-section">Folders</div>
              <div className="doc-grid">
                {folders.map((f) => {
                  const FIcon = f.system ? (SYSTEM_ICON[f.name] ?? Folder) : Folder
                  const key = `f${f.id}`
                  return (
                    <div className="doc-card folder" key={key}
                      onClick={() => !f.locked && setCurrent(f.id)}
                      style={f.locked ? { opacity: .6, cursor: 'not-allowed' } : {}}>
                      <span className="doc-card-icon" style={{ background: '#fef3c7', color: '#b45309' }}>
                        <FIcon size={20} />
                      </span>
                      <div className="doc-card-body">
                        <b>{f.name}</b>
                        <span>
                          {f.count} file{f.count === 1 ? '' : 's'}
                          {f.system && (f.restricted ? ' · client only' : ' · team')}
                        </span>
                      </div>
                      {f.system
                        ? (f.restricted ? <Lock size={14} color="var(--red)" /> : <Unlock size={14} color="var(--green)" />)
                        : canUpload && (
                          <button className="doc-kebab" onClick={kebab(key)}><MoreHorizontal size={16} /></button>
                        )}
                      {openMenu === key && (
                        <div className="doc-menu" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => renameFolder(f)}><Pencil size={13} /> Rename</button>
                          <button className="danger" onClick={() => deleteFolder(f)}><Trash2 size={13} /> Delete</button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {/* Files */}
          <div className="doc-section">Files</div>
          {view === 'grid' ? (
            <div className="doc-grid">
              {documents.map((d) => {
                const meta = KIND_META[d.kind] ?? KIND_META.file
                const KIcon = meta.icon
                const key = `d${d.id}`
                return (
                  <div className="doc-card" key={key} onClick={() => openDoc(d)}>
                    {d.kind === 'image' ? (
                      <img className="doc-card-thumb" src={d.url} alt="" />
                    ) : (
                      <span className="doc-card-icon" style={{ background: meta.bg, color: meta.color }}>
                        <KIcon size={20} />
                      </span>
                    )}
                    <div className="doc-card-body">
                      <b title={d.name}>{d.name}</b>
                      <span>{fmtCreated(d.createdAt)}</span>
                      <span className={`badge ${d.visibility === 'public' ? 'green' : 'amber'}`} style={{ marginTop: 5, alignSelf: 'flex-start' }}>
                        {d.visibility === 'public' ? <><Eye size={10} /> Public</> : <><EyeOff size={10} /> Private</>}
                      </span>
                    </div>
                    <button className="doc-kebab" onClick={kebab(key)}><MoreHorizontal size={16} /></button>
                    {openMenu === key && (
                      <div className="doc-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setOpenMenu(null); openDoc(d) }}><ExternalLink size={13} /> Open</button>
                        <a href={d.url} download={d.name} onClick={() => setOpenMenu(null)}><Download size={13} /> Download</a>
                        {d.canManage && <>
                          <button onClick={() => renameDoc(d)}><Pencil size={13} /> Rename</button>
                          <button onClick={() => toggleDocVisibility(d)}>
                            {d.visibility === 'public' ? <><EyeOff size={13} /> Make private</> : <><Eye size={13} /> Make public</>}
                          </button>
                          <button className="danger" onClick={() => deleteDoc(d)}><Trash2 size={13} /> Delete</button>
                        </>}
                      </div>
                    )}
                  </div>
                )
              })}
              {!documents.length && (
                <div className="muted small" style={{ padding: '18px 4px' }}>
                  No documents here{canUpload ? ' - upload the first one.' : '.'}
                </div>
              )}
            </div>
          ) : (
            <div className="card table-card">
              <table>
                <thead><tr><th>Document</th><th>Visibility</th><th>Uploaded by</th><th>Date</th><th></th></tr></thead>
                <tbody>
                  {documents.map((d) => {
                    const meta = KIND_META[d.kind] ?? KIND_META.file
                    const KIcon = meta.icon
                    return (
                      <tr key={d.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => openDoc(d)}>
                            {d.kind === 'image'
                              ? <img src={d.url} alt="" className="doc-thumb" />
                              : <span className="doc-icon" style={{ background: meta.bg, color: meta.color }}><KIcon size={16} /></span>}
                            <b>{d.name}</b>
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${d.visibility === 'public' ? 'green' : 'amber'}`}
                            style={d.canManage ? { cursor: 'pointer' } : {}}
                            onClick={() => d.canManage && toggleDocVisibility(d)}>
                            {d.visibility === 'public' ? <><Eye size={11} /> Public</> : <><EyeOff size={11} /> Private</>}
                          </span>
                        </td>
                        <td className="muted">{d.by}{d.mine ? ' (you)' : ''}</td>
                        <td className="muted">{fmtCreated(d.createdAt).replace('Created at ', '')}</td>
                        <td>
                          {d.canManage && (
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                              <Pencil size={13} className="kaction" onClick={() => renameDoc(d)} />
                              <Trash2 size={13} className="kaction danger" onClick={() => deleteDoc(d)} />
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {!documents.length && <tr><td colSpan="5" className="muted">No documents here.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <Lightbox img={lightbox} onClose={() => setLightbox(null)} />
    </>
  )
}
