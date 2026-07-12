import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { ErrorNote } from '../ui.jsx'

const TOGGLES = [
  { key: 'stockVisibleToSite', label: 'Stock visibility for Site Engineers', sub: 'Site Engineers can view stock status (quantities only)' },
  { key: 'mediaDownload', label: 'Media downloads', sub: 'Allow downloading progress photos and videos (in-app viewing is always on)' },
  { key: 'stockMgrEdit', label: 'Stock Manager can edit/delete products', sub: 'Otherwise additions are submitted for Senior Engineer approval' },
  { key: 'twoFA', label: 'Two-factor authentication (2FA)', sub: 'Required for all users in this account - anyone without 2FA is asked to set it up at their next login' },
  { key: 'guestAccess', label: 'Guest access', sub: 'View-only guests, scoped per project' },
]

export default function Settings() {
  const { user, client, updateClient, setCaps, logout } = useAuth()
  const nav = useNavigate()
  const [settings, setSettings] = useState(client.settings)
  const [currency, setCurrency] = useState(client.currency)
  const [tin, setTin] = useState(client.tin ?? '')
  const [location, setLocation] = useState(client.location ?? '')
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const save = async (patch) => {
    setError(null); setSaved(false)
    // Turning on account-wide 2FA affects every user - confirm, and warn the
    // admin they'll be logged out to set up their own 2FA if they lack it.
    if (patch.twoFA === true) {
      const ok = window.confirm(
        'Require two-factor authentication for all users in this account?\n\n' +
        'Everyone without 2FA will be asked to set it up (QR code + backup codes) at their next login.' +
        (user.totpEnabled ? '' : '\n\nYou have not set up 2FA yet, so you will be logged out now to set up yours.')
      )
      if (!ok) return
    }
    try {
      const r = await api('/settings', { method: 'PATCH', body: patch })
      setSettings(r.settings)
      setCurrency(r.currency)
      setTin(r.tin ?? '')
      setLocation(r.location ?? '')
      updateClient({ settings: r.settings, currency: r.currency, tin: r.tin, location: r.location })
      if (r.caps) setCaps(r.caps)
      // 2FA is now enforced but the admin has none - force a fresh login,
      // where the setup flow (QR + backup codes) takes over.
      if (patch.twoFA === true && !user.totpEnabled) {
        logout()
        nav('/login')
        return
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) { setError(err.message) }
  }

  return (
    <>
      <p className="muted" style={{ marginBottom: 16 }}>
        Every feature access is controlled here. Changes apply immediately to all users in your account.
        {saved && <span className="badge green" style={{ marginLeft: 10 }}>Saved ✓</span>}
      </p>
      <ErrorNote error={error} />

      <div className="grid grid-2">
        <div className="card">
          <h3>Permissions & feature toggles</h3>
          {TOGGLES.map((t) => (
            <div className="toggle-row" key={t.key}>
              <div>
                <div className="t-label">{t.label}</div>
                <div className="t-sub">{t.sub}</div>
              </div>
              <div className={`switch ${settings[t.key] ? 'on' : ''}`}
                onClick={() => save({ [t.key]: !settings[t.key] })} />
            </div>
          ))}
        </div>

        <div>
          <div className="card">
            <h3>Currency & billing</h3>
            <div className="toggle-row">
              <div>
                <div className="t-label">Account currency</div>
                <div className="t-sub">Applied to new projects; existing projects keep theirs</div>
              </div>
              <select value={currency} onChange={(e) => save({ currency: e.target.value })}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
                {['RWF', 'USD', 'KES', 'UGX', 'TZS'].map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="toggle-row">
              <div style={{ flex: 1, marginRight: 14 }}>
                <div className="t-label">Company location</div>
                <div className="t-sub">City / district - drives the account weather and appears on documents</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input value={location} onChange={(e) => setLocation(e.target.value)}
                    placeholder="e.g. Kigali"
                    style={{ flex: 1, padding: '8px 11px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, fontFamily: 'inherit' }} />
                  <button className="btn sm" onClick={() => save({ location })}
                    disabled={(client.location ?? '') === location.trim()}>
                    Save
                  </button>
                </div>
              </div>
            </div>
            <div className="toggle-row">
              <div style={{ flex: 1, marginRight: 14 }}>
                <div className="t-label">TIN number</div>
                <div className="t-sub">Tax identification number - used on invoices and reports</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input value={tin} onChange={(e) => setTin(e.target.value)}
                    placeholder="e.g. 102030405"
                    style={{ flex: 1, padding: '8px 11px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, fontFamily: 'inherit' }} />
                  <button className="btn sm" onClick={() => save({ tin })}
                    disabled={(client.tin ?? '') === tin.trim()}>
                    Save
                  </button>
                </div>
              </div>
            </div>
            <div className="toggle-row">
              <div>
                <div className="t-label">Subscription</div>
                <div className="t-sub">
                  {client.status === 'TRIAL' ? 'Free trial - subscribe to keep your account active' : client.status}
                  {' · '}pay by MTN MoMo on the Billing page
                </div>
              </div>
              <button className="btn sm" onClick={() => nav('/billing')}>Manage</button>
            </div>
          </div>

          <div className="card mt">
            <h3>Attendance time windows</h3>
            <div className="toggle-row">
              <div>
                <div className="t-label">Enforce clock-in / clock-out hours</div>
                <div className="t-sub">Card taps and manual ticks outside the windows are not recorded</div>
              </div>
              <div className={`switch ${settings.attWindows ? 'on' : ''}`}
                onClick={() => save({ attWindows: !settings.attWindows })} />
            </div>
            {settings.attWindows && (
              <div className="att-window-grid">
                <label>Clock-in from
                  <input type="time" value={settings.attInStart}
                    onChange={(e) => save({ attInStart: e.target.value })} />
                </label>
                <label>until
                  <input type="time" value={settings.attInEnd}
                    onChange={(e) => save({ attInEnd: e.target.value })} />
                </label>
                <label>Clock-out from
                  <input type="time" value={settings.attOutStart}
                    onChange={(e) => save({ attOutStart: e.target.value })} />
                </label>
                <label>until
                  <input type="time" value={settings.attOutEnd}
                    onChange={(e) => save({ attOutEnd: e.target.value })} />
                </label>
              </div>
            )}
          </div>

          <div className="card mt">
            <h3>Branding</h3>
            <div className="toggle-row">
              <div>
                <div className="t-label">Company logo & theme</div>
                <div className="t-sub">Per-client branding - arriving in Phase 4</div>
              </div>
              <button className="btn ghost sm" disabled>Coming soon</button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
