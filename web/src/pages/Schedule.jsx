import { useEffect, useState } from 'react'
import { FileSpreadsheet, FileDown, Printer } from 'lucide-react'
import { api, fmtDay } from '../api.js'
import { useAuth } from '../auth.jsx'

const GANTT_COLORS = { todo: '#94a3b8', active: '#f59e0b', done: '#16a34a' }
const STATUS_TEXT = { todo: 'To do', active: 'In progress', done: 'Done' }

// Schedule: a Gantt-style view of the phases from Phases & Tasks - bars across
// a month/week timeline. Exports (Excel/PDF) carry the company letterhead.
export default function Schedule() {
  const { client } = useAuth()
  const [projects, setProjects] = useState(null)
  const [projectId, setProjectId] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/projects').then((ps) => {
      setProjects(ps)
      setProjectId((id) => id ?? ps.find((p) => p.phases.length)?.id ?? ps[0]?.id ?? null)
    }).catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="error-note">{error}</div>
  if (!projects) return <div className="spin">Loading schedule…</div>
  const project = projects.find((p) => p.id === projectId)
  const brandLogo = client?.logo || '/logo.png'

  const dated = (project?.phases ?? []).filter((p) => p.startDate && p.endDate)
  const undated = (project?.phases ?? []).filter((p) => !p.startDate || !p.endDate)

  // Excel export: an HTML worksheet Excel opens natively - letterhead first
  // (logo embedded as a data URI so it works offline), then the plan.
  const downloadExcel = async () => {
    let logo = ''
    try {
      const blob = await (await fetch(brandLogo)).blob()
      const dataUri = await new Promise((resolve) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.readAsDataURL(blob)
      })
      logo = `<img src="${dataUri}" height="44"> `
    } catch { /* the letterhead text still identifies the company */ }
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const days = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000) + 1)
    const rows = (project?.phases ?? []).map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td>${STATUS_TEXT[p.status] ?? p.status}</td>
        <td>${p.startDate ? String(p.startDate).slice(0, 10) : '-'}</td>
        <td>${p.endDate ? String(p.endDate).slice(0, 10) : '-'}</td>
        <td>${p.startDate && p.endDate ? days(p.startDate, p.endDate) : '-'}</td>
        <td>${p.percent}%</td>
        <td>${p.assignee?.name ? esc(p.assignee.name) : '-'}</td>
      </tr>`).join('')
    const html = `<html><head><meta charset="utf-8"></head><body>
      <table border="1">
        <tr><td colspan="7" style="font-size:20px;font-weight:bold;height:52px;vertical-align:middle">${logo}${esc(client?.company)}</td></tr>
        <tr><td colspan="7">TIN: ${esc(client?.tin ?? '-')} &nbsp;·&nbsp; Location: ${esc(client?.location ?? '-')} &nbsp;·&nbsp; Contact: ${esc(client?.contact ?? '-')}</td></tr>
        <tr><td colspan="7">Project schedule - ${esc(project?.name)} · generated ${new Date().toLocaleDateString('en-GB')}</td></tr>
        <tr><td colspan="7"></td></tr>
        <tr style="font-weight:bold;background:#fef3c7">
          <td>Phase</td><td>Status</td><td>Start</td><td>End</td><td>Duration (days)</td><td>Complete</td><td>Assigned to</td>
        </tr>
        ${rows}
      </table></body></html>`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([html], { type: 'application/vnd.ms-excel' }))
    a.download = `schedule-${(project?.name ?? 'project').replace(/\s+/g, '-')}.xls`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // A real PDF file, generated server-side with the letterhead + gantt.
  const downloadPdf = async () => {
    try {
      const r = await fetch(`/api/projects/${project.id}/schedule.pdf`, {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('bridge_token') },
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Could not build the PDF')
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `schedule-${project.name.replace(/\s+/g, '-')}.pdf`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (err) { setError(err.message) }
  }

  const letterhead = project && (
    <div className="letterhead">
      <img src={brandLogo} alt="" />
      <div>
        <b>{client?.company}</b>
        <span className="small muted">
          TIN: {client?.tin ?? '-'} · {client?.location ?? '-'} · {client?.contact ?? '-'}
        </span>
        <span className="small">
          Project schedule - <b>{project.name}</b> · generated {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
      </div>
    </div>
  )

  // Timeline from the 1st of the earliest month to the last day of the latest.
  let gantt = null
  if (dated.length) {
    const min0 = new Date(Math.min(...dated.map((p) => +new Date(p.startDate))))
    const max0 = new Date(Math.max(...dated.map((p) => +new Date(p.endDate))))
    const min = new Date(min0.getFullYear(), min0.getMonth(), 1)
    const max = new Date(max0.getFullYear(), max0.getMonth() + 1, 0)
    const totalDays = Math.round((max - min) / 86400000) + 1
    const pct = (d) => (Math.round((new Date(d) - min) / 86400000) / totalDays) * 100

    const months = []
    for (let d = new Date(min); d <= max; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      const daysIn = Math.round((Math.min(end, max) - d) / 86400000) + 1
      months.push({
        label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
        left: pct(d), width: (daysIn / totalDays) * 100,
      })
    }
    const weeks = []
    for (let i = 7; i < totalDays; i += 7) weeks.push((i / totalDays) * 100)
    const now = new Date()
    const todayPct = now >= min && now <= max ? pct(now) : null

    gantt = (
      <div className="gantt">
        <div className="gantt-row gantt-head">
          <div className="gantt-label small muted">Phase</div>
          <div className="gantt-track">
            {months.map((m, i) => (
              <span className="gantt-month" key={i} style={{ left: `${m.left}%`, width: `${m.width}%` }}>{m.label}</span>
            ))}
          </div>
        </div>
        {dated.map((ph) => {
          const left = pct(ph.startDate)
          const width = Math.max(1.2, pct(ph.endDate) - left + (1 / totalDays) * 100)
          return (
            <div className="gantt-row" key={ph.id}>
              <div className="gantt-label">
                <b>{ph.name}</b>
                <span className="small muted">{fmtDay(ph.startDate)} → {fmtDay(ph.endDate)}</span>
              </div>
              <div className="gantt-track">
                {months.map((m, i) => i > 0 && <i className="gantt-line month" key={'m' + i} style={{ left: `${m.left}%` }} />)}
                {weeks.map((w, i) => <i className="gantt-line" key={'w' + i} style={{ left: `${w}%` }} />)}
                {todayPct != null && <i className="gantt-today" style={{ left: `${todayPct}%` }} title="Today" />}
                <div className="gantt-bar"
                  style={{ left: `${left}%`, width: `${width}%`, background: GANTT_COLORS[ph.status] }}
                  title={`${ph.name}: ${fmtDay(ph.startDate)} → ${fmtDay(ph.endDate)} · ${STATUS_TEXT[ph.status]} · ${ph.percent}%`}>
                  {width > 9 && <span>{ph.percent}%</span>}
                </div>
              </div>
            </div>
          )
        })}
        <div className="legend gantt-legend">
          {Object.entries(GANTT_COLORS).map(([k, c]) => (
            <div key={k}><span className="dot" style={{ background: c }} />{STATUS_TEXT[k]}</div>
          ))}
          <div><span className="dot" style={{ background: '#dc2626' }} />Today</div>
        </div>
        {undated.length > 0 && (
          <div className="small muted" style={{ marginTop: 10 }}>
            Not on the schedule (no dates yet): {undated.map((p) => p.name).join(', ')}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="flex-between no-print" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <select value={projectId ?? ''} onChange={(e) => setProjectId(+e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 13.5 }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="small muted">Pulled live from Phases &amp; Tasks - edit dates there and the plan follows</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost sm" onClick={downloadExcel} disabled={!project}><FileSpreadsheet size={13} /> Excel</button>
          <button className="btn sm" onClick={downloadPdf} disabled={!project}><FileDown size={13} /> Download PDF</button>
          <button className="btn ghost sm" onClick={() => window.print()} disabled={!project}><Printer size={13} /> Print</button>
        </div>
      </div>

      {project ? (
        <div className="card gantt-card">
          {letterhead}
          {gantt ?? (
            <p className="muted" style={{ marginTop: 12 }}>
              No phases with both start and end dates yet - set dates on the phase cards in Phases &amp; Tasks
              (or via the bulk-upload template) and the schedule draws itself.
            </p>
          )}
        </div>
      ) : <div className="muted">No project selected.</div>}
    </>
  )
}
