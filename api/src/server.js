import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { authRequired, requireClient } from './auth.js'
import { uploadsHandler, discardUploads } from './uploads.js'
import authRoutes from './routes/auth.js'
import demoRoutes from './routes/demo.js'
import accountRoutes from './routes/account.js'
import userRoutes from './routes/users.js'
import projectRoutes from './routes/projects.js'
import stockRoutes from './routes/stock.js'
import docsRoutes from './routes/docs.js'
import attendanceRoutes from './routes/attendance.js'
import billingRoutes from './routes/billing.js'
import miscRoutes from './routes/misc.js'

const app = express()

// API responses must never be cached by the browser.
//
// Express adds an ETag to every JSON response. With no Cache-Control the
// browser is free to store the response *and its headers*, then revalidate with
// If-None-Match. On a 304 it replays the CACHED headers - including the
// x-refresh-token issued during whichever session first populated that entry.
// The web client saves that token, so a long-dead session's token silently
// replaced the live one and the next request was rejected as expired. That is
// what made a fresh login survive exactly one interaction.
//
// Responses are per-user and change constantly; there is nothing to gain by
// caching them and a session to lose.
app.set('etag', false)
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  next()
})

// CORS used to allow every origin. In production the web app is served by this
// same process, so no cross-origin call is legitimate; in dev the Vite server
// on :5330 is. CORS_ORIGINS (comma-separated) overrides for split deployments.
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.APP_URL || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
app.use(cors({
  origin(origin, cb) {
    // same-origin / curl / server-to-server requests send no Origin header
    if (!origin) return cb(null, true)
    cb(null, allowedOrigins.includes(origin.replace(/\/$/, '')))
  },
  credentials: true,
  exposedHeaders: ['x-refresh-token'],
}))
app.use(express.json({ limit: '2mb' }))

// Lightweight performance tracker for the Super Admin system panel: every API
// request is timed on the way out; the last 500 samples give avg + p95.
const perf = { count: 0, totalMs: 0, samples: [], startedAt: Date.now() }
app.set('perf', perf)
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint()
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api/')) return
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    perf.count += 1
    perf.totalMs += ms
    perf.samples.push(ms)
    if (perf.samples.length > 500) perf.samples.shift()
  })
  next()
})

// Unauthenticated liveness probe for Docker/compose healthchecks.
app.get('/healthz', (_req, res) => res.json({ ok: true }))

// Uploads are NOT a static mount: every file is resolved back to the record
// that owns it and checked against the caller's account (see uploads.js).
app.use('/uploads', uploadsHandler)

app.use('/api/auth', authRoutes)
app.use('/api/demo', demoRoutes)
// /account works without a company (a Super Admin still has a profile).
app.use('/api/account', authRequired, accountRoutes)
// Everything below is workspace data and needs a company in context.
app.use('/api/team', authRequired, requireClient, userRoutes)
app.use('/api/projects', authRequired, requireClient, projectRoutes)
app.use('/api/stock', authRequired, requireClient, stockRoutes)
app.use('/api/docs', authRequired, requireClient, docsRoutes)
app.use('/api/attendance', authRequired, requireClient, attendanceRoutes)
app.use('/api/billing', authRequired, requireClient, billingRoutes)
// misc carries BOTH workspace routes and the Super Admin platform panel, so the
// company check is applied inside it (everything except /admin/*).
app.use('/api', authRequired, miscRoutes)

// Production: serve the built web app (web/dist) from this same server, so one
// Node process + MySQL is the whole deployment. In dev, Vite serves the web
// app itself and proxies /api here, so this block simply finds no dist folder.
const WEB_DIST = path.resolve('../web/dist')
if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  app.use(express.static(WEB_DIST))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next()
    res.sendFile(path.join(WEB_DIST, 'index.html'))
  })
  console.log('Serving web app from', WEB_DIST)
}

app.use((err, req, res, next) => {
  console.error(err)
  // Uploads land on disk before the handler runs; a request that dies here must
  // not leave them behind.
  discardUploads(req)
  // A failure mid-stream (e.g. PDF generation) has already sent headers -
  // writing a JSON body on top throws a second, more confusing error.
  if (res.headersSent) return req.socket?.destroy()
  if (err?.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: 'That file is too large' })
  if (err?.code === 'LIMIT_FILE_COUNT')
    return res.status(413).json({ error: 'Too many files in one upload' })
  if (err?.code === 'UNSUPPORTED_FILE_TYPE') return res.status(400).json({ error: err.message })
  // Handlers throw with an explicit status for expected, user-facing failures
  // (e.g. stock running out mid-transaction).
  if (err?.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message })
  res.status(500).json({ error: 'Server error' })
})

const PORT = process.env.PORT || 4311
app.listen(PORT, () => console.log(`VEXCORE API on :${PORT}`))
