import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { PubNav, PubFoot } from './GetStarted.jsx'
import { Field, ErrorNote, useForm } from '../ui.jsx'

export default function Signup() {
  const { login } = useAuth()
  const nav = useNavigate()
  const [v, set] = useForm({
    company: '', name: '', email: '', password: '', contact: '',
    country: 'Rwanda', location: '', tin: '', currency: 'RWF',
  })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const session = await api('/auth/signup', { method: 'POST', body: v })
      login(session)
      nav('/')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <div className="public">
      <PubNav />
      <div className="auth-wrap">
        <div className="auth-card" style={{ maxWidth: 520 }}>
          <h2>Create your company account</h2>
          <p className="sub muted small">14-day free trial - no payment needed to start. Fields marked * are required.</p>
          <ErrorNote error={error} />
          <form onSubmit={submit}>
            <div className="grid grid-2" style={{ gap: 0, columnGap: 12 }}>
              <Field label="Company name *"><input value={v.company} onChange={set('company')} required autoFocus /></Field>
              <Field label="Your name"><input value={v.name} onChange={set('name')} placeholder="Account owner" /></Field>
              <Field label="Email *"><input type="email" value={v.email} onChange={set('email')} required /></Field>
              <Field label="Password * (min 8 chars)"><input type="password" value={v.password} onChange={set('password')} required minLength={8} /></Field>
              <Field label="Contact number *"><input value={v.contact} onChange={set('contact')} required placeholder="+250 …" /></Field>
              <Field label="Country *">
                <select value={v.country} onChange={set('country')}>
                  {['Rwanda', 'Kenya', 'Uganda', 'Tanzania', 'Burundi', 'DR Congo', 'Other'].map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Location *"><input value={v.location} onChange={set('location')} required placeholder="City / district" /></Field>
              <Field label="TIN number"><input value={v.tin} onChange={set('tin')} placeholder="Optional" /></Field>
            </div>
            <Field label="Currency (used across your projects)">
              <select value={v.currency} onChange={set('currency')}>
                <option value="RWF">RWF - Rwandan Franc</option>
                <option value="USD">USD - US Dollar</option>
                <option value="KES">KES - Kenyan Shilling</option>
                <option value="UGX">UGX - Ugandan Shilling</option>
                <option value="TZS">TZS - Tanzanian Shilling</option>
              </select>
            </Field>
            <button className="btn big" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              {busy ? 'Creating account…' : 'Start Free Trial'}
            </button>
            <div className="mt small" style={{ textAlign: 'center' }}>
              Already have an account? <Link className="plain" to="/login">Log in</Link>
            </div>
          </form>
        </div>
      </div>
      <PubFoot />
    </div>
  )
}
