// Minimal fixed-window rate limiter. Deliberately dependency-free and
// in-process: this deployment is a single Node process, and the goal is to stop
// unlimited password / TOTP / backup-code guessing and reset-token flooding,
// not to survive a distributed attack. If the API is ever scaled to several
// replicas this needs to move to a shared store (Redis).

const buckets = new Map()

// Housekeeping: without this the Map grows one entry per distinct IP forever.
const SWEEP_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key)
}, SWEEP_MS).unref?.()

function clientIp(req) {
  // trust proxy is not enabled, so req.ip is the socket peer. Behind a reverse
  // proxy the operator should set TRUST_PROXY=1 so the real client is limited
  // rather than the proxy itself.
  if (process.env.TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (fwd) return fwd
  }
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/**
 * @param {object} opts
 * @param {number} opts.windowMs  length of the window
 * @param {number} opts.max       allowed requests per key per window
 * @param {string} opts.name      bucket namespace (so routes don't share counts)
 * @param {(req: any) => string} [opts.keyBy] extra key part, e.g. the email being tried
 */
export function rateLimit({ windowMs, max, name, keyBy }) {
  return (req, res, next) => {
    const key = `${name}:${clientIp(req)}:${keyBy ? keyBy(req) : ''}`
    const now = Date.now()
    let b = buckets.get(key)
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs }
      buckets.set(key, b)
    }
    b.count += 1
    if (b.count > max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({
        error: `Too many attempts - wait ${retryAfter > 60 ? Math.ceil(retryAfter / 60) + ' minutes' : retryAfter + ' seconds'} and try again`,
      })
    }
    next()
  }
}

// Clear a key's counter - called after a successful login so a legitimate user
// who fat-fingered their password a few times is not left throttled.
export function resetLimit(name, req, keyPart = '') {
  buckets.delete(`${name}:${clientIp(req)}:${keyPart}`)
}
