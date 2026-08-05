let token = localStorage.getItem('bridge_token')

export function setToken(t) {
  token = t
  if (t) localStorage.setItem('bridge_token', t)
  else localStorage.removeItem('bridge_token')
}

// Drop every trace of a session: the working token, the Super Admin token
// parked during support mode (which used to survive logout and sit in
// localStorage for the next person at that machine), and the server's httpOnly
// cookie that authenticates image/file requests.
export function endSession() {
  setToken(null)
  localStorage.removeItem('bridge_super_token')
  // fire-and-forget: the page is usually reloading right after this
  fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch('/api' + path, {
    method, headers,
    body: form ? form : body ? JSON.stringify(body) : undefined,
  })
  // Sliding session: the server hands back a fresh 30-minute token on active
  // use - swap it in so the session only expires after 30 idle minutes.
  const fresh = res.headers.get('x-refresh-token')
  if (fresh && token) setToken(fresh)
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    // Account-wide 2FA became required while this session was live: drop the
    // token and send the user back to login, where setup is walked through.
    if (res.status === 401 && data?.need2faSetup && token) {
      endSession()
      window.location.hash = '#/login' // HashRouter route
      window.location.reload()
    }
    // Token idled past its window (e.g. browser left closed) → force logout,
    // saying WHY. Landing on a bare login screen mid-action reads as the app
    // throwing the user out for no reason.
    if (res.status === 401 && data?.sessionExpired && token) {
      endSession()
      sessionStorage.setItem('cms_idle_logout', '1')
      sessionStorage.setItem('cms_closed_reason', data.error ?? '')
      window.location.hash = '#/login'
      window.location.reload()
    }
    // The account was suspended, deleted or its company closed while the tab
    // was open. Without this the whole UI stays rendered and every button
    // fails silently with the same red note.
    if (res.status === 403 && data?.accountClosed && token) {
      endSession()
      sessionStorage.setItem('cms_closed_reason', data.error ?? '')
      window.location.hash = '#/login'
      window.location.reload()
    }
    const err = new Error(data?.error || `Request failed (${res.status})`)
    err.status = res.status
    err.need2fa = !!data?.need2fa
    err.need2faSetup = !!data?.need2faSetup
    err.setupToken = data?.setupToken ?? null
    throw err
  }
  return data
}

export const fmtMoney = (n, currency = 'RWF') =>
  n == null ? 'Hidden' : new Intl.NumberFormat('en-RW').format(n) + ' ' + currency

export const fmtDate = (d) => {
  if (!d) return '-'
  const date = new Date(d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const that = new Date(date); that.setHours(0, 0, 0, 0)
  const diff = Math.round((today - that) / 86400000)
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (diff === 0) return `Today, ${time}`
  if (diff === 1) return `Yesterday, ${time}`
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + (diff < 0 ? '' : `, ${time}`)
}

export const fmtDay = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '-'

// A calendar day as YYYY-MM-DD for date inputs and range filters, in the
// viewer's OWN timezone. toISOString() converts to UTC first, which silently
// shifts the date by a day for anyone west of UTC - "This month" then started
// on the 2nd and dropped the 1st from every figure on the page.
export const dayInput = (d = new Date()) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
