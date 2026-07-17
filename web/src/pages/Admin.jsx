import { useEffect, useState } from 'react'
import { Wallet, Clock3, CalendarClock, BellRing, Wrench, Activity, Users, Building2 } from 'lucide-react'
import { api, fmtDay, fmtMoney, setToken } from '../api.js'
import { ErrorNote } from '../ui.jsx'

const STATUS_COLORS = { ACTIVE: '#16a34a', TRIAL: '#f59e0b', SUSPENDED: '#dc2626', TERMINATED: '#94a3b8' }

// Line chart: confirmed subscriptions per month, last 12 months.
function SubsLine({ monthly }) {
  const W = 560, H = 130, PADX = 14, PADY = 14
  const max = Math.max(...monthly.map((m) => m.subs), 1)
  const step = (W - PADX * 2) / (monthly.length - 1)
  const x = (i) => PADX + i * step
  const y = (v) => PADY + (H - PADY * 2) * (1 - v / max)
  const path = monthly.map((m, i) => `${i ? 'L' : 'M'}${x(i)},${y(m.subs)}`).join(' ')
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H + 22}`} width="100%" style={{ minWidth: 420 }}>
        <path d={path} fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinejoin="round" />
        {monthly.map((m, i) => (
          <g key={i}>
            <title>{`${m.label}: ${m.subs} subscription${m.subs === 1 ? '' : 's'}`}</title>
            <circle cx={x(i)} cy={y(m.subs)} r="3.5" fill="#f59e0b" />
            {m.subs > 0 && <text x={x(i)} y={y(m.subs) - 8} textAnchor="middle" fontSize="10" fontWeight="700" fill="#b45309">{m.subs}</text>}
            <text x={x(i)} y={H + 14} textAnchor="middle" fontSize="8.5" fill="#94a3b8">{m.label}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// Bar chart: revenue received per month, last 12 months.
function RevenueBars({ monthly }) {
  const max = Math.max(...monthly.map((m) => m.revenue), 1)
  const bw = 30, gap = 12, H = 120
  const W = gap + monthly.length * (bw + gap)
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(W, 300)} height={H + 34}>
        {monthly.map((m, i) => {
          const h = (m.revenue / max) * H
          const x = gap + i * (bw + gap)
          return (
            <g key={i}>
              <title>{`${m.label}: ${fmtMoney(m.revenue, 'RWF')}`}</title>
              <rect x={x} y={10 + H - h} width={bw} height={Math.max(h, m.revenue > 0 ? 2 : 0)} fill="#16a34a" rx="3" />
              <text x={x + bw / 2} y={H + 24} textAnchor="middle" fontSize="8.5" fill="#94a3b8">{m.label}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// Pie of company account statuses.
function StatusPie({ counts }) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0)
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1
  const r = 50, c = 2 * Math.PI * r
  let acc = 0
  return (
    <div className="donut-wrap" style={{ alignItems: 'center' }}>
      <svg viewBox="0 0 120 120" width="120" height="120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#eef0f3" strokeWidth="16" />
        {entries.map(([status, v]) => {
          const len = (v / total) * c
          const el = (
            <circle key={status} cx="60" cy="60" r={r} fill="none"
              stroke={STATUS_COLORS[status] ?? '#94a3b8'} strokeWidth="16"
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-acc}
              transform="rotate(-90 60 60)" />
          )
          acc += len
          return el
        })}
      </svg>
      <div className="legend">
        {entries.map(([status, v]) => (
          <div key={status}><span className="dot" style={{ background: STATUS_COLORS[status] ?? '#94a3b8' }} />{status.toLowerCase()}: <b>{v}</b></div>
        ))}
      </div>
    </div>
  )
}

// Simple share donut (active users / active projects).
function ShareDonut({ value, total, label, color }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  const r = 50, c = 2 * Math.PI * r
  return (
    <div className="donut">
      <svg viewBox="0 0 120 120" width="120" height="120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#eef0f3" strokeWidth="14" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="14"
          strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 60 60)" />
      </svg>
      <div className="donut-label"><b>{value}/{total}</b><span>{label}</span></div>
    </div>
  )
}

const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function Admin() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/admin/dashboard').then(setStats).catch((e) => setError(e.message))
  }, [])

  // Jump into the company's workspace (same support mode as the Companies tab)
  const openAs = async (id) => {
    setError(null)
    try {
      const r = await api(`/auth/impersonate/${id}`, { method: 'POST' })
      localStorage.setItem('bridge_super_token', localStorage.getItem('bridge_token'))
      setToken(r.token)
      window.location.hash = '#/'
      window.location.reload()
    } catch (err) { setError(err.message) }
  }

  if (error && !stats) return <div className="error-note">{error}</div>
  if (!stats) return <div className="spin">Loading platform dashboard…</div>
  const sys = stats.system

  return (
    <>
      {/* ---------------- Platform overview ---------------- */}
      <p className="muted" style={{ marginBottom: 16 }}>
        Platform overview for <b>{stats.month}</b> -{' '}
        {Object.entries(stats.statusCounts).map(([s, n], i) => (
          <span key={s}>{i > 0 && ' · '}{n} {s.toLowerCase()}</span>
        ))}
      </p>
      <ErrorNote error={error} />

      <div className="grid grid-3">
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Wallet size={14} color="var(--green)" /> Received this month</h3>
          <div className="big" style={{ color: 'var(--green)' }}>{fmtMoney(stats.received.total, 'RWF')}</div>
          <div className="sub">{stats.received.count} confirmed payment{stats.received.count === 1 ? '' : 's'}</div>
        </div>
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><CalendarClock size={14} color="var(--accent-dark, #b45309)" /> Due this month</h3>
          <div className="big">{fmtMoney(stats.due.total, 'RWF')}</div>
          <div className="sub">{stats.due.count} compan{stats.due.count === 1 ? 'y' : 'ies'} with trial or coverage ending</div>
        </div>
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Clock3 size={14} /> Pending to confirm</h3>
          <div className="big">{fmtMoney(stats.pending.total, 'RWF')}</div>
          <div className="sub">{stats.pending.count} payment{stats.pending.count === 1 ? '' : 's'} awaiting confirmation</div>
        </div>
      </div>

      {stats.reminders.companies.length > 0 && (
        <div className="card" style={{ marginTop: 16, border: '1.5px solid var(--accent)', background: '#fffbeb' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <BellRing size={14} color="var(--accent-dark, #b45309)" />
            Renewal reminders - within {stats.reminders.days} day{stats.reminders.days === 1 ? '' : 's'}
          </h3>
          <div className="mt" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stats.reminders.companies.map((c) => (
              <div key={c.id} className="flex-between" style={{ gap: 10, flexWrap: 'wrap' }}>
                <span>
                  <b>{c.company}</b>
                  <span className="small muted"> - {c.status === 'TRIAL' ? 'trial' : (c.plan ?? 'plan')} ends {fmtDay(c.endsAt)}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`badge ${c.daysLeft < 0 ? 'red' : 'amber'}`}>
                    {c.daysLeft < 0 ? `overdue ${-c.daysLeft} day${c.daysLeft === -1 ? '' : 's'}`
                      : c.daysLeft === 0 ? 'ends today'
                      : `${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'} left`}
                  </span>
                  <button className="btn ghost sm" onClick={() => openAs(c.id)}><Wrench size={12} /> Open</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- Growth charts ---------------- */}
      <div className="grid grid-2 mt">
        <div className="card">
          <h3>Subscriptions per month</h3>
          <p className="small muted" style={{ margin: '4px 0 6px' }}>Confirmed subscription payments, last 12 months</p>
          <SubsLine monthly={stats.monthly} />
        </div>
        <div className="card">
          <h3>Revenue per month</h3>
          <p className="small muted" style={{ margin: '4px 0 6px' }}>Money received (confirmed), last 12 months</p>
          <RevenueBars monthly={stats.monthly} />
        </div>
      </div>

      {/* ---------------- Platform composition ---------------- */}
      <div className="grid grid-3 mt">
        <div className="card">
          <h3><Building2 size={13} /> Account statuses</h3>
          <div className="mt"><StatusPie counts={stats.statusCounts} /></div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <h3 style={{ textAlign: 'left' }}><Users size={13} /> Active users</h3>
          <div className="mt" style={{ display: 'flex', justifyContent: 'center' }}>
            <ShareDonut value={stats.users.active} total={stats.users.total} label="active users" color="#2563eb" />
          </div>
          <div className="small muted mt">Users in active or trial companies vs all users on the platform</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <h3 style={{ textAlign: 'left' }}>Active projects</h3>
          <div className="mt" style={{ display: 'flex', justifyContent: 'center' }}>
            <ShareDonut value={stats.projects.active} total={stats.projects.total} label="in progress" color="#f59e0b" />
          </div>
          <div className="small muted mt">Projects in progress vs all projects across all companies</div>
        </div>
      </div>

      {/* ---------------- System performance ---------------- */}
      <div className="card mt">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Activity size={14} color="var(--green)" /> System performance</h3>
        <div className="grid grid-4 mt" style={{ gap: 12 }}>
          <div>
            <div className="small muted">Uptime</div>
            <div className="big" style={{ fontSize: 20 }}>{fmtUptime(sys.uptimeSec)}</div>
          </div>
          <div>
            <div className="small muted">API response (avg / p95)</div>
            <div className="big" style={{ fontSize: 20 }}>
              {sys.apiAvgMs != null ? `${sys.apiAvgMs} ms` : '-'}
              <span className="muted" style={{ fontSize: 13 }}> / {sys.apiP95Ms != null ? `${sys.apiP95Ms} ms` : '-'}</span>
            </div>
            <div className="small muted">{sys.apiCount.toLocaleString()} requests since start</div>
          </div>
          <div>
            <div className="small muted">Database round trip</div>
            <div className="big" style={{ fontSize: 20, color: sys.dbLatencyMs > 100 ? 'var(--red)' : 'var(--green)' }}>{sys.dbLatencyMs} ms</div>
          </div>
          <div>
            <div className="small muted">Memory (process / heap)</div>
            <div className="big" style={{ fontSize: 20 }}>{sys.memoryMb} MB<span className="muted" style={{ fontSize: 13 }}> / {sys.heapMb} MB</span></div>
            <div className="small muted">Node {sys.node}</div>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 14, lineHeight: 1.7, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <b>How this works:</b> every API request is timed as it leaves the server; the tracker keeps the
          last 500 response times to compute the average and the p95 (the time 95% of requests beat).
          The database figure is a live round trip to MySQL measured when this page loads. Uptime counts
          since the server process last started, and memory is the Node.js process footprint (total / JavaScript heap).
          Green means healthy; a database round trip over 100 ms turns red and is the first thing to
          investigate on a slow day.
        </div>
      </div>
    </>
  )
}
