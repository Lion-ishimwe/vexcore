import { useEffect, useRef, useState } from 'react'
import {
  MapPin, Wind, Droplets, HardHat, Building2,
  Sun, CloudSun, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudLightning, Snowflake,
} from 'lucide-react'
import { api } from './api.js'

const WX_ICON = {
  sun: { Icon: Sun, color: '#f59e0b' },
  partly: { Icon: CloudSun, color: '#f59e0b' },
  cloud: { Icon: Cloud, color: '#64748b' },
  fog: { Icon: CloudFog, color: '#94a3b8' },
  drizzle: { Icon: CloudDrizzle, color: '#3b82f6' },
  rain: { Icon: CloudRain, color: '#2563eb' },
  snow: { Icon: Snowflake, color: '#38bdf8' },
  storm: { Icon: CloudLightning, color: '#7c3aed' },
}

const dayName = (iso, i) =>
  i === 0 ? 'Today' : new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' })

function WeatherCard({ w }) {
  const { Icon, color } = WX_ICON[w.icon] ?? WX_ICON.cloud
  const rainy = w.rainChance != null && w.rainChance >= 50
  return (
    <div className="card weather-card">
      <div className="weather-now">
        <Icon size={34} color={color} strokeWidth={1.7} />
        <div className="weather-main">
          <b>{w.temp}°C <span className="weather-label">{w.label}</span></b>
          <span className="weather-loc">
            <MapPin size={10} /> {w.location}{w.country ? `, ${w.country}` : ''}
            {w.tag === 'hq' && <span className="badge amber"><Building2 size={9} /> Account location</span>}
          </span>
          <span className="weather-meta">
            {w.tmin}° / {w.tmax}° · <Wind size={11} /> {w.wind} km/h
            {w.rainChance != null && <> · <Droplets size={11} /> {w.rainChance}%</>}
          </span>
          {w.works?.length > 0 && (
            <span className="weather-works">
              <HardHat size={10} /> {w.works.join(' · ')}
            </span>
          )}
          {rainy && <span className="weather-warn">Rain likely - plan pours & deliveries early</span>}
        </div>
      </div>
      {w.days?.length > 1 && (
        <div className="weather-days">
          {w.days.map((d, i) => {
            const D = WX_ICON[d.icon] ?? WX_ICON.cloud
            return (
              <div className={`wday ${i === 0 ? 'today' : ''}`} key={d.date}
                title={`${d.label}${d.rain != null ? ` · ${d.rain}% rain` : ''}`}>
                <span className="wday-name">{dayName(d.date, i)}</span>
                <D.Icon size={15} color={D.color} strokeWidth={1.8} />
                <b>{d.tmax}°</b>
                <span className="wday-min">{d.tmin}°</span>
                {d.rain != null && d.rain >= 50
                  ? <span className="wday-rain">{d.rain}%</span>
                  : <span className="wday-rain none">·</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Compact topbar chip: today's icon + temperature; click to expand the full
// 7-day forecast for every project site.
export function WeatherWidget() {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => { api('/weather').then(setItems).catch(() => {}) }, [])
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  if (!items.length) return null
  const first = items[0]
  const { Icon, color } = WX_ICON[first.icon] ?? WX_ICON.cloud
  const rainyAny = items.some((w) => w.rainChance != null && w.rainChance >= 50)

  return (
    <div className="weather-widget" ref={ref}>
      <button className="weather-chip" onClick={() => setOpen((o) => !o)}
        title={`${first.location}${first.country ? ', ' + first.country : ''}: ${first.temp}°C, ${first.label} - click for the 7-day forecast of every site`}>
        <Icon size={16} color={color} strokeWidth={2} />
        <b>{first.temp}°</b>
        {rainyAny && <span className="weather-chip-dot" title="Rain expected on a site today" />}
      </button>
      {open && (
        <div className="weather-pop">
          <div className="weather-pop-head">Site weather - 7-day forecast</div>
          {items.map((w) => <WeatherCard w={w} key={w.location} />)}
        </div>
      )}
    </div>
  )
}
