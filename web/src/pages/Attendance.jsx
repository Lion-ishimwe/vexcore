import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  UserCheck, UserX, LogIn, LogOut, Lock, Printer, Download, Plus, Pencil, CreditCard,
  MonitorSmartphone, HardHat, Users, BadgeCheck, Hand, FileSpreadsheet, Upload, Play,
} from 'lucide-react'
import { api, fmtDay, fmtMoney, dayInput } from '../api.js'
import { useAuth } from '../auth.jsx'
import { useT } from '../i18n.jsx'
import { Modal, Field, ErrorNote, Avatar, useForm, useDialog } from '../ui.jsx'

const hhmm = (d) => d ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '-'

function MethodBadge({ method, by }) {
  if (!method) return null
  return method === 'auto'
    ? <span className="badge blue" title="Recorded by card tap"><CreditCard size={10} /> auto</span>
    : <span className="badge gray" title={`Recorded by ${by}`}><Hand size={10} /> manual</span>
}

export default function Attendance() {
  const { can, client } = useAuth()
  const { t } = useT()
  const { confirm, prompt } = useDialog()
  const [tab, setTab] = useState('today')
  const [error, setError] = useState(null)

  // today - several sessions can run the same day (one per phase)
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState(null)
  const [sessions, setSessions] = useState(null)
  const [selectedSid, setSelectedSid] = useState(null)
  const [workers, setWorkers] = useState([])
  const [starting, setStarting] = useState(false)
  const [perPhase, setPerPhase] = useState(false)
  const [phaseId, setPhaseId] = useState('')

  // workers tab
  const crewTypes = client?.settings?.workerTypes ?? ['builder', 'helper']
  const [wForm, wSet, wSetAll] = useForm({ name: '', type: crewTypes[0], phone: '', cardId: '', dailyRate: '', projectId: '' })
  const [projF, setProjF] = useState('') // project filter: '' all | 'general' | id
  const [enrolOpen, setEnrolOpen] = useState(false)
  const [bulkResult, setBulkResult] = useState(null) // { added, skipped[] }
  const bulkRef = useRef(null)

  // badges & the single card template
  const [badges, setBadges] = useState(null)
  const [cardWorker, setCardWorker] = useState(null) // worker rendered by the template
  const [cardModal, setCardModal] = useState(false)
  const [cardName, setCardName] = useState('')
  const [cardError, setCardError] = useState(null)

  // issued cards
  const [issued, setIssued] = useState(null)

  // report
  // Local calendar days - toISOString() would shift these by a day outside UTC.
  const [range, setRange] = useState({
    from: dayInput(new Date(Date.now() - 6 * 86400000)),
    to: dayInput(),
  })
  const [report, setReport] = useState(null)

  const canRecord = can('attendance.record')
  const canManage = can('attendance.session')
  const canWorkers = can('workers.manage')

  const projectRef = useRef(projectId)
  projectRef.current = projectId

  const loadSessions = () => {
    if (!projectRef.current) return
    // Tie the response to the project it was asked for. Switching sites while a
    // poll was in flight could otherwise populate the new project's view with
    // the old project's sessions - and the next tap would then be written
    // against a session belonging to the wrong site.
    const asked = projectRef.current
    api(`/attendance/sessions/today?projectId=${asked}`)
      .then((list) => {
        if (projectRef.current !== asked) return
        setSessions(list)
        setSelectedSid((sid) =>
          list.some((s) => s.id === sid) ? sid
            : (list.find((s) => s.mode !== 'closed') ?? list[0])?.id ?? null)
      })
      .catch((e) => { if (projectRef.current === asked) setError(e.message) })
  }
  const loadWorkers = () => api('/attendance/workers').then(setWorkers).catch((e) => setError(e.message))

  useEffect(() => {
    api('/projects').then((ps) => {
      setProjects(ps)
      setProjectId((id) => id ?? ps[0]?.id ?? null)
    }).catch((e) => setError(e.message))
    loadWorkers()
  }, [])

  useEffect(() => {
    setSessions(null)
    loadSessions()
    const t = setInterval(loadSessions, 8000)
    return () => clearInterval(t)
  }, [projectId])

  const act = (fn) => async (...args) => {
    setError(null)
    try { await fn(...args) } catch (err) { setError(err.message) }
  }

  const startSession = act(async () => {
    const body = { projectId }
    if (perPhase && phaseId) body.phaseId = +phaseId
    const s = await api('/attendance/sessions', { method: 'POST', body })
    setStarting(false); setPerPhase(false); setPhaseId('')
    setSelectedSid(s.id)
    loadSessions()
  })

  const setMode = act(async (mode) => {
    await api(`/attendance/sessions/${selectedSid}`, { method: 'PATCH', body: { action: 'mode', mode } })
    loadSessions()
  })

  const closeSession = act(async () => {
    const ok = await confirm('Everyone must be clocked out first. No more taps are accepted once it is closed.',
      { title: 'Close this session for the day?', confirmText: 'Close session' })
    if (!ok) return
    await api(`/attendance/sessions/${selectedSid}`, { method: 'PATCH', body: { action: 'close' } })
    loadSessions()
  })

  const clockOutAll = act(async () => {
    const ok = await confirm('Everyone still clocked in will be clocked out now.',
      { title: 'Clock out everyone?', confirmText: 'Clock out all' })
    if (!ok) return
    await api(`/attendance/sessions/${selectedSid}`, { method: 'PATCH', body: { action: 'outAll' } })
    loadSessions()
  })

  const activateSession = act(async () => {
    await api(`/attendance/sessions/${selectedSid}`, { method: 'PATCH', body: { action: 'activate' } })
    loadSessions()
  })

  const tick = act(async (workerId) => {
    await api(`/attendance/sessions/${selectedSid}/tick`, { method: 'POST', body: { workerId } })
    loadSessions()
  })

  // Enrolling gave no feedback on a slow connection, so a second tap enrolled
  // the same worker twice.
  const [enrolBusy, setEnrolBusy] = useState(false)
  const addWorker = act(async (e) => {
    e.preventDefault()
    if (enrolBusy) return
    setEnrolBusy(true)
    try {
      await api('/attendance/workers', { method: 'POST', body: wForm })
      wSetAll({ name: '', type: crewTypes[0], phone: '', cardId: '', dailyRate: '', projectId: '' })
      setEnrolOpen(false)
      loadWorkers()
    } finally { setEnrolBusy(false) }
  })

  const downloadTemplate = () => {
    const csv = [
      'name,type,phone,dailyRate',
      `Jean Bosco,${crewTypes[0]},+250788000001,9000`,
      `Marie Claire,${crewTypes[1] ?? crewTypes[0]},+250788000002,5000`,
      `Pascal N.,${crewTypes[0]},,`,
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = 'workers-template.csv'
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

  const bulkUpload = act(async (file) => {
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) throw new Error('The file has no data rows - download the template to see the format')
    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''))
    const col = (h) => headers.indexOf(h)
    if (col('name') === -1) throw new Error('The first line must be the template header (name, type, phone, cardId, dailyRate)')
    const rows = lines.slice(1).map((line) => {
      const cells = parseCsvLine(line)
      const pick = (h) => (col(h) === -1 ? '' : cells[col(h)] ?? '')
      return {
        name: pick('name'), type: pick('type'), phone: pick('phone'),
        dailyRate: pick('dailyrate'),
      }
    })
    const r = await api('/attendance/workers/bulk', { method: 'POST', body: { workers: rows } })
    setBulkResult(r)
    loadWorkers()
  })

  const editWorker = act(async (w, patch) => {
    await api(`/attendance/workers/${w.id}`, { method: 'PATCH', body: patch })
    loadWorkers()
  })

  const uploadWorkerPhoto = act(async (w, file) => {
    const form = new FormData()
    form.append('photo', file)
    await api(`/attendance/workers/${w.id}/photo`, { method: 'POST', form })
    loadWorkers()
  })

  const assignCard = async (w) => {
    const cardId = await prompt(
      'Tap the card now if you are using a USB reader, or type the id.',
      w.cardId ?? '', { title: `Card / badge for ${w.name}`, placeholder: 'e.g. C1-ABC234', confirmText: 'Assign card' })
    if (cardId === null) return
    editWorker(w, { cardId })
  }

  const renameWorker = async (w) => {
    const name = await prompt('', w.name, { title: 'Worker name', confirmText: 'Rename' })
    if (name) editWorker(w, { name })
  }

  const loadBadges = act(async () => setBadges(await api('/attendance/workers/badges')))

  const loadIssued = act(async () => setIssued(await api('/attendance/cards')))

  // One template for everyone: pick/type a name, Generate renders their card.
  // Every generation is recorded so the Cards tab keeps the issue history.
  // Workers AND team members share the flow - a team pick posts userId instead.
  const cardCandidates = () => [
    ...(badges?.workers ?? []),
    ...(badges?.team ?? []).map((u) => ({
      id: u.id, name: u.name, cardId: u.cardId, photo: u.photo, qr: u.qr,
      type: u.role === 'CLIENT' ? 'admin' : u.role.toLowerCase(), phone: null, staff: true,
    })),
  ]
  const generateCard = async () => {
    setCardError(null)
    const q = cardName.trim().toLowerCase()
    if (!q) return setCardError('Type or select an employee name')
    const list = cardCandidates()
    const w = list.find((x) => x.name.toLowerCase() === q)
      ?? (list.filter((x) => x.name.toLowerCase().includes(q)).length === 1
        ? list.find((x) => x.name.toLowerCase().includes(q))
        : null)
    if (!w) return setCardError(`No single employee matches "${cardName}" - pick a name from the list`)
    try {
      await api('/attendance/cards', { method: 'POST', body: w.staff ? { userId: w.id } : { workerId: w.id } })
    } catch (err) { return setCardError(err.message) }
    setCardWorker(w)
    setCardModal(false)
    setCardName('')
    setIssued(null) // refresh the Cards tab next time it opens
  }

  // Draw front + back onto a canvas and download as PNG (10 px per mm, CR80).
  const downloadCard = async (c) => {
    const company = (issued ?? badges)?.company ?? ''
    const contact = (issued ?? badges)?.contact ?? ''
    const loadImg = (src) => new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = reject
      im.src = src
    })
    const qrImg = await loadImg(c.qr)
    // Worker photo (optional) - drawn large on the front so the person is
    // recognisable at the gate. Falls back to initials if it fails to load.
    let photoImg = null
    if (c.photo) { try { photoImg = await loadImg(c.photo) } catch { photoImg = null } }
    // Company branding logo (falls back to the amber "B" mark if it fails).
    let brandImg = null
    try { brandImg = await loadImg((issued ?? badges)?.logo || '/logo.png') } catch { brandImg = null }
    const coverDraw = (img, bx, by, bw, bh, r) => {
      ctx.save(); rr(bx, by, bw, bh, r); ctx.clip()
      const scale = Math.max(bw / img.width, bh / img.height)
      const sw = bw / scale, sh = bh / scale
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, bx, by, bw, bh)
      ctx.restore()
    }
    const W = 856, H = 540, GAP = 40, R = 24
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H * 2 + GAP
    const ctx = canvas.getContext('2d')
    const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r) }
    const F = (wgt, px) => `${wgt} ${px}px Poppins, sans-serif`
    const spaced = (s) => s.split('').join('  ') // light letterspacing

    // Blueprint grid + inner drafting frame, shared by both sides
    const sheet = (y0, dark) => {
      ctx.fillStyle = dark ? '#1c2430' : '#ffffff'
      ctx.fillRect(0, y0, W, H)
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.055)' : 'rgba(28,36,48,.05)'
      ctx.lineWidth = 1
      for (let gx = 24; gx < W; gx += 48) { ctx.beginPath(); ctx.moveTo(gx, y0); ctx.lineTo(gx, y0 + H); ctx.stroke() }
      for (let gy = 24; gy < H; gy += 48) { ctx.beginPath(); ctx.moveTo(0, y0 + gy); ctx.lineTo(W, y0 + gy); ctx.stroke() }
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.18)' : 'rgba(28,36,48,.16)'
      rr(16, y0 + 16, W - 32, H - 32, 16); ctx.stroke()
    }
    // Title block: labeled cells like an architect's drawing sheet
    const titleBlock = (y0, cells, dark) => {
      const top = y0 + H - 92, left = 32, right = W - 32
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.16)' : 'rgba(28,36,48,.16)'
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(right, top); ctx.stroke()
      const widths = [0.4, 0.32, 0.28]
      let x = left
      cells.forEach(([label, value], i) => {
        if (i > 0) { ctx.beginPath(); ctx.moveTo(x, top + 10); ctx.lineTo(x, y0 + H - 30); ctx.stroke() }
        const pad = i === 0 ? 4 : 16
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = dark ? '#6b7f96' : '#94a3b8'; ctx.font = F(800, 13)
        ctx.fillText(spaced(label.toUpperCase()), x + pad, top + 32)
        ctx.fillStyle = dark ? '#dbe3ec' : '#1c2430'; ctx.font = F(700, 19)
        const maxw = widths[i] * (right - left) - pad - 12
        let v = value
        while (ctx.measureText(v).width > maxw && v.length > 3) v = v.slice(0, -2) + '…'
        ctx.fillText(v, x + pad, top + 60)
        x += widths[i] * (right - left)
      })
    }

    // ---- FRONT ----
    ctx.save(); rr(1, 1, W - 2, H - 2, R); ctx.clip()
    sheet(0, false)
    // top row - the company's own logo brands the card front
    if (brandImg) {
      coverDraw(brandImg, 40, 34, 46, 46, 12)
    } else {
      ctx.fillStyle = '#f59e0b'; rr(40, 34, 46, 46, 12); ctx.fill()
      ctx.fillStyle = '#1c2430'; ctx.font = F(800, 26); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('B', 63, 58)
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'; ctx.fillStyle = '#10151d'; ctx.font = F(800, 22)
    ctx.fillText(spaced(company.toUpperCase()), 100, 60)
    ctx.font = F(800, 15); ctx.fillStyle = '#b45309'
    const passText = spaced('SITE PASS')
    const ptw = ctx.measureText(passText).width
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2
    rr(W - 44 - ptw - 28, 38, ptw + 28, 36, 18); ctx.stroke()
    ctx.fillText(passText, W - 44 - ptw - 14, 58)
    // divider under header
    ctx.strokeStyle = 'rgba(28,36,48,.12)'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(32, 100); ctx.lineTo(W - 32, 100); ctx.stroke()
    // identity - a real photo when the worker has one, initials otherwise
    let textX = 142
    if (photoImg) {
      // Bus-pass proportions: the portrait fills the card body's left side.
      const bx = 44, by = 116, bw = 180, bh = 224
      ctx.save(); rr(bx, by, bw, bh, 12); ctx.clip()
      const scale = Math.max(bw / photoImg.width, bh / photoImg.height)
      const sw = bw / scale, sh = bh / scale
      ctx.drawImage(photoImg, (photoImg.width - sw) / 2, (photoImg.height - sh) / 2, sw, sh, bx, by, bw, bh)
      ctx.restore()
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 4; rr(bx, by, bw, bh, 12); ctx.stroke()
      textX = 248
    } else {
      ctx.fillStyle = '#fef3c7'; rr(44, 150, 76, 76, 16); ctx.fill()
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; rr(44, 150, 76, 76, 16); ctx.stroke()
      ctx.fillStyle = '#92400e'; ctx.font = F(800, 26); ctx.textAlign = 'center'
      ctx.fillText(c.name.split(' ').map((p) => p[0]).join('').slice(0, 2), 82, 190)
    }
    ctx.textAlign = 'left'; ctx.fillStyle = '#10151d'; ctx.font = F(800, 33)
    ctx.fillText(c.name, textX, 180)
    ctx.fillStyle = '#b45309'; ctx.font = F(800, 15)
    ctx.fillText(spaced('- ' + String(c.type ?? 'worker').toUpperCase()), textX, 214)
    if (c.phone) {
      ctx.fillStyle = '#94a3b8'; ctx.font = F(800, 13)
      ctx.fillText(spaced('TEL'), photoImg ? textX : 44, 292)
      ctx.fillStyle = '#374151'; ctx.font = F(600, 21)
      ctx.fillText(c.phone, photoImg ? textX + 56 : 100, 292)
    }
    // QR stamp box
    ctx.fillStyle = '#ffffff'; rr(W - 44 - 172, 122, 172, 196, 14); ctx.fill()
    ctx.strokeStyle = 'rgba(28,36,48,.18)'; ctx.lineWidth = 2; rr(W - 44 - 172, 122, 172, 196, 14); ctx.stroke()
    ctx.drawImage(qrImg, W - 44 - 158, 136, 144, 144)
    ctx.fillStyle = '#94a3b8'; ctx.font = F(800, 12); ctx.textAlign = 'center'
    ctx.fillText(spaced('SCAN · ATTENDANCE'), W - 44 - 86, 300)
    titleBlock(0, [
      ['Card No', c.cardId],
      ['Issued', new Date(c.createdAt ?? Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })],
      ['System', 'VEXCORE'],
    ], false)
    ctx.restore()
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 2; rr(1, 1, W - 2, H - 2, R); ctx.stroke()

    // ---- BACK ----
    const Y = H + GAP
    ctx.save(); rr(1, Y + 1, W - 2, H - 2, R); ctx.clip()
    sheet(Y, true)
    if (brandImg) {
      coverDraw(brandImg, W / 2 - 46, Y + 96, 92, 92, 22)
    } else {
      ctx.fillStyle = '#f59e0b'; rr(W / 2 - 46, Y + 96, 92, 92, 22); ctx.fill()
      ctx.fillStyle = '#1c2430'; ctx.font = F(800, 50); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('B', W / 2, Y + 144)
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    // Company name, shrunk to fit the card width when it runs long
    let namePx = 29
    ctx.font = F(800, namePx)
    while (ctx.measureText(spaced(company.toUpperCase())).width > W - 90 && namePx > 14) {
      namePx -= 1
      ctx.font = F(800, namePx)
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillText(spaced(company.toUpperCase()), W / 2, Y + 238)
    ctx.fillStyle = '#f59e0b'; ctx.fillRect(W / 2 - 38, Y + 268, 76, 4)
    ctx.fillStyle = '#8fa0b8'; ctx.font = F(700, 13)
    ctx.fillText(spaced('POWERED BY VEXCORE'), W / 2, Y + 302)
    titleBlock(Y, [
      ['Property of', company],
      ['If found', contact || 'Return to site office'],
      ['Card No', c.cardId],
    ], true)
    ctx.restore()

    canvas.toBlob((blob) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${c.name.replace(/\s+/g, '-')}-${c.cardId}.png`
      a.click()
      URL.revokeObjectURL(a.href)
    }, 'image/png')
  }
  const loadReport = act(async () => {
    const q = new URLSearchParams({ from: range.from, to: range.to })
    if (projectId) q.set('projectId', projectId)
    setReport(await api('/attendance/report?' + q))
  })

  const downloadCsv = () => {
    if (!report) return
    const head = ['Worker', 'Type', ...report.days, 'Days', 'Hours', ...(report.money ? ['Pay'] : [])]
    const lines = report.rows.map((row) => [
      row.name, row.type,
      ...report.days.map((d) => {
        const c = row.days[d]
        return c ? `${hhmm(c.in)}-${c.out ? hhmm(c.out) : 'open'} (${c.hours ?? '?'}h ${c.method})` : ''
      }),
      row.daysPresent, row.totalHours,
      ...(report.money ? [row.totalPay ?? 0] : []),
    ])
    if (report.dayTotals) {
      const pad = report.money ? ['', '', ''] : ['', '']
      lines.push(['Present', '', ...report.days.map((d) => report.dayTotals[d]?.present ?? 0), ...pad])
      lines.push(['Absent', '', ...report.days.map((d) => report.dayTotals[d]?.absent ?? 0), ...pad])
    }
    const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `attendance-${report.from}-to-${report.to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const project = projects.find((p) => p.id === projectId)
  const session = sessions?.find((s) => s.id === selectedSid) ?? null
  const recById = new Map((session?.records ?? []).map((r) => [r.workerId, r]))
  const activeWorkers = workers.filter((w) => w.active)
  const inCount = (session?.records ?? []).filter((r) => r.clockInAt).length
  const outCount = (session?.records ?? []).filter((r) => r.clockOutAt).length

  // Shared project filter for the Workers / Badges / Cards tabs
  const matchProj = (x) => !projF || (projF === 'general' ? x.projectId == null : x.projectId === +projF)
  const projFilterSel = (
    <select className="no-print" value={projF} onChange={(e) => setProjF(e.target.value)}
      style={{ padding: '7px 11px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
      <option value="">All projects</option>
      <option value="general">Shared (no project)</option>
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  )

  return (
    <>
      {error && <div className="error-note">{error}</div>}

      <div className="att-tabs no-print">
        {[['today', t('att.today')], ['workers', t('att.workers')], ['badges', t('att.badges')], ['cards', t('att.cards')], ['report', t('att.report')]].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''}
            onClick={() => {
              setTab(k)
              if (k === 'badges') loadBadges()
              if (k === 'cards' && !issued) loadIssued()
              if (k === 'report') loadReport()
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* ---------------- TODAY ---------------- */}
      {tab === 'today' && (
        <>
          <div className="flex-between no-print" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
            <select value={projectId ?? ''} onChange={(e) => setProjectId(+e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 13.5 }}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {session && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Link className="btn ghost sm" to={`/kiosk/${session.id}`} title="Fullscreen card-scan screen for the gate">
                  <MonitorSmartphone size={13} /> {t('att.openKiosk')}
                </Link>
                {canRecord && session.mode === 'out' && !session.paused &&
                  session.records.some((r) => r.clockInAt && !r.clockOutAt) && (
                  <button className="btn ghost sm" onClick={clockOutAll}>
                    <LogOut size={13} /> {t('att.clockOutAll')}
                  </button>
                )}
                {canManage && session.mode !== 'closed' && (
                  <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={closeSession}
                    title="Requires everyone clocked out">
                    <Lock size={13} /> {t('att.closeSession')}
                  </button>
                )}
              </div>
            )}
          </div>

          {sessions === null ? <div className="spin">Loading…</div> : (
            <>
              {sessions.length > 0 && (
                <div className="sess-chips no-print">
                  {sessions.map((s) => (
                    <button key={s.id}
                      className={`sess-chip ${s.id === selectedSid ? 'on' : ''}`}
                      onClick={() => setSelectedSid(s.id)}>
                      {s.phase ?? t('att.wholeProject')}
                      <i className={s.mode === 'closed' ? 'closed' : s.paused ? 'paused' : s.mode}>
                        {s.mode === 'closed' ? 'closed' : s.paused ? 'paused' : `clock-${s.mode}`}
                      </i>
                    </button>
                  ))}
                  {canManage && (
                    <button className="btn ghost sm"
                      onClick={() => { setPerPhase(false); setPhaseId(''); setStarting(true) }}>
                      <Plus size={13} /> {t('att.newSession')}
                    </button>
                  )}
                </div>
              )}

              {sessions.length === 0 && (
                <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                  <UserCheck size={36} color="var(--muted)" style={{ marginBottom: 10 }} />
                  <p className="muted" style={{ marginBottom: 16 }}>No attendance session for {project?.name ?? 'this project'} today.</p>
                  {canManage
                    ? <button className="btn" onClick={() => { setPerPhase(false); setPhaseId(''); setStarting(true) }}><Plus size={14} /> {t('att.startSession')}</button>
                    : <p className="small muted">A client or senior engineer starts the session.</p>}
                </div>
              )}

              {session && (
            <>
              <div className="card att-head">
                <div>
                  <b>{session.project}{session.phase ? ` › ${session.phase}` : ''}</b>
                  <span className="small muted">
                    {fmtDay(session.date)} · opened by {session.openedBy}
                    {session.mode === 'closed' && ` · closed by ${session.closedBy}`}
                  </span>
                  <div className="chips" style={{ marginTop: 8 }}>
                    <span className="chip"><LogIn size={12} /> {inCount} {t('att.in')}</span>
                    <span className="chip"><LogOut size={12} /> {outCount} {t('att.out')}</span>
                  </div>
                </div>
                {session.mode === 'closed' ? (
                  <span className="badge gray" style={{ fontSize: 13, padding: '8px 14px' }}>Session closed</span>
                ) : session.paused ? (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span className="badge gray" style={{ fontSize: 13, padding: '8px 14px' }}>{t('att.paused')}</span>
                    {canRecord && (
                      <button className="btn sm" onClick={activateSession}>
                        <Play size={13} /> {t('att.activate')}
                      </button>
                    )}
                  </div>
                ) : canRecord ? (
                  <div className="mode-toggle" title="Switch what a tap or tick records">
                    <button className={session.mode === 'in' ? 'on in' : ''} onClick={() => setMode('in')}>
                      <LogIn size={14} /> {t('att.clockIn')}
                    </button>
                    <button className={session.mode === 'out' ? 'on out' : ''} onClick={() => setMode('out')}>
                      <LogOut size={14} /> {t('att.clockOut')}
                    </button>
                  </div>
                ) : (
                  <span className={`badge ${session.mode === 'in' ? 'green' : 'amber'}`}>clock-{session.mode}</span>
                )}
              </div>

              <div className="card table-card mt">
                <table>
                  <thead>
                    <tr><th>Worker</th><th>Type</th><th>In</th><th>Out</th><th>Recorded</th>{canRecord && <th></th>}</tr>
                  </thead>
                  <tbody>
                    {activeWorkers.map((w) => {
                      const rec = recById.get(w.id)
                      return (
                        <tr key={w.id}>
                          <td><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Avatar name={w.name} photo={w.photo} /><b>{w.name}</b></div></td>
                          <td><span className="badge gray">{w.type === 'helper' ? <Users size={10} /> : <HardHat size={10} />} {w.type}</span></td>
                          <td>{rec?.clockInAt ? <b style={{ color: 'var(--green)' }}>{hhmm(rec.clockInAt)}</b> : <span className="muted">-</span>}</td>
                          <td>{rec?.clockOutAt ? <b>{hhmm(rec.clockOutAt)}</b> : <span className="muted">-</span>}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 5 }}>
                              {rec?.clockInAt && <MethodBadge method={rec.inMethod} by={rec.inBy} />}
                              {rec?.clockOutAt && <MethodBadge method={rec.outMethod} by={rec.outBy} />}
                            </div>
                          </td>
                          {canRecord && (
                            <td style={{ textAlign: 'right' }}>
                              {session.mode !== 'closed' && !session.paused && (
                                session.mode === 'in' ? (
                                  rec?.clockOutAt ? <span className="badge green"><BadgeCheck size={10} /> done</span> :
                                  <button className={`btn sm ${rec?.clockInAt ? 'ghost' : ''}`} onClick={() => tick(w.id)}>
                                    {rec?.clockInAt ? 'Undo' : 'Clock in'}
                                  </button>
                                ) : (
                                  !rec?.clockInAt ? <span className="muted small">not in</span> :
                                  <button className={`btn sm ${rec?.clockOutAt ? 'ghost' : ''}`} onClick={() => tick(w.id)}>
                                    {rec?.clockOutAt ? 'Undo' : 'Clock out'}
                                  </button>
                                )
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                    {!activeWorkers.length && (
                      <tr><td colSpan="6" className="muted">No workers enrolled yet - add them in the Workers tab.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
              )}
            </>
          )}

          {starting && (
            <Modal title="Start attendance session" onClose={() => setStarting(false)}>
              <p className="small muted" style={{ marginBottom: 12 }}>
                One session is live at a time so card taps go to the right place. Opening another
                phase <b>pauses</b> the current one - it stays open, and you can activate it again
                later (e.g. for its clock-out).
              </p>
              <div className="toggle-row">
                <div>
                  <div className="t-label">Record per phase?</div>
                  <div className="t-sub">Attendance will be tied to one phase (feeds its labor count)</div>
                </div>
                <div className={`switch ${perPhase ? 'on' : ''}`} onClick={() => setPerPhase(!perPhase)} />
              </div>
              {perPhase && (
                <Field label="Phase">
                  <select value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
                    <option value="">- Select phase -</option>
                    {(project?.phases ?? []).map((ph) => <option key={ph.id} value={ph.id}>{ph.name}</option>)}
                  </select>
                </Field>
              )}
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }}
                disabled={perPhase && !phaseId} onClick={startSession}>
                <LogIn size={14} /> Start - clock-in opens
              </button>
            </Modal>
          )}
        </>
      )}

      {/* ---------------- WORKERS ---------------- */}
      {tab === 'workers' && (
        <>
          {canWorkers && (
            <div className="flex-between no-print" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <p className="muted">Enrolment is manual the first time - after that, workers just tap their card.</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {projFilterSel}
                <button className="btn ghost sm" onClick={downloadTemplate}>
                  <FileSpreadsheet size={13} /> Download template
                </button>
                <input type="file" accept=".csv,text/csv" hidden ref={bulkRef}
                  onChange={(e) => { if (e.target.files[0]) bulkUpload(e.target.files[0]); e.target.value = '' }} />
                <button className="btn ghost sm" onClick={() => bulkRef.current.click()}>
                  <Upload size={13} /> Bulk upload
                </button>
                <button className="btn sm" onClick={() => setEnrolOpen(true)}>
                  <Plus size={14} /> {t('att.enrol')}
                </button>
              </div>
            </div>
          )}
          {!canWorkers && <div className="no-print" style={{ marginBottom: 14 }}>{projFilterSel}</div>}
          <div className="card table-card">
            <table>
              <thead><tr><th>Worker</th><th>Project</th><th>Type</th><th>Phone</th><th>Card</th><th>Status</th>{canWorkers && <th></th>}</tr></thead>
              <tbody>
                {workers.filter(matchProj).map((w) => (
                  <tr key={w.id} style={w.active ? {} : { opacity: .5 }}>
                    <td><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      {canWorkers ? (
                        <label className="avatar-upload" title="Click to set this worker's photo">
                          <Avatar name={w.name} photo={w.photo} />
                          <input type="file" accept="image/*"
                            onChange={(e) => { if (e.target.files[0]) uploadWorkerPhoto(w, e.target.files[0]); e.target.value = '' }} />
                        </label>
                      ) : <Avatar name={w.name} photo={w.photo} />}
                      <b>{w.name}</b>
                    </div></td>
                    <td className="muted">{w.projectName ?? 'All projects'}</td>
                    <td>{w.type}</td>
                    <td className="muted">{w.phone ?? '-'}</td>
                    <td>{w.cardId
                      ? <span className="badge blue"><CreditCard size={10} /> {w.cardId}</span>
                      : <span className="badge amber">no card</span>}</td>
                    <td>{w.active ? <span className="badge green">Active</span> : <span className="badge gray">Inactive</span>}</td>
                    {canWorkers && (
                      <td>
                        <div style={{ display: 'flex', gap: 9, justifyContent: 'flex-end' }}>
                          <CreditCard size={14} className="kaction" title="Assign card" onClick={() => assignCard(w)} />
                          <Pencil size={14} className="kaction" title="Rename" onClick={() => renameWorker(w)} />
                          <button className="btn ghost sm" onClick={() => editWorker(w, { active: !w.active })}>
                            {w.active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {!workers.filter(matchProj).length && <tr><td colSpan="7" className="muted">No workers{projF ? ' for this project' : ' yet - enrol one or bulk-upload the template'}.</td></tr>}
              </tbody>
            </table>
          </div>

          {enrolOpen && (
            <Modal title="Enrol a worker" onClose={() => setEnrolOpen(false)}>
              <form onSubmit={addWorker}>
                <Field label="Full name *"><input value={wForm.name} onChange={wSet('name')} required autoFocus /></Field>
                <div className="grid grid-2" style={{ gap: 0, columnGap: 12 }}>
                  <Field label="Type">
                    <select value={wForm.type} onChange={wSet('type')}>
                      {crewTypes.map((t) => (
                        <option key={t} value={t} style={{ textTransform: 'capitalize' }}>
                          {t.charAt(0).toUpperCase() + t.slice(1)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Phone"><input value={wForm.phone} onChange={wSet('phone')} placeholder="+250 …" /></Field>
                </div>
                <div className="grid grid-2" style={{ gap: 0, columnGap: 12 }}>
                  <Field label="Project">
                    <select value={wForm.projectId} onChange={wSet('projectId')}>
                      <option value="">All projects</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Daily rate (optional)">
                    <input type="number" min="0" value={wForm.dailyRate} onChange={wSet('dailyRate')} />
                  </Field>
                </div>
                <div className="ok-note" style={{ marginBottom: 12 }}>
                  The card/badge id is generated automatically (C{'{company}'}-XXXXXX). To bind a
                  physical RFID card later, use the card action in the workers list.
                </div>
                <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={enrolBusy}>
                  <Plus size={14} /> {enrolBusy ? 'Adding…' : 'Add worker'}
                </button>
              </form>
            </Modal>
          )}

          {bulkResult && (
            <Modal title="Bulk upload result" onClose={() => setBulkResult(null)}>
              <div className="ok-note">
                <b>{bulkResult.added}</b> worker{bulkResult.added === 1 ? '' : 's'} enrolled.
              </div>
              {bulkResult.skipped.length > 0 && (
                <>
                  <p className="small muted" style={{ margin: '10px 0 8px' }}>
                    {bulkResult.skipped.length} row{bulkResult.skipped.length === 1 ? ' was' : 's were'} skipped:
                  </p>
                  <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {bulkResult.skipped.map((s, i) => (
                      <div key={i} className="small" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                        Line {s.line}{s.name ? ` (${s.name})` : ''} - <span style={{ color: 'var(--red)' }}>{s.reason}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }}
                onClick={() => setBulkResult(null)}>
                Done
              </button>
            </Modal>
          )}
        </>
      )}

      {/* ---------------- BADGES ---------------- */}
      {tab === 'badges' && (
        <>
          <div className="doc-toolbar no-print">
            {cardWorker ? (
              <button className="btn ghost" onClick={() => setCardWorker(null)}>← All badges</button>
            ) : (
              <p className="muted" style={{ margin: 0 }}>One card template for the whole company - generate a card for any employee.</p>
            )}
            <div style={{ flex: 1 }} />
            {!cardWorker && projFilterSel}
            {!cardWorker && (
              <button className="btn ghost" onClick={() => { setCardError(null); setCardName(''); setCardModal(true) }}>
                <CreditCard size={13} /> Create card
              </button>
            )}
            <button className="btn" onClick={() => window.print()}>
              <Printer size={13} /> {cardWorker ? 'Print card' : 'Print badges'}
            </button>
          </div>
          {!badges ? <div className="spin">Loading…</div> : cardWorker ? (
            (() => {
              const w = cardWorker.staff
                ? cardWorker
                : badges.workers.find((x) => x.id === cardWorker.id) ?? cardWorker
              return (
                <div className="id-card-wrap">
                  <div className="id-pair">
                    <div>
                      <div className="idc-side-label no-print">FRONT</div>
                      <div className="id-card arch">
                        <div className="idc2-top">
                          <img className="idc2-logo" src={badges.logo || '/logo.png'} alt="" />
                          <span className="idc2-company">{badges.company}</span>
                          <span className="idc2-pass">SITE PASS</span>
                        </div>
                        <div className="idc2-body">
                          {/* Large ID-style portrait so the person is recognisable at a glance */}
                          {w.photo && <img className="idc2-photo" src={w.photo} alt={w.name} />}
                          <div className="idc2-left">
                            <div className="idc2-namewrap">
                              {!w.photo && <span className="idc2-init">{w.name.split(' ').map((p) => p[0]).join('').slice(0, 2)}</span>}
                              <div>
                                <b>{w.name}</b>
                                <span className="idc2-role">- {String(w.type ?? 'worker').toUpperCase()}</span>
                              </div>
                            </div>
                            {w.phone && <div className="idc2-tel"><span>TEL</span>{w.phone}</div>}
                          </div>
                          <div className="idc2-stamp">
                            {w.qr && <img src={w.qr} alt="QR" />}
                            <span>SCAN · ATTENDANCE</span>
                          </div>
                        </div>
                        <div className="idc2-block">
                          <div><span>Card No</span><b>{w.cardId}</b></div>
                          <div><span>Issued</span><b>{new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b></div>
                          <div><span>System</span><b>VEXCORE</b></div>
                        </div>
                      </div>
                    </div>
                    <div>
                      <div className="idc-side-label no-print">BACK</div>
                      <div className="id-card arch back2">
                        <div className="idcb2-center">
                          <img className="idc2-logo big" src={badges.logo || '/logo.png'} alt="" />
                          <b>{badges.company?.toUpperCase()}</b>
                          <i className="idcb2-rule" />
                          <span className="idcb2-sub">POWERED BY VEXCORE - PROJECT &amp; SITE MANAGEMENT</span>
                        </div>
                        <div className="idc2-block dark">
                          <div><span>Property of</span><b>{badges.company}</b></div>
                          <div><span>If found</span><b>{badges.contact ?? 'Return to site office'}</b></div>
                          <div><span>Card No</span><b>{w.cardId}</b></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })()
          ) : (
            <div className="badge-sheet">
              {badges.workers.filter(matchProj).map((w) => (
                <div className="worker-badge" key={w.id}>
                  <div className="wb-head">
                    <img className="wb-logo" src={badges.logo || '/logo.png'} alt="" /> {badges.company}
                  </div>
                  {w.photo && <img className="wb-photo" src={w.photo} alt={w.name} />}
                  <b>{w.name}</b>
                  <span className="wb-type">{w.type}{w.phone ? ` · ${w.phone}` : ''}{w.projectName ? ` · ${w.projectName}` : ''}</span>
                  {w.qr ? <img src={w.qr} alt="QR" /> : <div className="wb-nocard">No card assigned</div>}
                  {w.cardId && <code>{w.cardId}</code>}
                </div>
              ))}
              {!badges.workers.filter(matchProj).length && <p className="muted">No active workers{projF ? ' for this project' : ''}.</p>}
            </div>
          )}
          {badges && !cardWorker && badges.team?.length > 0 && (
            <>
              <div className="section-title">Team member badges</div>
              <div className="badge-sheet">
                {badges.team.map((u) => (
                  <div className="worker-badge" key={'u' + u.id}>
                    <div className="wb-head">
                      <img className="wb-logo" src={badges.logo || '/logo.png'} alt="" /> {badges.company}
                    </div>
                    {u.photo && <img className="wb-photo" src={u.photo} alt={u.name} />}
                    <b>{u.name}</b>
                    <span className="wb-type">{u.role === 'CLIENT' ? 'admin' : u.role.toLowerCase()}</span>
                    <img src={u.qr} alt="QR" />
                    <code>{u.cardId}</code>
                  </div>
                ))}
              </div>
            </>
          )}

          {cardModal && (
            <Modal title="Create a card" onClose={() => setCardModal(false)}>
              <ErrorNote error={cardError} />
              <Field label="Employee - select or type the name">
                <input list="card-workers" value={cardName} autoFocus
                  onChange={(e) => setCardName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), generateCard())}
                  placeholder="Start typing…" />
              </Field>
              <datalist id="card-workers">
                {(badges?.workers ?? []).map((w) => <option key={w.id} value={w.name} />)}
                {(badges?.team ?? []).map((u) => <option key={'u' + u.id} value={u.name} />)}
              </datalist>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={generateCard}>
                <CreditCard size={14} /> Generate card
              </button>
            </Modal>
          )}
        </>
      )}

      {/* ---------------- ISSUED CARDS ---------------- */}
      {tab === 'cards' && (
        <>
          <div className="flex-between no-print" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
            <p className="muted">Every generated card, newest first - view it again or download it as an image.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              {projFilterSel}
              <button className="btn ghost sm" onClick={loadIssued}>Refresh</button>
            </div>
          </div>
          {!issued ? <div className="spin">Loading…</div> : (
            <div className="card table-card">
              <table>
                <thead>
                  <tr><th>Employee</th><th>Project</th><th>Card ID</th><th>Type</th><th>Generated by</th><th>Date</th><th></th></tr>
                </thead>
                <tbody>
                  {issued.cards.filter(matchProj).map((c) => (
                    <tr key={c.id} style={c.active ? {} : { opacity: .55 }}>
                      <td><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Avatar name={c.name} photo={c.photo} /><b>{c.name}</b></div></td>
                      <td className="muted">{c.projectName ?? 'Shared'}</td>
                      <td><span className="badge blue"><CreditCard size={10} /> {c.cardId}</span></td>
                      <td>{c.type}</td>
                      <td className="muted">{c.issuedBy}</td>
                      <td className="muted">{fmtDay(c.createdAt)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button className="btn ghost sm"
                            onClick={() => {
                              setCardWorker({ id: c.workerId, name: c.name, type: c.type, phone: c.phone, cardId: c.cardId, qr: c.qr, photo: c.photo })
                              setTab('badges')
                              if (!badges) loadBadges()
                            }}>
                            View
                          </button>
                          <button className="btn sm" onClick={() => downloadCard(c)}>
                            <Download size={12} /> Download
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!issued.cards.filter(matchProj).length && (
                    <tr><td colSpan="7" className="muted">No cards{projF ? ' for this project' : ' generated yet - use "Create card" in the Badges tab'}.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ---------------- REPORT ---------------- */}
      {tab === 'report' && (
        <>
          <div className="doc-toolbar no-print">
            <select value={projectId ?? ''} onChange={(e) => setProjectId(+e.target.value)} className="doc-filter">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="date" className="doc-filter" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            <input type="date" className="doc-filter" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            <button className="btn ghost" onClick={loadReport}>Load</button>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" onClick={downloadCsv} disabled={!report}><Download size={13} /> CSV</button>
            <button className="btn" onClick={() => window.print()} disabled={!report}><Printer size={13} /> Print</button>
          </div>
          {report && (
            <div className="att-sum">
              <span className="pill gray"><Users size={13} /> {report.totalWorkers} active worker{report.totalWorkers === 1 ? '' : 's'}</span>
              <span className="pill green"><UserCheck size={13} /> Present: {report.presentTotal}</span>
              <span className="pill red"><UserX size={13} /> Absent: {report.absentTotal}</span>
            </div>
          )}
          {report && (
            <div className="card table-card" style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Worker</th>
                    {report.days.map((d) => <th key={d}>{new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}</th>)}
                    <th>Days</th><th>Hours</th>
                    {report.money && <th>Pay</th>}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.workerId}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <Avatar name={row.name} photo={row.photo} />
                          <div><b>{row.name}</b><div className="small muted">{row.type}</div></div>
                        </div>
                      </td>
                      {report.days.map((d) => {
                        const c = row.days[d]
                        return (
                          <td key={d}>
                            {c ? (
                              <div className="att-cell" title={`${c.project}${c.phase ? ' › ' + c.phase : ''}`}>
                                {hhmm(c.in)}–{c.out ? hhmm(c.out) : '…'}
                                <span className={`att-dot ${c.method}`}>{c.hours != null ? `${c.hours}h` : 'open'}</span>
                              </div>
                            ) : <span className="muted">·</span>}
                          </td>
                        )
                      })}
                      <td><b>{row.daysPresent}</b></td>
                      <td><b>{row.totalHours}h</b></td>
                      {report.money && <td><b>{fmtMoney(row.totalPay ?? 0, client?.currency)}</b></td>}
                    </tr>
                  ))}
                  {!report.rows.length && <tr><td colSpan={report.days.length + (report.money ? 4 : 3)} className="muted">No attendance in this range.</td></tr>}
                  {report.rows.length > 0 && (
                    <>
                      <tr>
                        <td className="sum-present">Present</td>
                        {report.days.map((d) => <td key={d}><span className="sum-present">{report.dayTotals?.[d]?.present ?? 0}</span></td>)}
                        <td colSpan={report.money ? 3 : 2} />
                      </tr>
                      <tr>
                        <td className="sum-absent">Absent</td>
                        {report.days.map((d) => <td key={d}><span className="sum-absent">{report.dayTotals?.[d]?.absent ?? 0}</span></td>)}
                        <td colSpan={report.money ? 3 : 2} />
                      </tr>
                    </>
                  )}
                  {report.money && report.rows.length > 0 && (
                    <tr>
                      <td colSpan={report.days.length + 3} style={{ textAlign: 'right' }}><b>Total wages</b></td>
                      <td><b>{fmtMoney(report.rows.reduce((s, r) => s + (r.totalPay ?? 0), 0), client?.currency)}</b></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  )
}
