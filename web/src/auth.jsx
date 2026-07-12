import { createContext, useContext, useEffect, useState } from 'react'
import { api, setToken } from './api.js'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!localStorage.getItem('bridge_token')) { setLoading(false); return }
    api('/auth/me')
      .then((s) => setSession(s))
      .catch(() => setToken(null))
      .finally(() => setLoading(false))
  }, [])

  const login = (s) => { setToken(s.token); setSession(s) }
  const logout = () => { setToken(null); setSession(null) }
  // Re-pull the session (e.g. after a payment is confirmed, so locks lift live)
  const refresh = () => api('/auth/me').then((s) => setSession(s)).catch(() => {})
  const updateClient = (patch) => setSession((s) => ({ ...s, client: { ...s.client, ...patch } }))
  const updateUser = (patch) => setSession((s) => ({ ...s, user: { ...s.user, ...patch } }))
  const setCaps = (caps) => setSession((s) => ({ ...s, caps }))

  const value = {
    loading,
    user: session?.user ?? null,
    client: session?.client ?? null,
    subscription: session?.subscription ?? null,
    impersonating: session?.impersonating ?? null,
    caps: session?.caps ?? [],
    can: (cap) => session?.caps?.includes(cap) || session?.caps?.includes('*'),
    login, logout, refresh, updateClient, updateUser, setCaps,
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
