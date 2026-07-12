import { useEffect, useRef, useState } from 'react'
import { Lock, FileSpreadsheet, Upload, CheckCircle2 } from 'lucide-react'
import { api, fmtMoney, fmtDate } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Modal, Field, ErrorNote, useForm } from '../ui.jsx'

export default function Stock() {
  const { user, client, can } = useAuth()
  const [items, setItems] = useState(null)
  const [requests, setRequests] = useState([])
  const [damaged, setDamaged] = useState([])
  const [error, setError] = useState(null)
  const [modal, setModal] = useState(null) // 'insert' | 'request' | 'bulk'
  const [iv, iset, isetAll] = useForm({ name: '', category: 'Consumable', qty: '', unit: 'pcs', unitCost: '', serial: '', lowThreshold: '', projectId: '' })
  const [rv, rset, rsetAll] = useForm({ itemName: '', qty: '', note: '', projectId: '' })
  const [formError, setFormError] = useState(null)
  const [projects, setProjects] = useState([])
  const [projF, setProjF] = useState('') // '' all | 'general' | project id
  // bulk upload
  const bulkRef = useRef(null)
  const [bulkProjId, setBulkProjId] = useState('')
  const [bulkResult, setBulkResult] = useState(null)
  const [bulkBusy, setBulkBusy] = useState(false)

  const showMoney = can('stock.amounts')
  const canEdit = can('stock.edit')
  const canApprove = can('stock.approve')
  const canRequest = can('stock.request') || canEdit
  const isStockMgr = user.role === 'STOCK'
  const cur = client?.currency

  const load = () => {
    api('/stock').then(setItems).catch((e) => setError(e.message))
    api('/stock/requests').then(setRequests).catch(() => {})
    if (can('damaged.view')) api('/stock/damaged').then(setDamaged).catch(() => {})
    api('/projects').then((ps) => setProjects(ps.map((p) => ({ id: p.id, name: p.name })))).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const insert = async (e) => {
    e.preventDefault(); setFormError(null)
    try {
      await api('/stock', { method: 'POST', body: iv })
      setModal(null); isetAll({ name: '', category: 'Consumable', qty: '', unit: 'pcs', unitCost: '', serial: '', lowThreshold: '', projectId: '' })
      load()
    } catch (err) { setFormError(err.message) }
  }

  const request = async (e) => {
    e.preventDefault(); setFormError(null)
    try {
      await api('/stock/requests', { method: 'POST', body: rv })
      setModal(null); rsetAll({ itemName: '', qty: '', note: '', projectId: '' })
      load()
    } catch (err) { setFormError(err.message) }
  }

  const decide = async (id, status) => {
    try { await api(`/stock/requests/${id}`, { method: 'PATCH', body: { status } }); load() }
    catch (err) { setError(err.message) }
  }

  const downloadTemplate = () => {
    const csv = [
      'name,category,qty,unit,unitCost,serial,lowThreshold',
      'Cement (50kg bag),Consumable,200,bags,12000,,20',
      'Iron sheets,Consumable,150,pcs,8500,,30',
      'Concrete mixer,Machine,1,pcs,2500000,CM-2024-001,0',
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = 'stock-template.csv'
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
    setBulkBusy(true); setFormError(null)
    try {
      const text = await file.text()
      const lines = text.split(/\r?\n/).filter((l) => l.trim())
      if (lines.length < 2) throw new Error('The file has no data rows - download the template to see the format')
      const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''))
      const col = (h) => headers.indexOf(h)
      if (col('name') === -1) throw new Error('The first line must be the template header (name, category, qty, unit, unitCost, serial, lowThreshold)')
      const rows = lines.slice(1).map((line) => {
        const cells = parseCsvLine(line)
        const pick = (h) => (col(h) === -1 ? '' : cells[col(h)] ?? '')
        return {
          name: pick('name'), category: pick('category'), qty: pick('qty'),
          unit: pick('unit'), unitCost: pick('unitcost'), serial: pick('serial'),
          lowThreshold: pick('lowthreshold'),
        }
      })
      const r = await api('/stock/bulk', { method: 'POST', body: { items: rows, projectId: bulkProjId || undefined } })
      setBulkResult(r)
      load()
    } catch (err) { setFormError(err.message) } finally { setBulkBusy(false) }
  }

  if (error) return <div className="error-note">{error}</div>
  if (!items) return <div className="spin">Loading stock…</div>
  const visible = items.filter((i) =>
    !projF || (projF === 'general' ? i.projectId == null : i.projectId === +projF))
  const totalValue = showMoney ? visible.reduce((s, i) => s + (i.total ?? 0), 0) : null
  const lowCount = visible.filter((i) => i.low).length
  const projName = (id) => projects.find((p) => p.id === id)?.name

  return (
    <>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <p className="muted">
          Consumables and machines/tools. {isStockMgr && 'Monetary amounts and damaged items are hidden for your role.'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          {canRequest && !canEdit && <button className="btn" onClick={() => setModal('request')}>+ Request Item</button>}
          {canEdit && <>
            <button className="btn ghost sm" onClick={() => setModal('request')}>+ Request</button>
            <button className="btn ghost sm" onClick={() => { setFormError(null); setBulkResult(null); setModal('bulk') }}>
              <Upload size={13} /> Bulk upload
            </button>
            <button className="btn" onClick={() => setModal('insert')}>+ Insert Stock</button>
          </>}
        </div>
      </div>

      <div className="grid grid-3">
        <div className="card">
          <h3>Total stock value</h3>
          <div className="big" style={{ fontSize: totalValue == null ? 20 : 24 }}>{fmtMoney(totalValue, cur)}</div>
          {!showMoney && <div className="sub">Not visible to Stock Manager</div>}
        </div>
        <div className="card">
          <h3>Low-stock alerts</h3>
          <div className="big" style={{ color: lowCount ? 'var(--red)' : 'var(--green)' }}>{lowCount}</div>
          <div className="sub">{items.filter((i) => i.low).map((i) => i.name).join(' · ') || 'All levels OK'}</div>
        </div>
        <div className="card">
          <h3>Pending requests</h3>
          <div className="big">{requests.filter((r) => r.status === 'PENDING').length}</div>
          <div className="sub">Awaiting Senior Engineer approval</div>
        </div>
      </div>

      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        Inventory
        <select value={projF} onChange={(e) => setProjF(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12.5, fontWeight: 400 }}>
          <option value="">All projects</option>
          <option value="general">General store</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Product</th><th>Project</th><th>Category</th><th>Serial</th><th>Quantity</th>
              {showMoney && <th>Unit amount</th>}
              {showMoney && <th>Total</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b></td>
                <td className="muted">{s.projectName ?? 'General'}</td>
                <td><span className={`badge ${s.category === 'Machine' ? 'blue' : 'gray'}`}>{s.category}</span></td>
                <td className="muted">{s.serial ?? '-'}</td>
                <td>{s.qty.toLocaleString()} {s.unit}</td>
                {showMoney && <td>{fmtMoney(s.unitCost, cur)}</td>}
                {showMoney && <td><b>{fmtMoney(s.total, cur)}</b></td>}
                <td>{s.low ? <span className="badge red">Low stock</span> : <span className="badge green">OK</span>}</td>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan="8" className="muted">No stock{projF ? ' for this project' : ' yet'}.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid grid-2 mt">
        <div>
          <div className="section-title" style={{ marginTop: 10 }}>Stock requests</div>
          <div className="card table-card">
            <table>
              <thead><tr><th>Item</th><th>Qty</th><th>By</th><th>Status</th></tr></thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.itemName}</b><div className="small muted">{r.projectName ? `${r.projectName} · ` : ''}{fmtDate(r.createdAt)}{r.note ? ` - ${r.note}` : ''}</div></td>
                    <td>{r.qty}</td>
                    <td>{r.by}</td>
                    <td>
                      {r.status === 'PENDING' && canApprove ? (
                        <div style={{ display: 'flex', gap: 5 }}>
                          <button className="btn sm" onClick={() => decide(r.id, 'APPROVED')}>Approve</button>
                          <button className="btn ghost sm" onClick={() => decide(r.id, 'REJECTED')}>Reject</button>
                        </div>
                      ) : (
                        <span className={`badge ${r.status === 'APPROVED' ? 'green' : r.status === 'PENDING' ? 'amber' : 'red'}`}>
                          {r.status.charAt(0) + r.status.slice(1).toLowerCase()}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {!requests.length && <tr><td colSpan="4" className="muted">No requests.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="section-title" style={{ marginTop: 10 }}>Damaged items</div>
          {!can('damaged.view') ? (
            <div className="card locked" style={{ padding: 30 }}>
              <div className="lock"><Lock size={30} /></div>
              Damaged-item records are not visible to the Stock Manager role.
            </div>
          ) : (
            <div className="card table-card">
              <table>
                <thead><tr><th>Item</th><th>Serial</th><th>Note</th><th>Date</th></tr></thead>
                <tbody>
                  {damaged.map((d) => (
                    <tr key={d.id}>
                      <td><b>{d.name}</b></td>
                      <td className="muted">{d.serial ?? '-'}</td>
                      <td>{d.note}</td>
                      <td className="muted">{fmtDate(d.createdAt)}</td>
                    </tr>
                  ))}
                  {!damaged.length && <tr><td colSpan="4" className="muted">No damaged items recorded.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {modal === 'insert' && (
        <Modal title="Insert stock" onClose={() => setModal(null)}>
          <ErrorNote error={formError} />
          <form onSubmit={insert}>
            <Field label="Product name *"><input value={iv.name} onChange={iset('name')} required autoFocus /></Field>
            <Field label="Project">
              <select value={iv.projectId} onChange={iset('projectId')}>
                <option value="">General store (all projects)</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-2" style={{ gap: 0, columnGap: 12 }}>
              <Field label="Category">
                <select value={iv.category} onChange={iset('category')}>
                  <option>Consumable</option><option>Machine</option>
                </select>
              </Field>
              <Field label="Serial (machines)"><input value={iv.serial} onChange={iset('serial')} placeholder={iv.category === 'Machine' ? 'Required' : 'N/A'} /></Field>
              <Field label="Quantity *"><input type="number" min="0" value={iv.qty} onChange={iset('qty')} required /></Field>
              <Field label="Unit"><input value={iv.unit} onChange={iset('unit')} placeholder="bags, pcs, trucks…" /></Field>
              <Field label={`Unit amount (${cur})`}><input type="number" min="0" value={iv.unitCost} onChange={iset('unitCost')} /></Field>
              <Field label="Low-stock alert below"><input type="number" min="0" value={iv.lowThreshold} onChange={iset('lowThreshold')} /></Field>
            </div>
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>Insert</button>
          </form>
        </Modal>
      )}

      {modal === 'bulk' && (
        <Modal title="Bulk upload stock" onClose={() => setModal(null)}>
          <ErrorNote error={formError} />
          {bulkResult ? (
            <>
              <div className="ok-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={15} /> {bulkResult.added} item{bulkResult.added === 1 ? '' : 's'} inserted
                {bulkResult.skipped.length > 0 && <> - {bulkResult.skipped.length} row{bulkResult.skipped.length === 1 ? '' : 's'} skipped</>}
              </div>
              {bulkResult.skipped.length > 0 && (
                <div className="card table-card" style={{ marginTop: 10 }}>
                  <table>
                    <thead><tr><th>Line</th><th>Name</th><th>Problem</th></tr></thead>
                    <tbody>
                      {bulkResult.skipped.map((s) => (
                        <tr key={s.line}><td>{s.line}</td><td>{s.name || '-'}</td><td className="muted">{s.reason}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button className="btn mt" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setModal(null)}>Done</button>
            </>
          ) : (
            <>
              <p className="small muted" style={{ marginBottom: 12 }}>
                <b>1.</b> Download the template, fill one row per product
                (category is <code>Consumable</code> or <code>Machine</code> - machines need a serial),
                then upload it back.
              </p>
              <Field label="Insert into">
                <select value={bulkProjId} onChange={(e) => setBulkProjId(e.target.value)}>
                  <option value="">General store (all projects)</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <input type="file" accept=".csv,text/csv" hidden ref={bulkRef}
                onChange={(e) => { if (e.target.files[0]) bulkUpload(e.target.files[0]); e.target.value = '' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={downloadTemplate}>
                  <FileSpreadsheet size={14} /> Download template
                </button>
                <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                  onClick={() => bulkRef.current.click()} disabled={bulkBusy}>
                  <Upload size={14} /> {bulkBusy ? 'Uploading…' : 'Upload CSV'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {modal === 'request' && (
        <Modal title="Request stock item" onClose={() => setModal(null)}>
          <ErrorNote error={formError} />
          <form onSubmit={request}>
            <Field label="Item *"><input value={rv.itemName} onChange={rset('itemName')} required autoFocus /></Field>
            <Field label="Project">
              <select value={rv.projectId} onChange={rset('projectId')}>
                <option value="">General</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Quantity *"><input value={rv.qty} onChange={rset('qty')} required placeholder="e.g. 200 bags" /></Field>
            <Field label="Note"><textarea rows="2" value={rv.note} onChange={rset('note')} /></Field>
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>Submit request</button>
          </form>
        </Modal>
      )}
    </>
  )
}
