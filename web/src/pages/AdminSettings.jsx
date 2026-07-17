import { useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { api } from '../api.js'
import { ErrorNote } from '../ui.jsx'
import Account from './Account.jsx'

// Super Admin settings: platform-wide options + the operator's own account
// security (profile, password, two-factor authentication).
export default function AdminSettings() {
  const [remDays, setRemDays] = useState('')
  const [savedDays, setSavedDays] = useState(false)
  const [current, setCurrent] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/admin/settings')
      .then((s) => { setCurrent(s.renewalReminderDays); setRemDays(String(s.renewalReminderDays)) })
      .catch((e) => setError(e.message))
  }, [])

  const saveDays = async () => {
    setError(null); setSavedDays(false)
    try {
      await api('/admin/settings', { method: 'PATCH', body: { renewalReminderDays: +remDays } })
      setCurrent(+remDays)
      setSavedDays(true)
      setTimeout(() => setSavedDays(false), 2000)
    } catch (err) { setError(err.message) }
  }

  return (
    <>
      <ErrorNote error={error} />

      <div className="section-title" style={{ marginTop: 0 }}>Platform settings</div>
      <div className="card">
        <div className="toggle-row" style={{ borderBottom: 'none' }}>
          <div>
            <div className="t-label" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Settings2 size={14} /> Renewal reminder window
            </div>
            <div className="t-sub">Show a reminder when a company's trial or paid coverage ends within this many days</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" min="1" max="60" value={remDays}
              onChange={(e) => setRemDays(e.target.value)}
              style={{ width: 70, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }} />
            <span className="small muted">days</span>
            <button className="btn sm" onClick={saveDays} disabled={current != null && +remDays === current}>Save</button>
            {savedDays && <span className="badge green">Saved ✓</span>}
          </div>
        </div>
      </div>

      <div className="section-title">Account security & authentication</div>
      <Account />
    </>
  )
}
