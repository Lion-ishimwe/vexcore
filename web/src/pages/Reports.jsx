import { useEffect, useState } from 'react'
import { Printer, History } from 'lucide-react'
import { api, fmtMoney, fmtDay, fmtDate } from '../api.js'
import { useAuth } from '../auth.jsx'

export default function Reports() {
  const { client } = useAuth()
  const [projects, setProjects] = useState(null)
  const [auditLog, setAuditLog] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/projects').then(setProjects).catch((e) => setError(e.message))
    api('/audit').then(setAuditLog).catch(() => {})
  }, [])

  if (error) return <div className="error-note">{error}</div>
  if (!projects) return <div className="spin">Loading reports…</div>
  const cur = client?.currency

  return (
    <>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <p className="muted">Itemized phase-level reports - budget vs actual across all projects.</p>
        <button className="btn" onClick={() => window.print()}><Printer size={13} /> Export / Print PDF</button>
      </div>

      {projects.filter((p) => p.phases.length).map((project) => (
        <div key={project.id}>
          <div className="section-title" style={{ marginTop: 6 }}>Budget vs actual - {project.name}</div>
          <div className="card table-card" style={{ marginBottom: 10 }}>
            <table>
              <thead>
                <tr><th>Phase</th><th>Budget</th><th>Actual</th><th>Variance</th><th>Progress</th><th>Status</th></tr>
              </thead>
              <tbody>
                {project.phases.map((ph) => {
                  const variance = ph.budget - ph.spent
                  const overPace = ph.budget > 0 && ph.spent / ph.budget > ph.percent / 100 + 0.05
                  return (
                    <tr key={ph.id}>
                      <td><b>{ph.name}</b><div className="small muted">{fmtDay(ph.startDate)} → {fmtDay(ph.endDate)}</div></td>
                      <td>{fmtMoney(ph.budget, cur)}</td>
                      <td>{fmtMoney(ph.spent, cur)}<div className="small muted">labor {fmtMoney(ph.laborSpent, cur)} · materials {fmtMoney(ph.materialsSpent, cur)}</div></td>
                      <td style={{ color: variance < 0 ? 'var(--red)' : 'var(--green)' }}>
                        <b>{variance < 0 ? '−' : '+'}{fmtMoney(Math.abs(variance), cur)}</b>
                      </td>
                      <td style={{ minWidth: 110 }}>
                        <div className={`bar ${ph.percent === 100 ? 'green' : ''}`}><span style={{ width: `${ph.percent}%` }} /></div>
                      </td>
                      <td>
                        {ph.status === 'done'
                          ? <span className="badge green">Signed off</span>
                          : overPace
                            ? <span className="badge red">Over budget pace</span>
                            : <span className="badge gray">{ph.percent}%</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="section-title">Audit trail</div>
      <div className="card">
        <div className="small" style={{ lineHeight: 2.1 }}>
          {auditLog.map((a) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
              <History size={12} style={{ flexShrink: 0, transform: 'translateY(1px)' }} />
              <span><b>{a.userName}</b> - {a.action}{a.detail ? `: ${a.detail}` : ''}
                <span className="muted"> · {fmtDate(a.createdAt)}</span></span>
            </div>
          ))}
          {!auditLog.length && <span className="muted">No audit entries yet.</span>}
        </div>
      </div>
    </>
  )
}
