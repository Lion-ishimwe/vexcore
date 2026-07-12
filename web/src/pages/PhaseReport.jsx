import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Printer, CheckCircle2, Users, Package, CalendarDays, Banknote, HardHat, Camera,
} from 'lucide-react'
import { api, fmtMoney, fmtDay, fmtDate } from '../api.js'

const COLORS = { wages: '#f59e0b', crew: '#8b5cf6', materials: '#2563eb' }

// Donut split into wages / crew estimate / materials segments.
function CostDonut({ segments }) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = 50, c = 2 * Math.PI * r
  let acc = 0
  return (
    <svg viewBox="0 0 120 120" width="132" height="132">
      <circle cx="60" cy="60" r={r} fill="none" stroke="#eef0f3" strokeWidth="14" />
      {total > 0 && segments.map((s, i) => {
        const len = (s.value / total) * c
        const el = (
          <circle key={i} cx="60" cy="60" r={r} fill="none" stroke={s.color} strokeWidth="14"
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-acc}
            transform="rotate(-90 60 60)" />
        )
        acc += len
        return el
      })}
    </svg>
  )
}

// Two horizontal bars on a shared scale - the classic budget vs actual view.
function BudgetBars({ budget, spent, cur }) {
  const max = Math.max(budget, spent, 1)
  const over = spent > budget && budget > 0
  const row = (label, v, color) => (
    <div style={{ marginBottom: 12 }}>
      <div className="small" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="muted">{label}</span><b>{fmtMoney(v, cur)}</b>
      </div>
      <div className="bar"><span style={{ width: `${Math.min(100, (v / max) * 100)}%`, background: color }} /></div>
    </div>
  )
  return (
    <>
      {row('Estimated budget', budget, '#94a3b8')}
      {row('Actual spent', spent, over ? '#dc2626' : '#16a34a')}
      <div className="small" style={{ color: over ? 'var(--red)' : 'var(--green)' }}>
        <b>{over ? '−' : '+'}{fmtMoney(Math.abs(budget - spent), cur)}</b> {over ? 'over budget' : 'under budget'}
        {budget > 0 && ` · ${Math.round((spent / budget) * 100)}% of budget used`}
      </div>
    </>
  )
}

// Per-day activity: stacked wages+materials bars (or workers when no money
// rights), with the worker head-count above each bar.
function DailyChart({ daily, showMoney, cur }) {
  if (!daily.length) return <div className="muted small">No recorded activity days yet.</div>
  const vals = daily.map((d) => (showMoney ? d.spend : d.workers))
  const max = Math.max(...vals, 1)
  const bw = 26, gap = 10, H = 110
  const W = gap + daily.length * (bw + gap)
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(W, 280)} height={H + 42}>
        {daily.map((d, i) => {
          const x = gap + i * (bw + gap)
          const label = d.day.slice(5).replace('-', '/')
          const title = showMoney
            ? `${fmtDay(d.day)} - ${d.workers} workers · wages ${fmtMoney(d.wages, cur)} · materials ${fmtMoney(d.materials, cur)}`
            : `${fmtDay(d.day)} - ${d.workers} workers`
          const hw = showMoney ? (d.wages / max) * H : 0
          const hm = showMoney ? (d.materials / max) * H : 0
          const hAll = showMoney ? hw + hm : (d.workers / max) * H
          return (
            <g key={d.day}>
              <title>{title}</title>
              {showMoney ? (
                <>
                  <rect x={x} y={12 + H - hm} width={bw} height={hm} fill={COLORS.materials} rx="2" />
                  <rect x={x} y={12 + H - hm - hw} width={bw} height={hw} fill={COLORS.wages} rx="2" />
                </>
              ) : (
                <rect x={x} y={12 + H - hAll} width={bw} height={hAll} fill={COLORS.wages} rx="2" />
              )}
              {d.workers > 0 && (
                <text x={x + bw / 2} y={8 + H - hAll} textAnchor="middle" fontSize="9" fill="#64748b">
                  {d.workers}
                </text>
              )}
              <text x={x + bw / 2} y={H + 26} textAnchor="middle" fontSize="9" fill="#94a3b8">{label}</text>
            </g>
          )
        })}
      </svg>
      <div className="small muted" style={{ marginTop: 2 }}>
        {showMoney
          ? 'Daily spend - wages (amber) and materials (blue); the number above each bar is workers on site.'
          : 'Workers on site per day.'}
      </div>
    </div>
  )
}

export default function PhaseReport() {
  const { id } = useParams()
  const [r, setR] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api(`/projects/phases/${id}/report`).then(setR).catch((e) => setError(e.message))
  }, [id])

  if (error) return <div className="error-note">{error}</div>
  if (!r) return <div className="spin">Building phase report…</div>
  const cur = r.currency
  const showMoney = r.spent != null
  const over = showMoney && r.budget > 0 && r.spent > r.budget
  const onSchedule = r.plannedDays != null ? r.actualDays <= r.plannedDays : null

  return (
    <>
      <div className="flex-between" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <Link to="/phases" className="small muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
            <ArrowLeft size={13} /> Phases &amp; Tasks
          </Link>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {r.name} <span className="muted" style={{ fontWeight: 400 }}>· {r.project}</span>
            {r.status === 'done'
              ? <span className="badge green"><CheckCircle2 size={11} /> Signed off</span>
              : <span className="badge gray">{r.percent}% complete</span>}
          </h2>
          {r.signedOffAt && (
            <div className="small muted" style={{ marginTop: 4 }}>
              Completed by <b>{r.signedOffBy}</b> · {fmtDate(r.signedOffAt)}
              {r.assignee && <> · phase lead: {r.assignee}</>}
            </div>
          )}
        </div>
        <button className="btn ghost no-print" onClick={() => window.print()}><Printer size={13} /> Print / PDF</button>
      </div>

      <div className="grid grid-4">
        <div className="card">
          <h3><CalendarDays size={13} /> Duration</h3>
          <div className="big">{r.actualDays} day{r.actualDays === 1 ? '' : 's'}</div>
          <div className="sub">
            {fmtDay(r.startedAt)} → {fmtDay(r.endedAt)}
            {r.plannedDays != null && <> · planned {r.plannedDays}d{' '}
              <b style={{ color: onSchedule ? 'var(--green)' : 'var(--red)' }}>
                ({onSchedule ? 'on schedule' : `${r.actualDays - r.plannedDays}d late`})
              </b></>}
          </div>
        </div>
        <div className="card">
          <h3><Users size={13} /> Workforce</h3>
          <div className="big">{r.workers.length}</div>
          <div className="sub">{r.workerDays} worker-day{r.workerDays === 1 ? '' : 's'} recorded · {r.updatesCount} daily report{r.updatesCount === 1 ? '' : 's'} · {r.photos} photo{r.photos === 1 ? '' : 's'}</div>
        </div>
        <div className="card">
          <h3><Banknote size={13} /> Actual cost</h3>
          <div className="big" style={{ fontSize: showMoney ? 22 : 20 }}>{fmtMoney(r.spent, cur)}</div>
          <div className="sub">{showMoney ? `of ${fmtMoney(r.budget, cur)} estimated` : 'No permission to view amounts'}</div>
        </div>
        <div className="card">
          <h3>Variance</h3>
          <div className="big" style={{ fontSize: showMoney ? 22 : 20, color: showMoney ? (over ? 'var(--red)' : 'var(--green)') : undefined }}>
            {showMoney ? `${over ? '−' : '+'}${fmtMoney(Math.abs(r.variance), cur)}` : '-'}
          </div>
          <div className="sub">{showMoney ? (over ? 'Over the estimated budget' : 'Under the estimated budget') : ''}</div>
        </div>
      </div>

      {showMoney && (
        <div className="grid grid-2 mt">
          <div className="card">
            <h3>Estimated budget vs actual</h3>
            <div className="mt"><BudgetBars budget={r.budget} spent={r.spent} cur={cur} /></div>
          </div>
          <div className="card">
            <h3>Where the money went</h3>
            <div className="donut-wrap mt" style={{ alignItems: 'center' }}>
              <CostDonut segments={[
                { value: r.wages, color: COLORS.wages },
                { value: r.crewEstimate, color: COLORS.crew },
                { value: r.materialsTotal, color: COLORS.materials },
              ]} />
              <div className="legend">
                <div><span className="dot" style={{ background: COLORS.wages }} />Worker wages: <b>{fmtMoney(r.wages, cur)}</b></div>
                {r.crewEstimate > 0 && <div><span className="dot" style={{ background: COLORS.crew }} />Crew estimate: <b>{fmtMoney(r.crewEstimate, cur)}</b></div>}
                <div><span className="dot" style={{ background: COLORS.materials }} />Materials: <b>{fmtMoney(r.materialsTotal, cur)}</b></div>
                <div style={{ marginTop: 4 }}>Total: <b>{fmtMoney(r.spent, cur)}</b></div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card mt">
        <h3>Daily activity</h3>
        <div className="mt"><DailyChart daily={r.daily} showMoney={showMoney} cur={cur} /></div>
      </div>

      <div className="grid grid-2 mt">
        <div className="card table-card">
          <h3 style={{ padding: '14px 16px 0' }}><HardHat size={13} /> Workers on this phase</h3>
          <table>
            <thead><tr><th>Worker</th><th>Type</th><th>Days</th>{showMoney && <th>Paid</th>}</tr></thead>
            <tbody>
              {r.workers.map((w, i) => (
                <tr key={i}>
                  <td><b>{w.name}</b></td>
                  <td className="muted">{w.type}</td>
                  <td>{w.days}</td>
                  {showMoney && <td>{fmtMoney(w.pay, cur)}</td>}
                </tr>
              ))}
              {!r.workers.length && <tr><td colSpan={showMoney ? 4 : 3} className="muted">No attendance was recorded on this phase.</td></tr>}
              {showMoney && r.workers.length > 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'right' }}><b>Total wages</b></td>
                  <td><b>{fmtMoney(r.wages, cur)}</b></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card table-card">
          <h3 style={{ padding: '14px 16px 0' }}><Package size={13} /> Materials used</h3>
          <table>
            <thead><tr><th>Item</th><th>Qty</th><th>Source</th>{showMoney && <th>Cost</th>}</tr></thead>
            <tbody>
              {r.materials.map((m, i) => (
                <tr key={i}>
                  <td><b>{m.name}</b></td>
                  <td>{m.qty.toLocaleString()}</td>
                  <td className="muted small">{m.source === 'drawn' ? 'Drawn from stock' : 'Daily report'}</td>
                  {showMoney && <td>{fmtMoney(m.cost, cur)}</td>}
                </tr>
              ))}
              {!r.materials.length && <tr><td colSpan={showMoney ? 4 : 3} className="muted">No materials recorded on this phase.</td></tr>}
              {showMoney && r.materials.length > 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'right' }}><b>Total materials</b></td>
                  <td><b>{fmtMoney(r.materialsTotal, cur)}</b></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {r.insights.length > 0 && (
        <div className="card mt">
          <h3>Key insights checklist</h3>
          <div className="mt">
            {r.insights.map((ins, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
                <CheckCircle2 size={14} style={{ color: ins.done ? 'var(--green)' : '#cbd5e1', flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{ins.title}</span>
                {ins.done && <span className="small muted">{ins.doneBy} · {fmtDay(ins.doneAt)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
