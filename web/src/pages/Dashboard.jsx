import { useEffect, useState } from 'react'
import { HardHat, Users, Camera, Video, MapPin, DraftingCompass } from 'lucide-react'
import { api, fmtMoney, fmtDate } from '../api.js'
import { useAuth } from '../auth.jsx'
import { useT } from '../i18n.jsx'
import { Avatar, Lightbox } from '../ui.jsx'

// Auto-sliding carousel of the images in the Design folder.
function DesignSlider({ images, onOpen }) {
  const { t } = useT()
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (images.length < 2) return
    const t = setInterval(() => setIdx((i) => (i + 1) % images.length), 4000)
    return () => clearInterval(t)
  }, [images.length])
  return (
    <div className="card design-card">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
          <DraftingCompass size={14} /> {t('dash.designs')}
        </h3>
        <span className="small muted">{idx + 1} / {images.length} · from the Design folder</span>
      </div>
      <div className="design-slider">
        {images.map((im, i) => (
          <img key={im.url} src={im.url} alt={im.name} className={i === idx ? 'on' : ''}
            onClick={() => onOpen({ url: im.url, name: im.name, download: true })} />
        ))}
        <div className="design-dots">
          {images.map((_, i) => (
            <span key={i} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)} />
          ))}
        </div>
      </div>
    </div>
  )
}

function Donut({ percent, label, color = '#f59e0b' }) {
  const r = 50, c = 2 * Math.PI * r
  return (
    <div className="donut">
      <svg viewBox="0 0 120 120" width="120" height="120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#eef0f3" strokeWidth="13" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="13"
          strokeDasharray={`${(percent / 100) * c} ${c}`} strokeLinecap="round"
          transform="rotate(-90 60 60)" />
      </svg>
      <div className="donut-label"><b>{percent}%</b><span>{label}</span></div>
    </div>
  )
}

export default function Dashboard() {
  const { client } = useAuth()
  const { t } = useT()
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)
  const [lightbox, setLightbox] = useState(null)

  useEffect(() => { api('/dashboard').then(setD).catch((e) => setError(e.message)) }, [])

  if (error) return <div className="error-note">{error}</div>
  if (!d) return <div className="spin">Loading dashboard…</div>
  const cur = client?.currency

  return (
    <>
      <div className="grid grid-4">
        <div className="card">
          <h3>{t('dash.activeProjects')}</h3>
          <div className="big">{d.activeProjects}</div>
          <div className="sub">{d.totalProjects} total in account</div>
        </div>
        <div className="card">
          <h3>{t('dash.completion')}</h3>
          <div className="big">{d.overallPercent}%</div>
          <div className="bar mt"><span style={{ width: `${d.overallPercent}%` }} /></div>
        </div>
        <div className="card">
          <h3>{t('dash.spend')}</h3>
          <div className="big" style={{ fontSize: d.totalSpent == null ? 20 : 22 }}>{fmtMoney(d.totalSpent, cur)}</div>
          <div className="sub">{d.totalBudget != null ? `of ${fmtMoney(d.totalBudget, cur)} budget` : 'No permission to view amounts'}</div>
        </div>
        <div className="card">
          <h3>{t('dash.stockValue')}</h3>
          <div className="big" style={{ fontSize: d.stockValue == null ? 20 : 22 }}>{fmtMoney(d.stockValue, cur)}</div>
          <div className="sub">{d.lowStock.length} item{d.lowStock.length === 1 ? '' : 's'} low on stock{d.lowStock.length ? ` - ${d.lowStock.join(', ')}` : ''}</div>
        </div>
      </div>

      <div className="grid grid-2 mt">
        {d.designImages?.length > 0 && <DesignSlider images={d.designImages} onOpen={setLightbox} />}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <h3>{t('dash.progress')}</h3>
            <div className="donut-wrap mt">
              <Donut percent={d.overallPercent} label="complete" />
              <Donut percent={d.stockUsedPct} label="stock used" color="#2563eb" />
              <div className="legend">
                <div><span className="dot" style={{ background: '#f59e0b' }} />Work complete (all phases)</div>
                <div><span className="dot" style={{ background: '#2563eb' }} />Stock consumed vs purchased</div>
                {d.lowStock.length > 0 && <div><span className="dot" style={{ background: '#dc2626' }} />Low stock: {d.lowStock.join(', ')}</div>}
              </div>
            </div>
          </div>

          <div className="card" style={{ flex: 1 }}>
            <h3>{t('dash.phaseCompletion')}</h3>
            <div className="mt">
              {d.phaseBars.map((ph, i) => (
                <div className="bar-row" key={i}>
                  <div className="label" title={ph.project}>{ph.name}</div>
                  <div className={`bar ${ph.percent === 100 ? 'green' : ''}`}><span style={{ width: `${ph.percent}%` }} /></div>
                  <div className="pct">{ph.percent}%</div>
                </div>
              ))}
              {!d.phaseBars.length && <div className="muted small">No phases yet - create a project and add phases.</div>}
            </div>
          </div>
        </div>

        {!d.designImages?.length && (
          <div className="card">
            <h3>Project designs</h3>
            <div className="mt muted small">
              Upload design images to the <b>Design</b> folder in Documents - they will slide here automatically.
            </div>
          </div>
        )}
      </div>

      <div className="section-title">{t('dash.latest')}</div>
      <div className="card">
        {d.latestUpdates.map((u) => (
          <div className="update" key={u.id} style={{ marginBottom: 14 }}>
            <Avatar name={u.by} />
            <div className="update-card">
              <div className="update-head">
                <b>{u.by} - {u.project}{u.phase ? ` · ${u.phase}` : ''}</b>
                <span className="time">{fmtDate(u.createdAt)}</span>
              </div>
              {u.note && <div className="update-note">{u.note}</div>}
              <div className="chips">
                <span className="chip"><HardHat size={12} /> {u.builders} builders</span>
                <span className="chip"><Users size={12} /> {u.helpers} helpers</span>
                {u.photos > 0 && <span className="chip"><Camera size={12} /> {u.photos} photos</span>}
                {u.videos > 0 && <span className="chip"><Video size={12} /> {u.videos} video</span>}
                {u.geotag && <span className="chip"><MapPin size={12} /> {u.geotag}</span>}
              </div>
            </div>
          </div>
        ))}
        {!d.latestUpdates.length && <div className="muted small">No updates yet.</div>}
      </div>

      <Lightbox img={lightbox} onClose={() => setLightbox(null)} />
    </>
  )
}
