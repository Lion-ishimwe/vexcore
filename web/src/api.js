let token = localStorage.getItem('bridge_token')

export function setToken(t) {
  token = t
  if (t) localStorage.setItem('bridge_token', t)
  else localStorage.removeItem('bridge_token')
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch('/api' + path, {
    method, headers,
    body: form ? form : body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    // Account-wide 2FA became required while this session was live: drop the
    // token and send the user back to login, where setup is walked through.
    if (res.status === 401 && data?.need2faSetup && token) {
      setToken(null)
      window.location.hash = '#/login' // HashRouter route
      window.location.reload()
    }
    const err = new Error(data?.error || `Request failed (${res.status})`)
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
