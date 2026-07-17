import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pencil, X } from 'lucide-react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { ErrorNote, Field } from '../ui.jsx'
import Account from './Account.jsx'

const TABS = [
  ['profile', 'Company Profile'],
  ['account', 'My Account'],
  ['access', 'Access Control'],
  ['guest', 'Guest Access'],
  ['attendance', 'Attendance'],
  ['security', 'Security'],
]

const ACCESS_TOGGLES = [
  { key: 'stockVisibleToSite', label: 'Stock visibility for Site Engineers', sub: 'Site Engineers can view stock status (quantities only)' },
  { key: 'mediaDownload', label: 'Media downloads', sub: 'Allow downloading progress photos and videos (in-app viewing is always on)' },
  { key: 'stockMgrEdit', label: 'Stock Manager can edit/delete products', sub: 'Otherwise additions are submitted for Senior Engineer approval' },
]

// Email notifications the company's users receive - each one can be switched
// off individually by the admin. (Password-reset emails always work - they're
// part of logging in, not a notification.)
const NOTIF_TOGGLES = [
  { key: 'emailPhaseDone', label: 'Phase completed', sub: 'Email the admins when a phase is signed off, with a link to its completion report' },
  { key: 'emailDailyReport', label: 'Daily report submitted', sub: 'Email the Senior Engineers and admins when a daily site report lands' },
  { key: 'emailLowStock', label: 'Low stock alert', sub: 'Email admins, Senior Engineers and Stock Managers when an item crosses its low-stock threshold' },
]

// Guest areas are view-only and enabled individually (money is never shown).
const GUEST_TOGGLES = [
  { key: 'guestPhases', label: 'Phases & tasks', sub: 'Guests can open the phase board and phase reports' },
  { key: 'guestSchedule', label: 'Schedule', sub: 'Guests can view the Gantt schedule and download the plan' },
  { key: 'guestUpdates', label: 'Daily updates', sub: 'Guests see the daily reports forwarded to the account' },
  { key: 'guestStock', label: 'Stock', sub: 'Guests can view stock levels - quantities only, never amounts' },
]

export default function Settings() {
  const { user, client, updateClient, setCaps, logout } = useAuth()
  const nav = useNavigate()
  const [tab, setTab] = useState('profile')
  const [settings, setSettings] = useState(client.settings)
  const [profile, setProfile] = useState({
    company: client.company ?? '', tin: client.tin ?? '', location: client.location ?? '',
    contact: client.contact ?? '', currency: client.currency,
  })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(profile)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [newType, setNewType] = useState('')
  const workerTypes = settings.workerTypes ?? ['builder', 'helper']

  const addWorkerType = async () => {
    const t = newType.trim().toLowerCase()
    if (!t) return
    if (workerTypes.some((x) => x.toLowerCase() === t)) { setNewType(''); return }
    if (await save({ workerTypes: [...workerTypes, t] })) setNewType('')
  }

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
      if (!ok) return false
    }
    try {
      const r = await api('/settings', { method: 'PATCH', body: patch })
      setSettings(r.settings)
      const next = {
        company: r.company ?? profile.company, tin: r.tin ?? '', location: r.location ?? '',
        contact: r.contact ?? '', currency: r.currency,
      }
      setProfile(next)
      setDraft(next)
      updateClient({
        settings: r.settings, currency: r.currency, tin: r.tin,
        location: r.location, company: r.company, contact: r.contact,
      })
      if (r.caps) setCaps(r.caps)
      // 2FA is now enforced but the admin has none - force a fresh login,
      // where the setup flow (QR + backup codes) takes over.
      if (patch.twoFA === true && !user.totpEnabled) {
        logout()
        nav('/login')
        return true
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      return true
    } catch (err) { setError(err.message); return false }
  }

  const saveProfile = async (e) => {
    e.preventDefault()
    if (await save(draft)) setEditing(false)
  }

  const uploadLogo = async (file) => {
    setError(null); setSaved(false)
    try {
      const form = new FormData()
      form.append('logo', file)
      const r = await api('/settings/logo', { method: 'POST', form })
      updateClient({ logo: r.logo })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) { setError(err.message) }
  }

  const removeLogo = async () => {
    setError(null); setSaved(false)
    try {
      await api('/settings/logo', { method: 'DELETE' })
      updateClient({ logo: null })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) { setError(err.message) }
  }

  const Toggle = ({ t }) => (
    <div className="toggle-row" key={t.key}>
      <div>
        <div className="t-label">{t.label}</div>
        <div className="t-sub">{t.sub}</div>
      </div>
      <div className={`switch ${settings[t.key] ? 'on' : ''}`}
        onClick={() => save({ [t.key]: !settings[t.key] })} />
    </div>
  )

  const Row = ({ label, value }) => (
    <div className="profile-row"><span>{label}:</span><b>{value || '---'}</b></div>
  )

  return (
    <>
      <div className="set-tabs no-print">
        {TABS.map(([k, label]) => (
          <button key={k} className={`set-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {saved && <div className="ok-note" style={{ marginBottom: 12 }}>Saved ✓</div>}

      {/* ---------------- COMPANY PROFILE ---------------- */}
      {tab === 'profile' && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 18 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Company profile</h3>
            {!editing && (
              <button className="btn" onClick={() => { setDraft(profile); setEditing(true) }}>
                <Pencil size={13} /> Edit
              </button>
            )}
          </div>

          {!editing ? (
            <div className="profile-grid">
              <div>
                <Row label="Company Name" value={profile.company} />
                <Row label="Company Location" value={profile.location} />
                <Row label="Contact (shown on cards)" value={profile.contact} />
                <Row label="Country" value={client.country} />
              </div>
              <div>
                <Row label="Company TIN" value={profile.tin} />
                <Row label="Account Currency" value={profile.currency} />
                <Row label="Subscription" value={client.status === 'TRIAL' ? 'Free trial' : client.status} />
                <div className="profile-row">
                  <span>Billing:</span>
                  <button className="btn ghost sm" onClick={() => nav('/billing')}>Manage subscription</button>
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={saveProfile}>
              <div className="grid grid-2" style={{ gap: 0, columnGap: 24 }}>
                <Field label="Company name *">
                  <input value={draft.company} required
                    onChange={(e) => setDraft((d) => ({ ...d, company: e.target.value }))} />
                </Field>
                <Field label="Company TIN">
                  <input value={draft.tin} placeholder="e.g. 102030405"
                    onChange={(e) => setDraft((d) => ({ ...d, tin: e.target.value }))} />
                </Field>
                <Field label="Company location (city / district - drives the weather)">
                  <input value={draft.location} placeholder="e.g. Kigali"
                    onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))} />
                </Field>
                <Field label="Contact (phone / email shown on worker cards)">
                  <input value={draft.contact} placeholder="+250 …"
                    onChange={(e) => setDraft((d) => ({ ...d, contact: e.target.value }))} />
                </Field>
                <Field label="Account currency (new projects; existing keep theirs)">
                  <select value={draft.currency}
                    onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}>
                    {['RWF', 'USD', 'KES', 'UGX', 'TZS'].map((c) => <option key={c}>{c}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn">Save changes</button>
                <button type="button" className="btn ghost" onClick={() => { setEditing(false); setDraft(profile) }}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* ---------------- MY ACCOUNT (personal profile, language & branding) ---------------- */}
      {tab === 'account' && (
        <>
          <Account section="profile" />
          <div className="card" style={{ maxWidth: 620, marginTop: 16 }}>
            <h3>Branding</h3>
            <p className="small muted" style={{ margin: '6px 0 14px' }}>
              Your company logo is applied to everything that gets printed or exported - the schedule
              PDF and Excel, letterheads, and the workers' badges and ID cards.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
              <img src={client.logo || '/logo.png'} alt="Company logo"
                style={{ width: 84, height: 84, borderRadius: 16, objectFit: 'cover', border: '1.5px solid var(--border)', background: '#fff' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label className="btn sm" style={{ cursor: 'pointer' }}>
                    Upload logo
                    <input type="file" accept="image/*" hidden
                      onChange={(e) => { if (e.target.files[0]) uploadLogo(e.target.files[0]); e.target.value = '' }} />
                  </label>
                  {client.logo && <button className="btn ghost sm" onClick={removeLogo}>Use platform default</button>}
                </div>
                <span className="small muted">PNG or JPG · square images look best on cards {client.logo ? '· currently using your logo' : '· currently using the platform default'}</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ---------------- ACCESS CONTROL ---------------- */}
      {tab === 'access' && (
        <>
          <div className="card">
            <h3>Access control</h3>
            <p className="small muted" style={{ margin: '6px 0 4px' }}>
              Role permissions - changes apply immediately to all users in your account.
            </p>
            {ACCESS_TOGGLES.map((t) => <Toggle t={t} key={t.key} />)}
          </div>

          <div className="card mt">
            <h3>Email notifications</h3>
            <p className="small muted" style={{ margin: '6px 0 4px' }}>
              Which events send an email to your team - switch any of them off without touching the in-app notifications.
            </p>
            {NOTIF_TOGGLES.map((t) => <Toggle t={t} key={t.key} />)}
          </div>

          <div className="card mt">
            <h3>Worker types</h3>
            <p className="small muted" style={{ margin: '6px 0 12px' }}>
              The site roles available when enrolling workers in Attendance - add the ones your
              sites use (mason, electrician, plumber, carpenter…). Existing workers keep their
              type if you remove one.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {workerTypes.map((t) => (
                <span className="chip" key={t} style={{ textTransform: 'capitalize' }}>
                  {t}
                  {workerTypes.length > 1 && (
                    <X size={12} style={{ cursor: 'pointer' }} title={`Remove ${t}`}
                      onClick={() => save({ workerTypes: workerTypes.filter((x) => x !== t) })} />
                  )}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, maxWidth: 380 }}>
              <input value={newType} placeholder="e.g. mason"
                onChange={(e) => setNewType(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addWorkerType())}
                style={{ flex: 1, padding: '8px 11px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 13, fontFamily: 'inherit' }} />
              <button className="btn sm" onClick={addWorkerType} disabled={!newType.trim()}>Add type</button>
            </div>
          </div>
        </>
      )}

      {/* ---------------- GUEST ACCESS ---------------- */}
      {tab === 'guest' && (
        <div className="card">
          <h3>Guest access</h3>
          <p className="small muted" style={{ margin: '6px 0 4px' }}>
            What view-only guests can open - each area is enabled individually. Changes apply at the guest's next page load.
          </p>
          {GUEST_TOGGLES.map((t) => <Toggle t={t} key={t.key} />)}
        </div>
      )}

      {/* ---------------- ATTENDANCE ---------------- */}
      {tab === 'attendance' && (
        <div className="card">
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
      )}

      {/* ---------------- SECURITY (account-wide policy + your own credentials) ---------------- */}
      {tab === 'security' && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3>Account-wide security</h3>
            <div className="toggle-row">
              <div>
                <div className="t-label">Two-factor authentication (2FA)</div>
                <div className="t-sub">Required for all users in this account - anyone without 2FA is asked to set it up at their next login</div>
              </div>
              <div className={`switch ${settings.twoFA ? 'on' : ''}`}
                onClick={() => save({ twoFA: !settings.twoFA })} />
            </div>
          </div>
          <div className="section-title">Your credentials</div>
          <Account section="security" />
        </>
      )}

    </>
  )
}
