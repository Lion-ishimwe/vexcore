import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  UserRound, KeyRound, ShieldCheck, ShieldOff, Copy, Download, CheckCircle2, Settings2,
} from 'lucide-react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { useT, LanguagePicker } from '../i18n.jsx'
import { Field, ErrorNote, Avatar } from '../ui.jsx'

// section: 'all' (standalone page) | 'profile' | 'security' - the latter two
// let the admin Settings tabs embed the same cards without duplication.
export default function Account({ section = 'all' }) {
  const { user, client, updateUser, can } = useAuth()
  const { t } = useT()
  const nav = useNavigate()
  const twoFAEnforced = !!client?.settings?.twoFA

  // profile
  const [profile, setProfile] = useState({ name: user.name, email: user.email })
  const [profileMsg, setProfileMsg] = useState(null)
  // password
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [pwMsg, setPwMsg] = useState(null)
  // 2fa
  const [setup, setSetup] = useState(null) // { qr, secret }
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState(null)
  const [disablePw, setDisablePw] = useState('')
  const [faMsg, setFaMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = (setMsg, fn) => async (e) => {
    e?.preventDefault()
    setBusy(true); setMsg(null)
    try { await fn() } catch (err) { setMsg({ error: err.message }) } finally { setBusy(false) }
  }

  const saveProfile = run(setProfileMsg, async () => {
    const r = await api('/account/profile', { method: 'PATCH', body: profile })
    updateUser(r)
    setProfileMsg({ ok: 'Profile updated' })
  })

  const uploadPhoto = async (file) => {
    setBusy(true); setProfileMsg(null)
    try {
      const form = new FormData()
      form.append('photo', file)
      const r = await api('/account/photo', { method: 'POST', form })
      updateUser({ photo: r.photo })
      setProfileMsg({ ok: 'Photo updated' })
    } catch (err) { setProfileMsg({ error: err.message }) } finally { setBusy(false) }
  }

  const removePhoto = run(setProfileMsg, async () => {
    await api('/account/photo', { method: 'DELETE' })
    updateUser({ photo: null })
    setProfileMsg({ ok: 'Photo removed - your initials show instead' })
  })

  const changePassword = run(setPwMsg, async () => {
    if (pw.next !== pw.confirm) throw new Error('New passwords do not match')
    await api('/account/password', { method: 'POST', body: { current: pw.current, next: pw.next } })
    setPw({ current: '', next: '', confirm: '' })
    setPwMsg({ ok: 'Password changed - use it on your next login' })
  })

  const start2fa = run(setFaMsg, async () => {
    setBackupCodes(null); setCode('')
    setSetup(await api('/account/2fa/setup', { method: 'POST' }))
  })

  const enable2fa = run(setFaMsg, async () => {
    const r = await api('/account/2fa/enable', { method: 'POST', body: { code } })
    setBackupCodes(r.backupCodes)
    setSetup(null); setCode('')
    updateUser({ totpEnabled: true })
    setFaMsg({ ok: 'Two-factor authentication is on' })
  })

  const disable2fa = run(setFaMsg, async () => {
    await api('/account/2fa/disable', { method: 'POST', body: { password: disablePw } })
    setDisablePw(''); setBackupCodes(null)
    updateUser({ totpEnabled: false })
    setFaMsg({ ok: 'Two-factor authentication is off' })
  })

  const copyCodes = () => navigator.clipboard?.writeText(backupCodes.join('\n'))
  const downloadCodes = () => {
    const blob = new Blob([
      `CMS (Construction Management System) - 2FA backup codes for ${user.email}\n` +
      `Each code works exactly once. Keep them somewhere safe.\n\n` +
      backupCodes.join('\n') + '\n',
    ], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'bridge-backup-codes.txt'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const Note = ({ msg }) => msg ? (
    msg.error ? <ErrorNote error={msg.error} /> : <div className="ok-note">{msg.ok}</div>
  ) : null

  const profileCards = (
    <>
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><UserRound size={14} /> {t('account.profile')}</h3>
          <form onSubmit={saveProfile} className="mt">
            <Note msg={profileMsg} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
              <label className="avatar-upload" title="Click to upload a photo" style={{ transform: 'scale(1.5)', transformOrigin: 'left center' }}>
                <Avatar name={user.name} photo={user.photo} />
                <input type="file" accept="image/*"
                  onChange={(e) => { if (e.target.files[0]) uploadPhoto(e.target.files[0]); e.target.value = '' }} />
              </label>
              <div style={{ flex: 1, display: 'flex', gap: 8 }}>
                <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
                  Upload photo
                  <input type="file" accept="image/*" hidden
                    onChange={(e) => { if (e.target.files[0]) uploadPhoto(e.target.files[0]); e.target.value = '' }} />
                </label>
                {user.photo && <button type="button" className="btn ghost sm" onClick={removePhoto}>Remove</button>}
              </div>
            </div>
            <Field label="Full name">
              <input value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} required />
            </Field>
            <Field label="Email (used to log in)">
              <input type="email" value={profile.email} onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))} required />
            </Field>
            <button className="btn" disabled={busy}>Save profile</button>
          </form>
        </div>

        <div className="card">
          <h3>{t('common.language')}</h3>
          <p className="small muted" style={{ margin: '6px 0 12px' }}>{t('account.languageSub')}</p>
          <LanguagePicker />
        </div>
    </>
  )

  const passwordCard = (
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><KeyRound size={14} /> {t('account.password')}</h3>
          <form onSubmit={changePassword} className="mt">
            <Note msg={pwMsg} />
            <Field label="Current password">
              <input type="password" value={pw.current} onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} required />
            </Field>
            <div className="grid grid-2" style={{ gap: 0, columnGap: 12 }}>
              <Field label="New password (min 8)">
                <input type="password" value={pw.next} onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} required minLength={8} />
              </Field>
              <Field label="Confirm new password">
                <input type="password" value={pw.confirm} onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} required minLength={8} />
              </Field>
            </div>
            <button className="btn" disabled={busy}>Change password</button>
          </form>
        </div>
  )

  const twoFACard = (
      <div className="card" style={{ alignSelf: 'start' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {user.totpEnabled ? <ShieldCheck size={14} color="var(--green)" /> : <ShieldOff size={14} />}
          Two-factor authentication
          <span className={`badge ${user.totpEnabled ? 'green' : 'gray'}`} style={{ marginLeft: 'auto' }}>
            {user.totpEnabled ? 'On' : 'Off'}
          </span>
        </h3>
        <div className="mt">
          <Note msg={faMsg} />

          {backupCodes && (
            <div className="backup-box">
              <b>Backup codes - save them now, they are shown only once.</b>
              <p className="small muted">Each code logs you in exactly once if you lose your phone.</p>
              <div className="backup-grid">
                {backupCodes.map((c) => <code key={c}>{c}</code>)}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn ghost sm" onClick={copyCodes}><Copy size={12} /> Copy</button>
                <button className="btn ghost sm" onClick={downloadCodes}><Download size={12} /> Download .txt</button>
                <button className="btn sm" onClick={() => setBackupCodes(null)}><CheckCircle2 size={12} /> I saved them</button>
              </div>
            </div>
          )}

          {!user.totpEnabled && !setup && !backupCodes && (
            <>
              <p className="small muted" style={{ marginBottom: 14 }}>
                Protect your account with a 6-digit code from an authenticator app
                (Google Authenticator, Authy, Microsoft Authenticator…). You'll scan a QR code
                and receive backup codes in case you lose your phone.
              </p>
              <button className="btn" onClick={start2fa} disabled={busy}><ShieldCheck size={14} /> Set up 2FA</button>
            </>
          )}

          {setup && (
            <div>
              <p className="small" style={{ marginBottom: 10 }}>
                <b>1.</b> Scan this QR code with your authenticator app:
              </p>
              <div className="qr-box">
                <img src={setup.qr} alt="2FA QR code" />
                <div className="small muted">
                  Can't scan? Enter this key manually:
                  <code className="secret-code">{setup.secret}</code>
                </div>
              </div>
              <form onSubmit={enable2fa} className="mt">
                <p className="small" style={{ marginBottom: 8 }}><b>2.</b> Enter the 6-digit code the app shows:</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="code-input" value={code} onChange={(e) => setCode(e.target.value)}
                    placeholder="123 456" inputMode="numeric" autoFocus required />
                  <button className="btn" disabled={busy}>Verify & enable</button>
                </div>
              </form>
            </div>
          )}

          {user.totpEnabled && !backupCodes && twoFAEnforced && (
            <div>
              <p className="small muted" style={{ marginBottom: 12 }}>
                Your account requires an authenticator code at every login.
                Two-factor authentication is required for all users in this account,
                so it cannot be turned off here.
              </p>
              {can('settings.edit') ? (
                <button className="btn ghost" onClick={() => nav('/settings')}>
                  <Settings2 size={13} /> Manage the account-wide requirement in Settings
                </button>
              ) : (
                <p className="small muted">
                  Only your administrator can turn off the account-wide requirement.
                </p>
              )}
            </div>
          )}

          {user.totpEnabled && !backupCodes && !twoFAEnforced && (
            <form onSubmit={disable2fa}>
              <p className="small muted" style={{ marginBottom: 12 }}>
                Your account requires an authenticator code at every login.
                To turn it off, confirm your password.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="password" placeholder="Account password" value={disablePw}
                  onChange={(e) => setDisablePw(e.target.value)} required
                  style={{ flex: 1, padding: '9px 12px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 13 }} />
                <button className="btn ghost" disabled={busy}><ShieldOff size={13} /> Disable</button>
              </div>
            </form>
          )}
        </div>
      </div>
  )

  if (section === 'profile')
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 620 }}>{profileCards}</div>

  if (section === 'security')
    return <div className="grid grid-2">{passwordCard}{twoFACard}</div>

  return (
    <div className="grid grid-2">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {profileCards}
        {passwordCard}
      </div>
      {twoFACard}
    </div>
  )
}
