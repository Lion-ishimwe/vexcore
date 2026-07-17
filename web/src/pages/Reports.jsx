import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Printer, Download, BarChart3, Users, Package, AlertTriangle,
  CheckCircle2, CalendarDays, Banknote, HardHat,
} from 'lucide-react'
import { api, fmtMoney, fmtDay } from '../api.js'
import { useAuth } from '../auth.jsx'
import { Avatar } from '../ui.jsx'

const C = { wages: '#f59e0b', crew: '#8b5cf6', materials: '#2563eb', present: '#16a34a', absent: '#dc2626' }

const TABS = [
  ['overview', 'Overview'],
  ['phases', 'Projects & Phases'],
  ['labor', 'Labor & Attendance'],
  ['materials', 'Materials & Stock'],
]

const day = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return day(d) }
const PRESETS = [
  ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'],
  ['month', 'This month'], ['year', 'This year'], ['custom', 'Custom range'],
]

function csvDownload(name, head, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const text = [head, ...rows].map((l) => l.map(esc).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

function Tile({ label, value, sub, color }) {
  return (
    <div className="card">
      <h3>{label}</h3>
      <div className="big" style={{ fontSize: String(value).length > 12 ? 19 : 22, color }}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

// Weekly stacked bars: wages / crew estimate / materials.
function WeekSpendChart({ series, cur }) {
  if (!series.length) return <div className="muted small">No spend recorded in this range.</div>
  const max = Math.max(...series.map((w) => w.wages + w.crew + w.materials), 1)
  const bw = 34, gap = 14, H = 120
  const W = gap + series.length * (bw + gap)
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(W, 300)} height={H + 36}>
        {series.map((w, i) => {
          const x = gap + i * (bw + gap)
          const total = w.wages + w.crew + w.materials
          const h = (v) => (v / max) * H
          let y = 12 + H
          const seg = (v, color) => {
            if (v <= 0) return null
            y -= h(v)
            return <rect x={x} y={y} width={bw} height={h(v)} fill={color} rx="2" />
          }
          return (
            <g key={w.week}>
              <title>{`Week of ${fmtDay(w.week)} - wages ${fmtMoney(w.wages, cur)} · crew ${fmtMoney(w.crew, cur)} · materials ${fmtMoney(w.materials, cur)} (total ${fmtMoney(total, cur)})`}</title>
              {seg(w.materials, C.materials)}
              {seg(w.crew, C.crew)}
              {seg(w.wages, C.wages)}
              <text x={x + bw / 2} y={H + 26} textAnchor="middle" fontSize="9" fill="#94a3b8">
                {w.week.slice(5).replace('-', '/')}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="legend" style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        <div><span className="dot" style={{ background: C.wages }} />Wages</div>
        <div><span className="dot" style={{ background: C.crew }} />Crew estimate</div>
        <div><span className="dot" style={{ background: C.materials }} />Materials</div>
      </div>
    </div>
  )
}

// Present (green) vs absent (red) per recorded day.
function PresenceChart({ presence }) {
  if (!presence.length) return <div className="muted small">No attendance recorded in this range.</div>
  const max = Math.max(...presence.map((d) => d.present + d.absent), 1)
  const bw = 22, gap = 10, H = 100
  const W = gap + presence.length * (bw + gap)
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(W, 280)} height={H + 34}>
        {presence.map((d, i) => {
          const x = gap + i * (bw + gap)
          const hp = (d.present / max) * H, ha = (d.absent / max) * H
          return (
            <g key={d.day}>
              <title>{`${fmtDay(d.day)} - ${d.present} present · ${d.absent} absent`}</title>
              <rect x={x} y={10 + H - hp} width={bw} height={hp} fill={C.present} rx="2" />
              <rect x={x} y={10 + H - hp - ha} width={bw} height={ha} fill={C.absent} opacity=".55" rx="2" />
              <text x={x + bw / 2} y={H + 24} textAnchor="middle" fontSize="9" fill="#94a3b8">
                {d.day.slice(5).replace('-', '/')}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="legend" style={{ flexDirection: 'row', gap: 16 }}>
        <div><span className="dot" style={{ background: C.present }} />Present</div>
        <div><span className="dot" style={{ background: C.absent, opacity: .55 }} />Absent</div>
      </div>
    </div>
  )
}

// Budget vs actual pair per project on a shared scale.
function ProjectBars({ projects, cur }) {
  const max = Math.max(...projects.map((p) => Math.max(p.budget, p.spent)), 1)
  return projects.map((p) => {
    const over = p.budget > 0 && p.spent > p.budget
    return (
      <div key={p.id} style={{ marginBottom: 14 }}>
        <div className="small" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <b>{p.name}</b>
          <span className="muted">{fmtMoney(p.spent, cur)} / {fmtMoney(p.budget, cur)}</span>
        </div>
        <div className="bar" style={{ marginBottom: 3 }}><span style={{ width: `${Math.min(100, (p.budget / max) * 100)}%`, background: '#94a3b8' }} /></div>
        <div className="bar"><span style={{ width: `${Math.min(100, (p.spent / max) * 100)}%`, background: over ? C.absent : C.present }} /></div>
      </div>
    )
  })
}

export default function Reports() {
  const { client } = useAuth()
  const cur = client?.currency
  const [tab, setTab] = useState('overview')
  const [preset, setPreset] = useState('30')
  const [f, setF] = useState({ from: daysAgo(29), to: day(new Date()), projectId: '', phaseId: '' })
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)

  const applyPreset = (p) => {
    setPreset(p)
    const today = day(new Date())
    if (p === '7') setF((s) => ({ ...s, from: daysAgo(6), to: today }))
    else if (p === '30') setF((s) => ({ ...s, from: daysAgo(29), to: today }))
    else if (p === '90') setF((s) => ({ ...s, from: daysAgo(89), to: today }))
    else if (p === 'month') { const n = new Date(); setF((s) => ({ ...s, from: day(new Date(n.getFullYear(), n.getMonth(), 2)), to: today })) }
    else if (p === 'year') { const n = new Date(); setF((s) => ({ ...s, from: `${n.getFullYear()}-01-01`, to: today })) }
  }

  useEffect(() => {
    const q = new URLSearchParams({ from: f.from, to: f.to })
    if (f.projectId) q.set('projectId', f.projectId)
    if (f.phaseId) q.set('phaseId', f.phaseId)
    api('/reports?' + q).then(setD).catch((e) => setError(e.message))
  }, [f])

  const phaseOptions = useMemo(() =>
    (d?.phases ?? []).filter((ph) => !f.projectId || ph.projectId === +f.projectId), [d, f.projectId])

  if (error) return <div className="error-note">{error}</div>
  if (!d) return <div className="spin">Building reports…</div>
  const k = d.kpis
  const alerts = [
    ...d.phases.filter((p) => p.overPace).map((p) => ({ icon: Banknote, text: `${p.name} (${p.project}) is spending faster than it progresses - ${fmtMoney(p.spent, cur)} for ${p.percent}% complete` })),
    ...d.phases.filter((p) => p.late).map((p) => ({ icon: CalendarDays, text: `${p.name} (${p.project}) is past its planned end date (${fmtDay(p.endDate)})` })),
    ...(d.materials.lowStock.length ? [{ icon: Package, text: `Low stock: ${d.materials.lowStock.join(', ')}` }] : []),
  ]
  return (
    <>
      {/* -------- Global filters: every number below answers for this slice -------- */}
      <div className="rep-filters no-print">
        <select value={preset} onChange={(e) => applyPreset(e.target.value)}>
          {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input type="date" value={f.from} onChange={(e) => { setPreset('custom'); setF((s) => ({ ...s, from: e.target.value })) }} />
        <span className="muted small">→</span>
        <input type="date" value={f.to} onChange={(e) => { setPreset('custom'); setF((s) => ({ ...s, to: e.target.value })) }} />
        <select value={f.projectId} onChange={(e) => setF((s) => ({ ...s, projectId: e.target.value, phaseId: '' }))}>
          <option value="">All projects</option>
          {d.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={f.phaseId} onChange={(e) => setF((s) => ({ ...s, phaseId: e.target.value }))} disabled={!f.projectId}>
          <option value="">{f.projectId ? 'All phases' : 'Pick a project first'}</option>
          {phaseOptions.map((ph) => <option key={ph.id} value={ph.id}>{ph.name}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => window.print()}><Printer size={13} /> Print / PDF</button>
      </div>

      <div className="set-tabs no-print" style={{ marginBottom: 16 }}>
        {TABS.map(([kk, label]) => (
          <button key={kk} className={`set-tab ${tab === kk ? 'on' : ''}`} onClick={() => setTab(kk)}>{label}</button>
        ))}
      </div>

      {/* ---------------- OVERVIEW ---------------- */}
      {tab === 'overview' && (
        <>
          {alerts.length > 0 && (
            <div className="card" style={{ borderLeft: '4px solid #dc2626', marginBottom: 16 }}>
              {alerts.map((a, i) => (
                <div key={i} className="small" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                  <AlertTriangle size={13} style={{ color: '#dc2626', flexShrink: 0 }} /> {a.text}
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-4">
            <Tile label="Spent in range" value={fmtMoney(k.spent, cur)}
              sub={`wages ${fmtMoney(k.wages, cur)} · crew ${fmtMoney(k.crew, cur)} · materials ${fmtMoney(k.materials, cur)}`} />
            <Tile label="Budget used (all time)" value={k.budgetUsedPct != null ? `${k.budgetUsedPct}%` : '-'}
              sub={`${fmtMoney(k.spentAllTime, cur)} of ${fmtMoney(k.budgetTotal, cur)}`}
              color={k.budgetUsedPct > 100 ? 'var(--red)' : undefined} />
            <Tile label="Worker-days" value={k.workerDays} sub={`${k.workersPresent} workers earned wages in range`} />
            <Tile label="Phases" value={`${k.phasesCompleted} completed`}
              sub={k.phasesLate ? `${k.phasesLate} running late` : 'none late'}
              color={k.phasesLate ? 'var(--red)' : 'var(--green)'} />
          </div>
          <div className="grid grid-2 mt">
            <div className="card">
              <h3><BarChart3 size={13} /> Spend per week</h3>
              <div className="mt"><WeekSpendChart series={d.series} cur={cur} /></div>
            </div>
            <div className="card">
              <h3>Budget vs actual per project</h3>
              <div className="mt">
                <div className="small muted" style={{ marginBottom: 10 }}>Grey = budget · green/red = spent to date</div>
                <ProjectBars projects={d.projects} cur={cur} />
              </div>
            </div>
          </div>
        </>
      )}

      {/* ---------------- PROJECTS & PHASES ---------------- */}
      {tab === 'phases' && (
        <div className="card table-card">
          <div className="flex-between" style={{ padding: '14px 16px 0' }}>
            <h3 style={{ margin: 0 }}>Expectation vs reality - money and days</h3>
            <button className="btn ghost sm no-print" onClick={() => csvDownload(
              `phases-${d.from}-to-${d.to}.csv`,
              ['Project', 'Phase', 'Status', 'Complete %', 'Budget', 'Spent', 'Wages', 'Crew est.', 'Materials', 'Variance', 'Planned days', 'Actual days', 'Forecast at completion'],
              d.phases.map((p) => [p.project, p.name, p.status, p.percent, p.budget, p.spent, p.wages, p.crew, p.materials, p.budget - p.spent, p.plannedDays ?? '', p.actualDays, p.forecast ?? '']),
            )}><Download size={12} /> CSV</button>
          </div>
          <table>
            <thead>
              <tr><th>Phase</th><th>Budget</th><th>Spent</th><th>Variance</th><th>Days (plan → actual)</th><th>Progress vs spend</th><th>Forecast</th><th></th></tr>
            </thead>
            <tbody>
              {d.phases.map((p) => {
                const variance = p.budget - p.spent
                const usedPct = p.budget > 0 ? Math.round((p.spent / p.budget) * 100) : null
                return (
                  <tr key={p.id}>
                    <td>
                      <b>{p.name}</b>
                      <div className="small muted">{p.project} · {fmtDay(p.startDate)} → {fmtDay(p.endDate)}</div>
                    </td>
                    <td>{fmtMoney(p.budget, cur)}</td>
                    <td>{fmtMoney(p.spent, cur)}
                      <div className="small muted">w {fmtMoney(p.wages, cur)} · c {fmtMoney(p.crew, cur)} · m {fmtMoney(p.materials, cur)}</div>
                    </td>
                    <td style={{ color: variance < 0 ? 'var(--red)' : 'var(--green)' }}>
                      <b>{variance < 0 ? '−' : '+'}{fmtMoney(Math.abs(variance), cur)}</b>
                    </td>
                    <td>
                      {p.plannedDays != null ? `${p.plannedDays}d` : '-'} → {p.actualDays}d
                      {p.late && <div><span className="badge red">Late</span></div>}
                    </td>
                    <td style={{ minWidth: 130 }}>
                      <div className={`bar ${p.percent === 100 ? 'green' : ''}`}><span style={{ width: `${p.percent}%` }} /></div>
                      <div className="small" style={{ color: p.overPace ? 'var(--red)' : 'var(--muted)' }}>
                        {p.percent}% done · {usedPct != null ? `${usedPct}% of budget` : 'no budget'}
                        {p.overPace && ' ⚠'}
                      </div>
                    </td>
                    <td>
                      {p.status === 'done'
                        ? <span className="badge green"><CheckCircle2 size={11} /> Signed off</span>
                        : p.forecast != null
                          ? <span style={{ color: p.forecast > p.budget && p.budget > 0 ? 'var(--red)' : 'var(--green)' }}>
                              ≈ {fmtMoney(p.forecast, cur)}
                            </span>
                          : <span className="muted small">not started</span>}
                    </td>
                    <td><Link className="small" to={`/phases/${p.id}/report`} style={{ fontWeight: 600 }}>Report →</Link></td>
                  </tr>
                )
              })}
              {!d.phases.length && <tr><td colSpan="8" className="muted">No phases in this selection.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- LABOR & ATTENDANCE ---------------- */}
      {tab === 'labor' && (
        <>
          <div className="grid grid-4">
            <Tile label="Wages paid in range" value={fmtMoney(d.labor.totalPay, cur)} />
            <Tile label="Worker-days" value={d.labor.workerDays} />
            <Tile label="Workers who earned" value={d.labor.workers.length} sub={`of ${d.labor.totalWorkers} active workers`} />
            <Tile label="Avg crew per recorded day" value={d.labor.presence.length ? Math.round(d.labor.presence.reduce((s, x) => s + x.present, 0) / d.labor.presence.length) : 0} />
          </div>
          <div className="card mt">
            <h3><Users size={13} /> Presence per day</h3>
            <div className="mt"><PresenceChart presence={d.labor.presence} /></div>
          </div>
          <div className="card table-card mt">
            <div className="flex-between" style={{ padding: '14px 16px 0' }}>
              <h3 style={{ margin: 0 }}><HardHat size={13} /> Workers in range</h3>
              <button className="btn ghost sm no-print" onClick={() => csvDownload(
                `labor-${d.from}-to-${d.to}.csv`,
                ['Worker', 'Type', 'Days', 'Pay'],
                d.labor.workers.map((w) => [w.name, w.type, w.days, w.pay]),
              )}><Download size={12} /> CSV</button>
            </div>
            <table>
              <thead><tr><th>Worker</th><th>Type</th><th>Days</th><th>Paid</th></tr></thead>
              <tbody>
                {d.labor.workers.map((w, i) => (
                  <tr key={i}>
                    <td><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Avatar name={w.name} photo={w.photo} /><b>{w.name}</b></div></td>
                    <td className="muted">{w.type}</td>
                    <td>{w.days}</td>
                    <td>{fmtMoney(w.pay, cur)}</td>
                  </tr>
                ))}
                {!d.labor.workers.length && <tr><td colSpan="4" className="muted">No wages earned in this range.</td></tr>}
                {d.labor.workers.length > 0 && (
                  <tr><td colSpan="3" style={{ textAlign: 'right' }}><b>Total</b></td><td><b>{fmtMoney(d.labor.totalPay, cur)}</b></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---------------- MATERIALS & STOCK ---------------- */}
      {tab === 'materials' && (
        <>
          <div className="grid grid-4">
            <Tile label="Materials used in range" value={fmtMoney(d.materials.totalCost, cur)} />
            <Tile label="Stock value now" value={fmtMoney(d.materials.stockValue, cur)}
              sub={d.materials.lowStock.length ? `Low: ${d.materials.lowStock.join(', ')}` : 'No low-stock items'} />
            <Tile label="Damaged items reported" value={d.materials.damaged} />
            <Tile label="Pending stock requests" value={d.materials.pendingRequests} />
          </div>
          <div className="card table-card mt">
            <div className="flex-between" style={{ padding: '14px 16px 0' }}>
              <h3 style={{ margin: 0 }}><Package size={13} /> Consumption in range</h3>
              <button className="btn ghost sm no-print" onClick={() => csvDownload(
                `materials-${d.from}-to-${d.to}.csv`,
                ['Item', 'Qty used', 'Drawn via phases', 'Via daily reports', 'Cost'],
                d.materials.items.map((m) => [m.name, m.qty, m.drawn, m.reported, m.cost]),
              )}><Download size={12} /> CSV</button>
            </div>
            <table>
              <thead><tr><th>Item</th><th>Qty used</th><th>Drawn via phases</th><th>Via daily reports</th><th>Cost</th></tr></thead>
              <tbody>
                {d.materials.items.map((m, i) => (
                  <tr key={i}>
                    <td><b>{m.name}</b></td>
                    <td>{m.qty.toLocaleString()}</td>
                    <td className="muted">{m.drawn.toLocaleString()}</td>
                    <td className="muted">{m.reported.toLocaleString()}</td>
                    <td>{fmtMoney(m.cost, cur)}</td>
                  </tr>
                ))}
                {!d.materials.items.length && <tr><td colSpan="5" className="muted">No materials used in this range.</td></tr>}
                {d.materials.items.length > 0 && (
                  <tr><td colSpan="4" style={{ textAlign: 'right' }}><b>Total</b></td><td><b>{fmtMoney(d.materials.totalCost, cur)}</b></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---------------- AUDIT ---------------- */}
    </>
  )
}
