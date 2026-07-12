// Subscription plans - the server-side source of truth for pricing and limits.
// Prices are RWF per month. `projects` = max active (non-Done) projects;
// `roles` = team roles the plan may create. null = unlimited.
export const PLANS = {
  STARTER: { name: 'Starter', price: 30_000, currency: 'RWF', projects: 1, roles: ['SENIOR', 'GUEST'] },
  PRO: { name: 'Pro', price: 80_000, currency: 'RWF', projects: 5, roles: ['SENIOR', 'SITE', 'STOCK', 'GUEST'] },
  ENTERPRISE: { name: 'Enterprise', price: null, currency: 'RWF', projects: null, roles: ['SENIOR', 'SITE', 'STOCK', 'GUEST'] },
}

// Where subscribers send the money (manual MoMo flow until a payment API is wired in).
export const MOMO = {
  number: process.env.MOMO_NUMBER || '0788 123 456',
  name: process.env.MOMO_NAME || 'Bridge Construction Ltd',
}

export function subscriptionOf(client) {
  if (!client) return null
  const now = Date.now()
  let expiresAt = null
  let expired = false
  if (client.status === 'TRIAL') {
    expiresAt = client.trialEndsAt
    expired = !!client.trialEndsAt && new Date(client.trialEndsAt).getTime() < now
  } else if (client.status === 'ACTIVE') {
    expiresAt = client.paidUntil
    expired = !!client.paidUntil && new Date(client.paidUntil).getTime() < now
  }
  return {
    status: client.status,
    plan: client.plan,
    trialEndsAt: client.trialEndsAt,
    paidUntil: client.paidUntil,
    expiresAt,
    expired,
  }
}

// Limits that apply to a client right now. Trials get the full product so they
// can evaluate everything; limits bite once a paid plan is active.
export function planLimits(client) {
  if (client?.status === 'ACTIVE' && client.plan && PLANS[client.plan]) return PLANS[client.plan]
  return PLANS.ENTERPRISE
}
