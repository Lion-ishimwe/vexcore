import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { db } from './db.js'
import { userFromToken, readCookie } from './auth.js'

export const UPLOADS = path.resolve('uploads')
fs.mkdirSync(UPLOADS, { recursive: true })

// Extensions we accept. Everything else is rejected at upload time. The point
// is not tidiness: .html/.htm/.svg/.xhtml/.xml served from our own origin run
// as first-party script, which would hand the reader's session token to
// whoever uploaded the file. Keep those out of this list.
const INLINE = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp',
  '.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.3gp',
  '.mp3', '.m4a', '.ogg', '.wav', '.aac',
  '.pdf',
])
const ATTACH = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt',
  '.odt', '.ods', '.odp', '.rtf', '.dwg', '.dxf', '.zip', '.rar', '.7z',
])
const ALLOWED = new Set([...INLINE, ...ATTACH])

export const allowedExtensions = [...ALLOWED].sort()

// The stored name is always server-generated; only the extension comes from the
// client, and only after it survives the allowlist.
function safeExt(originalname) {
  const ext = path.extname(String(originalname ?? '')).toLowerCase()
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return null
  return ALLOWED.has(ext) ? ext : null
}

function fileFilter(_req, file, cb) {
  if (safeExt(file.originalname)) return cb(null, true)
  const err = new Error(`"${file.originalname}" is not an accepted file type`)
  err.status = 400
  err.code = 'UNSUPPORTED_FILE_TYPE'
  cb(err)
}

// One multer factory for every upload route, so the type filter can never be
// forgotten on a new one. sizeMb defaults to the previous 50 MB cap.
export function uploader({ sizeMb = 50, files = 12 } = {}) {
  return multer({
    storage: multer.diskStorage({
      destination: UPLOADS,
      filename: (_req, file, cb) =>
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + safeExt(file.originalname)),
    }),
    limits: { fileSize: sizeMb * 1024 * 1024, files },
    fileFilter,
  })
}

// Uploads land on disk before the handler runs, so every path that rejects a
// request after that point has to clean up after itself or the disk fills with
// files no record points at.
export function discardUploads(req) {
  for (const f of req.files ?? (req.file ? [req.file] : [])) {
    fs.promises.unlink(f.path).catch(() => {})
  }
}

// Remove a stored file by its DB filename (best-effort - a missing file is
// not an error worth failing a delete over).
export function removeStoredFile(name) {
  if (!name || typeof name !== 'string') return
  const base = path.basename(name)
  fs.promises.unlink(path.join(UPLOADS, base)).catch(() => {})
}

// ---- Serving ----
//
// Uploads used to be a bare express.static mount ahead of all authentication,
// which made every private document, worker ID photo and chat attachment of
// every tenant downloadable by URL, logged out. Files are now resolved back to
// the record that owns them and checked against the caller's account.

// Filenames are immutable and their owner never changes, so the *location* of a
// file is safe to cache. Mutable bits (a document's visibility, a folder's
// restriction) are re-read per request.
const ownerCache = new Map()
const CACHE_MAX = 5000

function cacheOwner(name, owner) {
  if (ownerCache.size >= CACHE_MAX) ownerCache.clear()
  ownerCache.set(name, owner)
  return owner
}

// Which record does this filename belong to? Returns { clientId } for simple
// cases, or { docId } when access depends on document visibility.
async function locate(name) {
  if (ownerCache.has(name)) return ownerCache.get(name)

  const doc = await db.document.findFirst({ where: { path: name }, select: { id: true, clientId: true } })
  if (doc) return cacheOwner(name, { clientId: doc.clientId, docId: doc.id })

  const media = await db.media.findFirst({
    where: { path: name },
    select: { update: { select: { clientId: true } } },
  })
  if (media) return cacheOwner(name, { clientId: media.update.clientId })

  const worker = await db.worker.findFirst({ where: { photo: name }, select: { clientId: true } })
  if (worker) return cacheOwner(name, { clientId: worker.clientId })

  const user = await db.user.findFirst({ where: { photo: name }, select: { id: true, clientId: true } })
  if (user) return cacheOwner(name, { clientId: user.clientId, userId: user.id })

  const client = await db.client.findFirst({ where: { logo: name }, select: { id: true } })
  if (client) return cacheOwner(name, { clientId: client.id })

  // Chat attachments and key-insight proof live inside JSON columns; JSON_SEARCH
  // is the only way to look them up. Both queries are parameterised.
  const msg = await db.$queryRaw`
    SELECT clientId FROM Message WHERE JSON_SEARCH(attachments, 'one', ${name}) IS NOT NULL LIMIT 1`
  if (msg.length) return cacheOwner(name, { clientId: msg[0].clientId })

  const insight = await db.$queryRaw`
    SELECT p.clientId AS clientId FROM KeyInsight k
      JOIN Phase ph ON ph.id = k.phaseId
      JOIN Project p ON p.id = ph.projectId
     WHERE JSON_SEARCH(k.media, 'one', ${name}) IS NOT NULL LIMIT 1`
  if (insight.length) return cacheOwner(name, { clientId: insight[0].clientId })

  return cacheOwner(name, null)
}

export async function uploadsHandler(req, res) {
  const name = path.basename(decodeURIComponent(req.path.replace(/^\//, '')))
  if (!name || name.startsWith('.')) return res.status(404).end()

  // <img src> cannot carry an Authorization header, so the session token is
  // mirrored into an httpOnly cookie for exactly this purpose.
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : readCookie(req, 'bridge_session')
  const auth = await userFromToken(token)
  if (!auth) return res.status(401).json({ error: 'Not authenticated' })

  const owner = await locate(name)
  if (!owner) return res.status(404).end()

  if (auth.user.role !== 'SUPER') {
    if (owner.clientId !== auth.clientId) return res.status(404).end()
    if (owner.docId) {
      const doc = await db.document.findUnique({
        where: { id: owner.docId },
        select: { visibility: true, uploaderId: true, folder: { select: { restricted: true } } },
      })
      if (!doc) return res.status(404).end()
      const isOwnerOrAdmin = doc.uploaderId === auth.user.id || auth.user.role === 'CLIENT'
      if (doc.visibility === 'private' && !isOwnerOrAdmin) return res.status(404).end()
      if (doc.folder?.restricted && auth.user.role !== 'CLIENT') return res.status(404).end()
    }
  }

  const ext = path.extname(name).toLowerCase()
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.setHeader('Cache-Control', 'private, max-age=300')
  // Belt and braces alongside the upload allowlist: anything that is not a
  // media type the browser needs to render inline downloads instead of opening.
  if (!INLINE.has(ext)) res.setHeader('Content-Disposition', 'attachment')

  res.sendFile(path.join(UPLOADS, name), (err) => {
    if (err && !res.headersSent) res.status(404).end()
  })
}
