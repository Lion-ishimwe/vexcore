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

// A forced sign-out must happen exactly ONCE per session, however many requests
// discover the problem at the same moment.
//
// A page like the dashboard fires a dozen requests at once. When the session has
// expired every one of them comes back 401, and every one used to run the whole
// eviction: clear the token, call /auth/logout, reload. The reload does not stop
// the JavaScript already in flight, so handlers kept resolving *after* the user
// had reached the login screen and signed back in - and one of those late
// handlers then cleared the BRAND NEW token. The next click was unauthenticated,
// which threw the user out again and looked like "the session expired instantly".
//
// The flag survives only until the page reloads, which is precisely the lifetime
// we want: one eviction, then a clean slate.
let loggingOut = false

function forceLogout({ reason, idle } = {}) {
  if (loggingOut) return // a sibling request already handled it
  loggingOut = true
  endSession()
  if (idle) sessionStorage.setItem('cms_idle_logout', '1')
  if (reason) sessionStorage.setItem('cms_closed_reason', reason)
  window.location.hash = '#/login'
  window.location.reload()
}

export async function api(path, { method = 'GET', body, form } = {}) {
  // Once an eviction is under way the page is on its way out; firing more
  // requests with a token we have just discarded only produces more 401s.
  if (loggingOut) throw new Error('Session ended')
  const headers = {}
  // Read through setToken's variable, but remember exactly which token this
  // request went out with - see the guard on the refresh below.
  const sentWith = token
  if (sentWith) headers.Authorization = 'Bearer ' + sentWith
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch('/api' + path, {
    method, headers,
    body: form ? form : body ? JSON.stringify(body) : undefined,
  })
  // Sliding session: the server hands back a fresh 30-minute token on active
  // use - swap it in so the session only expires after 30 idle minutes.
  //
  // Only accept it if the session has not moved on in the meantime. When a
  // session expires, requests from the dead session are still in flight; if the
  // user reaches the login screen and signs in before those land, storing their
  // refresh token would overwrite the BRAND NEW token with one belonging to the
  // dead session. The very next click then failed as "expired" - which is why
  // logging back in appeared to last exactly one interaction.
  const fresh = res.headers.get('x-refresh-token')
  if (fresh && token && token === sentWith) setToken(fresh)
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    // Account-wide 2FA became required while this session was live: drop the
    // token and send the user back to login, where setup is walked through.
    if (res.status === 401 && data?.need2faSetup && token) {
      forceLogout({ reason: data.error })
    }
    // Token idled past its window (e.g. browser left closed) → force logout,
    // saying WHY. Landing on a bare login screen mid-action reads as the app
    // throwing the user out for no reason.
    else if (res.status === 401 && data?.sessionExpired && token) {
      forceLogout({ idle: true, reason: data.error })
    }
    // The account was suspended, deleted or its company closed while the tab
    // was open. Without this the whole UI stays rendered and every button
    // fails silently with the same red note.
    else if (res.status === 403 && data?.accountClosed && token) {
      forceLogout({ reason: data.error })
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
