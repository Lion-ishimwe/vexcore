import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Copy, Download, CheckCircle2 } from 'lucide-react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { useT, LanguageDropdown } from '../i18n.jsx'
import { PubNav, PubFoot } from './GetStarted.jsx'
import { Field, ErrorNote, useForm } from '../ui.jsx'

export default function Login() {
  const { login } = useAuth()
  const { t } = useT()
  const nav = useNavigate()
  const [v, set, setAll] = useForm({ email: '', password: '' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState('login') // login | totp | forgot | reset | setup2fa
  const [totp, setTotp] = useState('')
  const [resetInfo, setResetInfo] = useState(null)
  const [reset, setResetV] = useState({ token: '', password: '', confirm: '' })
  const loc = useLocation()
  // Set when the 30-minute inactivity auto-logout brought the user here.
  const [idleNotice, setIdleNotice] = useState(false)
  useEffect(() => {
    if (sessionStorage.getItem('cms_idle_logout') === '1') {
      sessionStorage.removeItem('cms_idle_logout')
      setIdleNotice(true)
    }
  }, [])

  // Shareable reset link (#/login?reset=TOKEN) - e.g. generated from the Team page.
  useEffect(() => {
    const tok = new URLSearchParams(loc.search).get('reset')
    if (tok) {
      setResetV((s) => ({ ...s, token: tok }))
      setMode('reset')
    }
  }, [loc.search])
  // Forced 2FA setup (account enforces 2FA and this user hasn't set it up yet)
  const [setupToken, setSetupToken] = useState(null)
  const [setupData, setSetupData] = useState(null) // { qr, secret }
  const [setupCode, setSetupCode] = useState('')
  const [setupBackup, setSetupBackup] = useState(null)
  const [pendingSession, setPendingSession] = useState(null)

  const enter = (session) => {
    login(session)
    nav(session.user.role === 'SUPER' ? '/admin' : '/')
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const session = await api('/auth/login', { method: 'POST', body: { ...v, totp } })
      enter(session)
    } catch (err) {
      if (err.need2faSetup && err.setupToken) {
        setSetupToken(err.setupToken)
        setMode('setup2fa')
        try {
          setSetupData(await api('/auth/2fa/setup', { method: 'POST', body: { setupToken: err.setupToken } }))
        } catch (e2) { setError(e2.message) }
      } else if (err.need2fa) {
        // Password accepted - move to the dedicated verification step.
        if (mode === 'totp') setError(err.message) // wrong code
        else { setMode('totp'); setError(null) }
      } else setError(err.message)
    } finally { setBusy(false) }
  }

  const confirmSetup = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const r = await api('/auth/2fa/enable', { method: 'POST', body: { setupToken, code: setupCode } })
      setSetupBackup(r.backupCodes)
      setPendingSession(r.session)
      setSetupData(null); setSetupCode('')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const copyBackup = () => navigator.clipboard?.writeText(setupBackup.join('\n'))
  const downloadBackup = () => {
    const blob = new Blob([
      `CMS (Construction Management System) - 2FA backup codes for ${v.email}\n` +
      `Each code works exactly once. Keep them somewhere safe.\n\n` +
      setupBackup.join('\n') + '\n',
    ], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'bridge-backup-codes.txt'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const forgot = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const r = await api('/auth/forgot', { method: 'POST', body: { email: v.email } })
      if (r.emailed) {
        setMode('sent') // the reset link went to their inbox
      } else {
        // dev mode (no mailer configured): the token comes back directly
        setResetInfo(r.devToken ?? null)
        setResetV((s) => ({ ...s, token: r.devToken ?? '' }))
        setMode('reset')
      }
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const doReset = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      if (reset.password !== reset.confirm) throw new Error('The two passwords do not match')
      await api('/auth/reset', { method: 'POST', body: { token: reset.token, password: reset.password } })
      setMode('login'); setError(null)
      setAll((s) => ({ ...s, password: '' }))
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <div className="public">
      <PubNav />
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12 }}>
            <h2>
              {mode === 'login' ? t('login.title') :
               mode === 'totp' ? 'Two-step verification' :
               mode === 'forgot' ? 'Forgot password' :
               mode === 'sent' ? 'Check your email' :
               mode === 'setup2fa' ? 'Set up two-factor authentication' :
               'Set a new password'}
            </h2>
            <LanguageDropdown />
          </div>
          <p className="sub muted small">
            {mode === 'login' ? t('login.sub') :
             mode === 'totp' ? `Enter the code from your authenticator app - or one of your backup codes - to finish logging in as ${v.email}.` :
             mode === 'forgot' ? 'Enter your email and we’ll send a reset link.' :
             mode === 'sent' ? `If an account exists for ${v.email}, a reset link is on its way - it works for 1 hour. Check the spam folder too.` :
             mode === 'setup2fa' ? 'Your account requires 2FA for all users - finish this one-time setup to continue.' :
             'Reset link generated - choose a new password.'}
          </p>
          <ErrorNote error={error} />
          {idleNotice && mode === 'login' && (
            <div className="ok-note" style={{ marginBottom: 12 }}>
              You were logged out automatically after 30 minutes of inactivity - log in to continue.
            </div>
          )}

          {mode === 'login' && (
            <form onSubmit={submit}>
              <Field label={t('login.email')}><input type="email" value={v.email} onChange={set('email')} required autoFocus /></Field>
              <Field label={t('login.password')}><input type="password" value={v.password} onChange={set('password')} required /></Field>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
                {busy ? t('login.busy') : t('login.btn')}
              </button>
              <div className="flex-between mt small">
                <a className="plain" href="#" onClick={(e) => { e.preventDefault(); setMode('forgot'); setError(null) }}>{t('login.forgot')}</a>
                <Link className="plain" to="/signup">{t('login.create')}</Link>
              </div>
            </form>
          )}

          {mode === 'totp' && (
            <form onSubmit={submit}>
              <Field label={t('login.totp')}>
                <input value={totp} onChange={(e) => setTotp(e.target.value)}
                  placeholder="123 456 or XXXX-XXXX" inputMode="numeric" autoFocus required />
              </Field>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
                {busy ? t('login.busy') : t('login.verify')}
              </button>
              <div className="mt small">
                <a className="plain" href="#" onClick={(e) => {
                  e.preventDefault()
                  setMode('login'); setError(null); setTotp('')
                }}>← Back to login</a>
              </div>
            </form>
          )}

          {mode === 'setup2fa' && setupData && (
            <div>
              <p className="small" style={{ marginBottom: 10 }}>
                <b>1.</b> Scan this QR code with an authenticator app
                (Google Authenticator, Authy, Microsoft Authenticator…):
              </p>
              <div className="qr-box">
                <img src={setupData.qr} alt="2FA QR code" />
                <div className="small muted">
                  Can't scan? Enter this key manually:
                  <code className="secret-code">{setupData.secret}</code>
                </div>
              </div>
              <form onSubmit={confirmSetup} className="mt">
                <p className="small" style={{ marginBottom: 8 }}><b>2.</b> Enter the 6-digit code the app shows:</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="code-input" value={setupCode} onChange={(e) => setSetupCode(e.target.value)}
                    placeholder="123 456" inputMode="numeric" autoFocus required />
                  <button className="btn" disabled={busy}>Verify & continue</button>
                </div>
              </form>
              <div className="mt small">
                <a className="plain" href="#" onClick={(e) => {
                  e.preventDefault()
                  setMode('login'); setError(null)
                  setSetupToken(null); setSetupData(null); setSetupCode('')
                }}>← Back to login</a>
              </div>
            </div>
          )}

          {mode === 'setup2fa' && setupBackup && (
            <div className="backup-box">
              <b>Backup codes - save them now, they are shown only once.</b>
              <p className="small muted">Each code logs you in exactly once if you lose your phone.</p>
              <div className="backup-grid">
                {setupBackup.map((c) => <code key={c}>{c}</code>)}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn ghost sm" onClick={copyBackup}><Copy size={12} /> Copy</button>
                <button className="btn ghost sm" onClick={downloadBackup}><Download size={12} /> Download .txt</button>
                <button className="btn sm" onClick={() => enter(pendingSession)}>
                  <CheckCircle2 size={12} /> I saved them - continue
                </button>
              </div>
            </div>
          )}

          {mode === 'sent' && (
            <div className="mt small">
              <a className="plain" href="#" onClick={(e) => { e.preventDefault(); setMode('login') }}>← Back to login</a>
            </div>
          )}

          {mode === 'forgot' && (
            <form onSubmit={forgot}>
              <Field label="Email"><input type="email" value={v.email} onChange={set('email')} required autoFocus /></Field>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>Send reset link</button>
              <div className="mt small"><a className="plain" href="#" onClick={(e) => { e.preventDefault(); setMode('login') }}>← Back to login</a></div>
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={doReset}>
              {resetInfo && <div className="ok-note">Dev mode: reset token issued directly (in production this arrives by email).</div>}
              {/* The token rides along invisibly from the email link (or dev
                  issuance) - the user only ever chooses their new password. */}
              {!reset.token && (
                <Field label="Reset token"><input value={reset.token} onChange={(e) => setResetV((s) => ({ ...s, token: e.target.value }))} required /></Field>
              )}
              <Field label="New password (min 8 characters)">
                <input type="password" value={reset.password} minLength={8} autoFocus
                  onChange={(e) => setResetV((s) => ({ ...s, password: e.target.value }))} required />
              </Field>
              <Field label="Confirm new password">
                <input type="password" value={reset.confirm} minLength={8}
                  onChange={(e) => setResetV((s) => ({ ...s, confirm: e.target.value }))} required />
              </Field>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>Set password</button>
              <div className="mt small"><a className="plain" href="#" onClick={(e) => { e.preventDefault(); setMode('login') }}>← Back to login</a></div>
            </form>
          )}
        </div>
      </div>
      <PubFoot />
    </div>
  )
}
