// Subscription plans - the server-side source of truth for pricing and limits.
// Prices are RWF per month. EVERY plan gets the full feature set and full
// team roles - plans differ ONLY in how many active (non-Done) projects they
// allow (null = unlimited). Feature gating per plan may return once we know
// the market better.
const ALL_ROLES = ['SENIOR', 'SITE', 'STOCK', 'GUEST']
export const PLANS = {
  STARTER: { name: 'Starter', price: 30_000, currency: 'RWF', projects: 1, roles: ALL_ROLES },
  PRO: { name: 'Pro', price: 80_000, currency: 'RWF', projects: 5, roles: ALL_ROLES },
  ENTERPRISE: { name: 'Enterprise', price: 100_000, currency: 'RWF', projects: null, roles: ALL_ROLES },
}

// Where subscribers send the money (manual MoMo flow until a payment API is wired in).
export const MOMO = {
  number: process.env.MOMO_NUMBER || '0788 123 456',
  name: process.env.MOMO_NAME || 'VEXCORE',
}

// Paid subscriptions get a short grace window: when coverage ends, the client
// keeps working for GRACE_DAYS extra days under a renewal warning before the
// workspace locks. Applies to every paid plan - bought month by month or for
// several months at once. Trials still lock the moment they end.
export const GRACE_DAYS = 2

export function subscriptionOf(client) {
  if (!client) return null
  const now = Date.now()
  let expiresAt = null
  let expired = false
  let inGrace = false
  let graceEndsAt = null
  if (client.status === 'TRIAL') {
    expiresAt = client.trialEndsAt
    expired = !!client.trialEndsAt && new Date(client.trialEndsAt).getTime() < now
  } else if (client.status === 'ACTIVE') {
    expiresAt = client.paidUntil
    if (client.paidUntil) {
      const end = new Date(client.paidUntil).getTime()
      graceEndsAt = new Date(end + GRACE_DAYS * 86400000)
      expired = now > graceEndsAt.getTime() // locks only after the grace window
      inGrace = now > end && !expired
    }
  }
  return {
    status: client.status,
    plan: client.plan,
    trialEndsAt: client.trialEndsAt,
    paidUntil: client.paidUntil,
    expiresAt,
    expired,
    inGrace,
    graceEndsAt,
    graceDays: GRACE_DAYS,
  }
}

// Limits that apply to a client right now. Trials get the full product so they
// can evaluate everything; limits bite once a paid plan is active.
export function planLimits(client) {
  if (client?.status === 'ACTIVE' && client.plan && PLANS[client.plan]) return PLANS[client.plan]
  return PLANS.ENTERPRISE
}
