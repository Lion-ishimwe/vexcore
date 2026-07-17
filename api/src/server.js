import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { authRequired } from './auth.js'
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
app.use(cors())
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

app.use('/uploads', express.static(path.resolve('uploads')))

app.use('/api/auth', authRoutes)
app.use('/api/demo', demoRoutes)
app.use('/api/account', authRequired, accountRoutes)
app.use('/api/team', authRequired, userRoutes)
app.use('/api/projects', authRequired, projectRoutes)
app.use('/api/stock', authRequired, stockRoutes)
app.use('/api/docs', authRequired, docsRoutes)
app.use('/api/attendance', authRequired, attendanceRoutes)
app.use('/api/billing', authRequired, billingRoutes)
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

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: 'Server error' })
})

const PORT = process.env.PORT || 4311
app.listen(PORT, () => console.log(`Bridge API on :${PORT}`))
