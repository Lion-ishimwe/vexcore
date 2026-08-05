import { useEffect, useRef, useState } from 'react'
import { Lock, FileSpreadsheet, Upload, CheckCircle2, CreditCard, PackageCheck, X, Camera, CameraOff, Warehouse, Pencil, Trash2, ArrowLeftRight, Undo2, AlertTriangle } from 'lucide-react'
import { api, fmtMoney, fmtDate } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Modal, Field, ErrorNote, Avatar, useForm, useDialog } from '../ui.jsx'
import QrScanner from '../QrScanner.jsx'

export default function Stock() {
  const { user, client, can } = useAuth()
  const { confirm, alert, prompt } = useDialog()
  const [items, setItems] = useState(null)
  const [requests, setRequests] = useState([])
  const [damaged, setDamaged] = useState([])
  const [error, setError] = useState(null)
  const [modal, setModal] = useState(null) // 'insert' | 'request' | 'bulk'
  const [iv, iset, isetAll] = useForm({ name: '', category: 'Consumable', qty: '', unit: 'pcs', unitCost: '', serial: '', lowThreshold: '', projectId: '', storeId: '' })
  const [rv, rset, rsetAll] = useForm({ itemName: '', qty: '', note: '', projectId: '' })
  const [formError, setFormError] = useState(null)
  const [projects, setProjects] = useState([])
  const [projF, setProjF] = useState('') // '' all | 'general' | project id
  // stores: a big project can run several stock stores, each with its manager
  const [stores, setStores] = useState([])
  const [storeF, setStoreF] = useState('') // '' all | 'none' unassigned | store id
  const [storeForm, setStoreForm] = useState({ projectId: '', name: '', managerId: '' })
  const [members, setMembers] = useState([]) // for the store-manager picker
  // inter-store transfers: a store that runs short requests from one that has it
  const [transfers, setTransfers] = useState([])
  const [transferable, setTransferable] = useState([]) // other stores' items (minimal view)
  const [tv, tset, tsetAll] = useForm({ itemId: '', toStoreId: '', qty: '', note: '' })
  // bulk upload
  const bulkRef = useRef(null)
  const [bulkProjId, setBulkProjId] = useState('')
  const [bulkStoreId, setBulkStoreId] = useState('')
  const [bulkResult, setBulkResult] = useState(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  // stock issues (proof of consumption): who received what - card-only
  const [issues, setIssues] = useState([])
  const [card, setCard] = useState('')
  const [recipient, setRecipient] = useState(null) // { kind, name, sub, photo } from the card lookup
  const [issueItems, setIssueItems] = useState([]) // { stockItemId, name, unit, qty }
  const [issueDraft, setIssueDraft] = useState({ stockItemId: '', qty: '' })
  const [issueNote, setIssueNote] = useState('')
  const [issueBusy, setIssueBusy] = useState(false)
  const [scanCam, setScanCam] = useState(false) // camera QR scanning in the issue modal
  // returns: unused items coming back from site against the original hand-out
  const [returns, setReturns] = useState([])
  const [retCard, setRetCard] = useState('')
  const [retHolder, setRetHolder] = useState(null) // { person, issues[], outstanding } for that card
  const [retQty, setRetQty] = useState({}) // issueItemId → { good, damaged }
  const [retIssueId, setRetIssueId] = useState(null) // one hand-out at a time
  const [retNote, setRetNote] = useState('')
  const [retBusy, setRetBusy] = useState(false)
  const [retCam, setRetCam] = useState(false)
  // Guards against a slow card lookup landing after a newer one and naming the
  // wrong person on the slip.
  const cardGen = useRef(0)
  const retGen = useRef(0)

  const showMoney = can('stock.amounts')
  const canEdit = can('stock.edit')
  const canApprove = can('stock.approve')
  const canRequest = can('stock.request') || canEdit
  const isStockMgr = user.role === 'STOCK'
  // Stores are created and assigned by the admin / Senior Engineers only.
  const canManageStores = ['CLIENT', 'SENIOR', 'SUPER'].includes(user.role)
  const cur = client?.currency

  const load = () => {
    api('/stock').then(setItems).catch((e) => setError(e.message))
    api('/stock/stores').then(setStores).catch(() => {})
    api('/stock/transfers').then(setTransfers).catch(() => {})
    api('/stock/transferable').then(setTransferable).catch(() => {})
    api('/members').then((ms) => setMembers(ms.filter((m) => m.role === 'STOCK'))).catch(() => {})
    api('/stock/requests').then(setRequests).catch(() => {})
    api('/stock/issues').then(setIssues).catch(() => {})
    api('/stock/returns').then(setReturns).catch(() => {})
    if (can('damaged.view')) api('/stock/damaged').then(setDamaged).catch(() => {})
    api('/projects').then((ps) => setProjects(ps.map((p) => ({ id: p.id, name: p.name })))).catch(() => {})
  }
  useEffect(() => { load() }, [])

  // Live card lookup: as the id is scanned/typed, resolve who it belongs to
  // (worker or team member) - debounced against the server.
  useEffect(() => {
    setRecipient(null)
    const id = card.trim()
    if (!id) return
    // Each lookup carries a generation number: scanning card A then card B used
    // to leave A's slower response naming the recipient while B's id was sent
    // with the issue, crediting the wrong person on a permanent record.
    const mine = ++cardGen.current
    const t = setTimeout(() => {
      api(`/stock/card/${encodeURIComponent(id)}`)
        .then((r) => { if (mine === cardGen.current) setRecipient(r) })
        .catch(() => { if (mine === cardGen.current) setRecipient(null) })
    }, 250)
    return () => clearTimeout(t)
  }, [card])

  // Returns: the same lookup, but it also pulls what this person still holds.
  useEffect(() => {
    setRetHolder(null); setRetQty({}); setRetIssueId(null)
    const id = retCard.trim()
    if (!id) return
    const mine = ++retGen.current
    const t = setTimeout(() => {
      api(`/stock/outstanding/${encodeURIComponent(id)}`)
        .then((r) => {
          if (mine !== retGen.current) return
          setRetHolder(r)
          if (r.issues.length === 1) setRetIssueId(r.issues[0].id)
        })
        .catch(() => { if (mine === retGen.current) setRetHolder(null) })
    }, 250)
    return () => clearTimeout(t)
  }, [retCard])
  useEffect(() => { if (retHolder && retCam) setRetCam(false) }, [retHolder, retCam])

  // Guards the create forms against a second tap on a slow connection, which
  // otherwise inserts the same product twice.
  const [saving, setSaving] = useState(false)

  const insert = async (e) => {
    e.preventDefault(); setFormError(null)
    if (saving) return
    setSaving(true)
    try {
      await api('/stock', { method: 'POST', body: iv })
      setModal(null); isetAll({ name: '', category: 'Consumable', qty: '', unit: 'pcs', unitCost: '', serial: '', lowThreshold: '', projectId: '', storeId: '' })
      load()
    } catch (err) { setFormError(err.message) } finally { setSaving(false) }
  }

  // ---- Stores ----
  const addStore = async (e) => {
    e.preventDefault(); setFormError(null)
    try {
      await api('/stock/stores', { method: 'POST', body: storeForm })
      setStoreForm({ projectId: storeForm.projectId, name: '', managerId: '' })
      load()
    } catch (err) { setFormError(err.message) }
  }
  const setStoreManager = async (s, managerId) => {
    setFormError(null)
    try { await api(`/stock/stores/${s.id}`, { method: 'PATCH', body: { managerId } }); load() }
    catch (err) { setFormError(err.message) }
  }

  // ---- Transfers ----
  const myStore = stores.find((s) => s.managerId === user.id) // the store I manage, if any
  const requestTransfer = async (e) => {
    e.preventDefault(); setFormError(null)
    try {
      await api('/stock/transfers', { method: 'POST', body: tv })
      setModal(null); tsetAll({ itemId: '', toStoreId: '', qty: '', note: '' })
      load()
    } catch (err) { setFormError(err.message) }
  }
  const decideTransfer = async (t, status) => {
    setError(null)
    try { await api(`/stock/transfers/${t.id}`, { method: 'PATCH', body: { status } }); load() }
    catch (err) { setError(err.message) }
  }
  // Who may decide: the source store's manager, or stock.approve (senior/admin)
  const canDecide = (t) => t.status === 'PENDING' && (can('stock.approve') || t.from.managerId === user.id)
  const renameStore = async (s) => {
    const name = await prompt('', s.name, { title: `Rename store "${s.name}"`, confirmText: 'Rename' })
    if (!name || name.trim() === s.name) return
    try { await api(`/stock/stores/${s.id}`, { method: 'PATCH', body: { name: name.trim() } }); load() }
    catch (err) { setFormError(err.message) }
  }
  const deleteStore = async (s) => {
    const ok = await confirm(
      s.items
        ? `Its ${s.items} item${s.items === 1 ? '' : 's'} will move to the project's unassigned stock - nothing is lost.`
        : 'The store is empty, so nothing moves.',
      { title: `Delete store "${s.name}"?`, confirmText: 'Delete store', danger: true })
    if (!ok) return
    try { await api(`/stock/stores/${s.id}`, { method: 'DELETE' }); if (storeF === String(s.id)) setStoreF(''); load() }
    catch (err) { setFormError(err.message) }
  }
  const storesOf = (projectId) => stores.filter((s) => s.projectId === +projectId)

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
      const r = await api('/stock/bulk', { method: 'POST', body: { items: rows, projectId: bulkProjId || undefined, storeId: bulkStoreId || undefined } })
      setBulkResult(r)
      load()
    } catch (err) { setFormError(err.message) } finally { setBulkBusy(false) }
  }

  // ---- Issue items: proof of who received what (card-only) ----
  const openIssue = () => {
    setFormError(null)
    setCard(''); setRecipient(null)
    setIssueItems([]); setIssueDraft({ stockItemId: '', qty: '' }); setIssueNote('')
    setScanCam(false)
    setModal('issue')
  }

  // Camera scan found a code → treat it exactly like a typed card id, and
  // stop the camera once it resolves to a person.
  const onCameraScan = (code) => setCard(code)
  useEffect(() => { if (recipient && scanCam) setScanCam(false) }, [recipient, scanCam])

  const addIssueItem = () => {
    const s = (items ?? []).find((x) => x.id === +issueDraft.stockItemId)
    const qty = Number(issueDraft.qty)
    if (!s || !qty || qty <= 0) return
    if (qty > s.qty) { setFormError(`Only ${s.qty} ${s.unit} of ${s.name} in stock`); return }
    setFormError(null)
    setIssueItems((list) => [...list, { stockItemId: s.id, name: s.name, unit: s.unit, qty }])
    setIssueDraft({ stockItemId: '', qty: '' })
  }

  const submitIssue = async (e) => {
    e.preventDefault()
    setFormError(null)
    if (!recipient) return setFormError("Scan the card's QR code or type the card id first")
    if (!issueItems.length) return setFormError('Add at least one item')
    setIssueBusy(true)
    try {
      await api('/stock/issues', {
        method: 'POST',
        body: {
          cardId: card.trim(),
          items: issueItems.map((i) => ({ stockItemId: i.stockItemId, qty: i.qty })),
          note: issueNote,
        },
      })
      setModal(null)
      load()
    } catch (err) { setFormError(err.message) } finally { setIssueBusy(false) }
  }

  // ---- Returns: unused items coming back from site ----
  // A worker takes 100 bags in the morning and hands the rest back in the
  // afternoon; the hand-back is recorded against the original issue so what
  // they still hold is always known. Good items go back into stock; damaged
  // ones are logged as damaged instead.
  const openReturn = () => {
    setFormError(null)
    setRetCard(''); setRetHolder(null); setRetQty({}); setRetIssueId(null)
    setRetNote(''); setRetCam(false)
    setModal('return')
  }

  const retIssue = retHolder?.issues.find((i) => i.id === retIssueId) ?? null
  const retLine = (id) => retQty[id] ?? { good: '', damaged: '' }
  const setRetLine = (id, key, value) =>
    setRetQty((q) => ({ ...q, [id]: { ...retLine(id), [key]: value } }))

  // "Return everything still out" - the common case at the end of a shift.
  const fillAllOutstanding = () => {
    if (!retIssue) return
    const next = {}
    for (const it of retIssue.items) if (it.outstanding > 0) next[it.id] = { good: String(it.outstanding), damaged: '' }
    setRetQty(next)
  }

  const returnRows = () => {
    const rows = []
    for (const [issueItemId, cell] of Object.entries(retQty)) {
      const good = Number(cell.good) || 0
      const damaged = Number(cell.damaged) || 0
      if (good > 0) rows.push({ issueItemId: +issueItemId, qty: good, condition: 'good' })
      if (damaged > 0) rows.push({ issueItemId: +issueItemId, qty: damaged, condition: 'damaged' })
    }
    return rows
  }

  const submitReturn = async (e) => {
    e.preventDefault()
    setFormError(null)
    if (!retHolder) return setFormError("Scan the card's QR code or type the card id first")
    if (!retIssue) return setFormError('Pick which hand-out the items are coming back from')
    const rows = returnRows()
    if (!rows.length) return setFormError('Enter at least one quantity to return')
    // Mirror the server's rule so the storekeeper is told before submitting.
    for (const it of retIssue.items) {
      const cell = retLine(it.id)
      const total = (Number(cell.good) || 0) + (Number(cell.damaged) || 0)
      if (total > it.outstanding)
        return setFormError(`${it.name}: only ${it.outstanding} ${it.unit} still out`)
    }
    setRetBusy(true)
    try {
      const r = await api('/stock/returns', {
        method: 'POST',
        body: { cardId: retCard.trim(), items: rows, note: retNote },
      })
      setModal(null)
      load()
      setError(null)
      // Damaged goods do not go back into the usable quantity, so say so
      // plainly rather than letting the storekeeper assume everything restocked.
      if (r.damaged?.length)
        await alert(
          `Back into stock: ${r.restocked.join(', ') || 'nothing'}\n\n` +
          `Logged as damaged (NOT restocked): ${r.damaged.join(', ')}`,
          { title: 'Return recorded' })
    } catch (err) { setFormError(err.message) } finally { setRetBusy(false) }
  }

  if (error) return <div className="error-note">{error}</div>
  if (!items) return <div className="spin">Loading stock…</div>
  const visible = items.filter((i) =>
    (!projF || (projF === 'general' ? i.projectId == null : i.projectId === +projF)) &&
    (!storeF || (storeF === 'none' ? i.storeId == null : i.storeId === +storeF)))
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
          {can('stock.issue') && (
            <button className="btn" onClick={openIssue}><PackageCheck size={14} /> Issue items</button>
          )}
          {can('stock.issue') && (
            <button className="btn ghost" onClick={openReturn} title="Record unused items coming back from site">
              <Undo2 size={14} /> Record return
            </button>
          )}
          {canRequest && transferable.length > 0 && stores.length > 0 && (
            <button className="btn ghost sm" onClick={() => { setFormError(null); tsetAll({ itemId: '', toStoreId: myStore ? String(myStore.id) : '', qty: '', note: '' }); setModal('transfer') }}>
              <ArrowLeftRight size={13} /> Request from another store
            </button>
          )}
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
          <div className="sub">
            {items.filter((i) => i.low)
              .map((i) => i.storeName ? `${i.name} (${i.storeName})` : i.name)
              .join(' · ') || 'All levels OK'}
          </div>
        </div>
        <div className="card">
          <h3>Pending requests</h3>
          <div className="big">{requests.filter((r) => r.status === 'PENDING').length}</div>
          <div className="sub">Awaiting Senior Engineer approval</div>
        </div>
      </div>

      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        Inventory
        <select value={projF} onChange={(e) => { setProjF(e.target.value); setStoreF('') }}
          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12.5, fontWeight: 400 }}>
          <option value="">All projects</option>
          <option value="general">General store</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {projF && projF !== 'general' && storesOf(projF).length > 0 && (
          <select value={storeF} onChange={(e) => setStoreF(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12.5, fontWeight: 400 }}>
            <option value="">All stores</option>
            <option value="none">Unassigned</option>
            {storesOf(projF).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <div style={{ flex: 1 }} />
        {canManageStores && canEdit && (
          <button className="btn ghost sm" onClick={() => { setFormError(null); setModal('stores') }}>
            <Warehouse size={13} /> Stores{stores.length ? ` (${stores.length})` : ''}
          </button>
        )}
      </div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Product</th><th>Project</th><th>Store</th><th>Category</th><th>Serial</th><th>Quantity</th>
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
                <td className="muted">{s.storeName ?? '-'}</td>
                <td><span className={`badge ${s.category === 'Machine' ? 'blue' : 'gray'}`}>{s.category}</span></td>
                <td className="muted">{s.serial ?? '-'}</td>
                <td>{s.qty.toLocaleString()} {s.unit}</td>
                {showMoney && <td>{fmtMoney(s.unitCost, cur)}</td>}
                {showMoney && <td><b>{fmtMoney(s.total, cur)}</b></td>}
                <td>{s.low ? <span className="badge red">Low stock</span> : <span className="badge green">OK</span>}</td>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan="9" className="muted">No stock{projF ? ' for this selection' : ' yet'}.</td></tr>}
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

      {transfers.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 16 }}>Store transfers</div>
          <div className="card table-card">
            <table>
              <thead>
                <tr><th>When</th><th>Item</th><th>From</th><th>To</th><th>Requested by</th><th>Status</th></tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.createdAt)}</td>
                    <td><b>{t.qty.toLocaleString()} {t.item.unit} × {t.item.name}</b>{t.note && <div className="small muted">“{t.note}”</div>}</td>
                    <td className="muted">{t.from.name}<div className="small">{t.from.project}</div></td>
                    <td className="muted">{t.to.name}<div className="small">{t.to.project}</div></td>
                    <td className="muted">{t.requestedBy}</td>
                    <td>
                      {canDecide(t) ? (
                        <div style={{ display: 'flex', gap: 5 }}>
                          <button className="btn sm" onClick={() => decideTransfer(t, 'APPROVED')}>Approve</button>
                          <button className="btn ghost sm" onClick={() => decideTransfer(t, 'REJECTED')}>Reject</button>
                        </div>
                      ) : (
                        <span className={`badge ${t.status === 'APPROVED' ? 'green' : t.status === 'PENDING' ? 'amber' : 'red'}`}
                          title={t.decidedBy ? `by ${t.decidedBy}` : ''}>
                          {t.status.charAt(0) + t.status.slice(1).toLowerCase()}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>Issued items - proof of consumption</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr><th>When</th><th>Given to</th><th>Items</th><th>Still out</th>{showMoney && <th>Value</th>}<th>Issued by</th><th>Proof</th></tr>
          </thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(i.createdAt)}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Avatar name={i.recipient.name} photo={i.recipient.photo} />
                    <div><b>{i.recipient.name}</b><div className="small muted">{i.recipient.kind === 'worker' ? i.recipient.sub : (i.recipient.sub || 'team member').toLowerCase()}</div></div>
                  </div>
                </td>
                <td className="small">
                  {i.items.map((it, x) => (
                    <div key={x}>
                      {it.qty.toLocaleString()} {it.unit} × {it.name}
                      {it.returnedQty > 0 && (
                        <span className="muted"> · {it.returnedQty.toLocaleString()} returned</span>
                      )}
                    </div>
                  ))}
                  {i.note && <div className="muted">“{i.note}”</div>}
                </td>
                <td>
                  {i.outstanding > 0
                    ? <span className="badge amber">{i.outstanding.toLocaleString()} out</span>
                    : <span className="badge green"><CheckCircle2 size={10} /> all back</span>}
                </td>
                {showMoney && <td>{fmtMoney(i.total, cur)}</td>}
                <td className="muted">{i.issuedBy}</td>
                <td>
                  {i.viaCard
                    ? <span className="badge blue"><CreditCard size={10} /> card scan</span>
                    : <span className="badge gray">manual pick</span>}
                </td>
              </tr>
            ))}
            {!issues.length && <tr><td colSpan={showMoney ? 7 : 6} className="muted">Nothing issued yet - use “Issue items” to record who received materials.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>Returned items - what came back from site</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr><th>When</th><th>Returned by</th><th>Items</th>{showMoney && <th>Value</th>}<th>Received by</th></tr>
          </thead>
          <tbody>
            {returns.map((rt) => (
              <tr key={rt.id}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(rt.createdAt)}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Avatar name={rt.person.name} photo={rt.person.photo} />
                    <div><b>{rt.person.name}</b><div className="small muted">{rt.person.kind === 'worker' ? rt.person.sub : (rt.person.sub || 'team member').toLowerCase()}</div></div>
                  </div>
                </td>
                <td className="small">
                  {rt.items.map((it, x) => (
                    <div key={x}>
                      {it.qty.toLocaleString()} {it.unit} × {it.name}
                      {it.condition === 'damaged'
                        ? <span className="badge red" style={{ marginLeft: 6 }}><AlertTriangle size={10} /> damaged</span>
                        : <span className="muted"> · back in stock</span>}
                    </div>
                  ))}
                  {rt.note && <div className="muted">“{rt.note}”</div>}
                </td>
                {showMoney && <td>{fmtMoney(rt.total, cur)}</td>}
                <td className="muted">{rt.receivedBy}</td>
              </tr>
            ))}
            {!returns.length && (
              <tr><td colSpan={showMoney ? 5 : 4} className="muted">
                Nothing returned yet - use “Record return” when a worker brings unused items back from site.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal === 'issue' && (
        <Modal title="Issue items - who receives them?" onClose={() => setModal(null)}>
          <ErrorNote error={formError} />
          <form onSubmit={submitIssue}>
            <Field label="Scan the card's QR code with the camera, or type the card id">
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={card} autoFocus placeholder="e.g. C1-ABC234" style={{ flex: 1 }}
                  onChange={(e) => setCard(e.target.value)} />
                <button type="button" className={`btn ${scanCam ? '' : 'ghost'}`} title={scanCam ? 'Stop camera' : 'Scan QR with camera'}
                  onClick={() => setScanCam((s) => !s)}>
                  {scanCam ? <CameraOff size={15} /> : <Camera size={15} />}
                </button>
              </div>
              {scanCam && (
                <div style={{ marginTop: 10 }}>
                  <QrScanner onScan={onCameraScan} />
                  <div className="small muted" style={{ marginTop: 6 }}>Point the camera at the QR code on the card - workers and team members both have one.</div>
                </div>
              )}
            </Field>
            {card.trim() && !recipient && (
              <div className="error-note">Card not recognised yet - keep scanning or check the id.</div>
            )}
            {recipient && (
              <div className="ok-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={14} /> Receiving: <b>{recipient.name}</b>
                <span className="muted small">({recipient.kind === 'worker' ? recipient.sub : recipient.sub.toLowerCase()})</span>
                <span className="badge blue"><CreditCard size={10} /> card</span>
              </div>
            )}

            <Field label="Items to issue (deducted from stock)">
              <div className="item-add">
                <select value={issueDraft.stockItemId}
                  onChange={(e) => setIssueDraft((d) => ({ ...d, stockItemId: e.target.value }))}>
                  <option value="">- Select item -</option>
                  {items.filter((s) => s.qty > 0 && !issueItems.some((x) => x.stockItemId === s.id)).map((s) => (
                    <option key={s.id} value={s.id}>{s.name} · {s.qty.toLocaleString()} {s.unit} left{s.projectId == null ? ' (general store)' : s.storeName ? ` (${s.storeName})` : ''}</option>
                  ))}
                </select>
                <input type="number" min="1" placeholder="Qty" value={issueDraft.qty}
                  onChange={(e) => setIssueDraft((d) => ({ ...d, qty: e.target.value }))} style={{ width: 84 }} />
                <button type="button" className="btn ghost sm" onClick={addIssueItem}>Add</button>
              </div>
              {issueItems.map((i, idx) => (
                <div className="cost-line" key={i.stockItemId}>
                  <span>{i.qty.toLocaleString()} {i.unit} × {i.name}</span>
                  <X size={13} style={{ cursor: 'pointer' }} title="Remove"
                    onClick={() => setIssueItems((l) => l.filter((_, j) => j !== idx))} />
                </div>
              ))}
            </Field>
            <Field label="Note (optional)">
              <input value={issueNote} onChange={(e) => setIssueNote(e.target.value)}
                placeholder="e.g. for block A column casting" />
            </Field>
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={issueBusy}>
              {issueBusy ? 'Recording…' : 'Record issue'}
            </button>
          </form>
        </Modal>
      )}

      {modal === 'return' && (
        <Modal title="Record a return - unused items coming back" onClose={() => setModal(null)}>
          <ErrorNote error={formError} />
          <form onSubmit={submitReturn}>
            <Field label="Scan the card of the person handing the items back">
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={retCard} autoFocus placeholder="e.g. C1-ABC234" style={{ flex: 1 }}
                  onChange={(e) => setRetCard(e.target.value)} />
                <button type="button" className={`btn ${retCam ? '' : 'ghost'}`} title={retCam ? 'Stop camera' : 'Scan QR with camera'}
                  onClick={() => setRetCam((s) => !s)}>
                  {retCam ? <CameraOff size={15} /> : <Camera size={15} />}
                </button>
              </div>
              {retCam && (
                <div style={{ marginTop: 10 }}>
                  <QrScanner onScan={(code) => setRetCard(code)} />
                  <div className="small muted" style={{ marginTop: 6 }}>Point the camera at the QR code on the card.</div>
                </div>
              )}
            </Field>

            {retCard.trim() && !retHolder && (
              <div className="error-note">Card not recognised yet - keep scanning or check the id.</div>
            )}

            {retHolder && retHolder.outstanding === 0 && (
              <div className="ok-note">
                <b>{retHolder.person.name}</b> has nothing outstanding - everything issued to them is already back.
              </div>
            )}

            {retHolder && retHolder.outstanding > 0 && (
              <>
                <div className="ok-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CheckCircle2 size={14} /> Returning from: <b>{retHolder.person.name}</b>
                  <span className="muted small">({retHolder.person.kind === 'worker' ? retHolder.person.sub : retHolder.person.sub.toLowerCase()})</span>
                  <span className="badge amber">{retHolder.outstanding.toLocaleString()} still out</span>
                </div>

                {retHolder.issues.length > 1 && (
                  <Field label="Which hand-out are these items from?">
                    <select value={retIssueId ?? ''} onChange={(e) => { setRetIssueId(+e.target.value || null); setRetQty({}) }}>
                      <option value="">- Select the hand-out -</option>
                      {retHolder.issues.map((i) => (
                        <option key={i.id} value={i.id}>
                          {fmtDate(i.createdAt)} · {i.outstanding.toLocaleString()} still out
                          {i.note ? ` · ${i.note}` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}

                {retIssue && (
                  <Field label="How much is coming back?">
                    <div className="flex-between" style={{ marginBottom: 8 }}>
                      <span className="small muted">Good items go back into stock; damaged ones are logged as damaged instead.</span>
                      <button type="button" className="btn ghost sm" onClick={fillAllOutstanding}>Return everything</button>
                    </div>
                    <table style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left' }}>Item</th>
                          <th style={{ width: 74 }}>Still out</th>
                          <th style={{ width: 92 }}>Good</th>
                          <th style={{ width: 92 }}>Damaged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {retIssue.items.filter((it) => it.outstanding > 0).map((it) => (
                          <tr key={it.id}>
                            <td className="small"><b>{it.name}</b><div className="muted">{it.qty.toLocaleString()} {it.unit} taken</div></td>
                            <td className="small">{it.outstanding.toLocaleString()} {it.unit}</td>
                            <td>
                              <input type="number" min="0" max={it.outstanding} placeholder="0" style={{ width: '100%' }}
                                value={retLine(it.id).good}
                                onChange={(e) => setRetLine(it.id, 'good', e.target.value)} />
                            </td>
                            <td>
                              <input type="number" min="0" max={it.outstanding} placeholder="0" style={{ width: '100%' }}
                                value={retLine(it.id).damaged}
                                onChange={(e) => setRetLine(it.id, 'damaged', e.target.value)} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="small muted" style={{ marginTop: 8 }}>
                      Leave a row empty when nothing of that item is coming back - it stays outstanding against this person.
                    </div>
                  </Field>
                )}

                <Field label="Note (optional)">
                  <input value={retNote} onChange={(e) => setRetNote(e.target.value)}
                    placeholder="e.g. brought back after the afternoon pour" />
                </Field>
                <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={retBusy || !retIssue}>
                  {retBusy ? 'Recording…' : 'Record return'}
                </button>
              </>
            )}
          </form>
        </Modal>
      )}

      {modal === 'insert' && (
        <Modal title="Insert stock" onClose={() => setModal(null)}>
          <ErrorNote error={formError} />
          <form onSubmit={insert}>
            <Field label="Product name *"><input value={iv.name} onChange={iset('name')} required autoFocus /></Field>
            <Field label="Project">
              <select value={iv.projectId} onChange={(e) => { iset('projectId')(e); iset('storeId')({ target: { value: '' } }) }}>
                <option value="">General store (all projects)</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            {iv.projectId && storesOf(iv.projectId).length > 0 && (
              <Field label="Store (this project runs several)">
                <select value={iv.storeId} onChange={iset('storeId')}>
                  <option value="">Unassigned (project-wide)</option>
                  {storesOf(iv.projectId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
            )}
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
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={saving}>
              {saving ? 'Inserting…' : 'Insert'}
            </button>
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
                <select value={bulkProjId} onChange={(e) => { setBulkProjId(e.target.value); setBulkStoreId('') }}>
                  <option value="">General store (all projects)</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              {bulkProjId && storesOf(bulkProjId).length > 0 && (
                <Field label="Store">
                  <select value={bulkStoreId} onChange={(e) => setBulkStoreId(e.target.value)}>
                    <option value="">Unassigned (project-wide)</option>
                    {storesOf(bulkProjId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              )}
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

      {modal === 'transfer' && (
        <Modal title="Request items from another store" onClose={() => setModal(null)}>
          <ErrorNote error={formError} />
          <p className="small muted" style={{ marginBottom: 10 }}>
            Short of something? Ask a store that still has it. The transfer moves the stock
            once that store's manager (or a Senior Engineer / the admin) approves.
          </p>
          <form onSubmit={requestTransfer}>
            <Field label="Item (held by another store) *">
              <select value={tv.itemId} required onChange={tset('itemId')}>
                <option value="">- Select item -</option>
                {transferable.filter((i) => !tv.toStoreId || i.storeId !== +tv.toStoreId).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} · {i.qty.toLocaleString()} {i.unit} in {i.storeName} ({i.projectName})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Deliver to store *">
              <select value={tv.toStoreId} required onChange={tset('toStoreId')}>
                <option value="">- Select store -</option>
                {stores
                  .filter((s) => s.id !== transferable.find((i) => i.id === +tv.itemId)?.storeId)
                  .map((s) => <option key={s.id} value={s.id}>{s.name} ({s.projectName}){s.managerId === user.id ? ' - my store' : ''}</option>)}
              </select>
            </Field>
            <Field label="Quantity *">
              <input type="number" min="1" value={tv.qty} onChange={tset('qty')} required />
            </Field>
            <Field label="Note (optional)">
              <input value={tv.note} onChange={tset('note')} placeholder="e.g. block B ran out of cement" />
            </Field>
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>
              <ArrowLeftRight size={14} /> Submit transfer request
            </button>
          </form>
        </Modal>
      )}

      {modal === 'stores' && (
        <Modal title="Stock stores" onClose={() => setModal(null)}>
          <ErrorNote error={formError} />
          <p className="small muted" style={{ marginBottom: 10 }}>
            A big project can run more than one store (e.g. <i>Main yard</i>, <i>Block B store</i>).
            Each store can have its own Stock Manager, responsible for it and for approving
            transfer requests from other stores.
          </p>
          <form onSubmit={addStore}>
            <div className="item-add">
              <select value={storeForm.projectId} required
                onChange={(e) => setStoreForm((s) => ({ ...s, projectId: e.target.value }))}>
                <option value="">- Project -</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input value={storeForm.name} required placeholder="Store name"
                onChange={(e) => setStoreForm((s) => ({ ...s, name: e.target.value }))} />
              <select value={storeForm.managerId}
                onChange={(e) => setStoreForm((s) => ({ ...s, managerId: e.target.value }))}>
                <option value="">- Manager (optional) -</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button className="btn sm"><Warehouse size={13} /> Add store</button>
            </div>
          </form>
          <div className="card table-card" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Store</th><th>Project</th><th>Manager</th><th>Items</th><th></th></tr></thead>
              <tbody>
                {stores.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b></td>
                    <td className="muted">{s.projectName}</td>
                    <td>
                      <select value={s.managerId ?? ''} onChange={(e) => setStoreManager(s, e.target.value)}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }}>
                        <option value="">- none -</option>
                        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td>{s.items}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn ghost sm" title="Rename" onClick={() => renameStore(s)}><Pencil size={12} /></button>
                        <button className="btn ghost sm" title="Delete" onClick={() => deleteStore(s)}><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!stores.length && <tr><td colSpan="5" className="muted">No stores yet - each project can have one or more.</td></tr>}
              </tbody>
            </table>
          </div>
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
