import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { db, audit } from '../db.js'
import { requireCap } from '../auth.js'

const r = Router()

const UPLOADS = path.resolve('uploads')
fs.mkdirSync(UPLOADS, { recursive: true })
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) =>
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname || '.bin')),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
})

// Fixed folders every client account gets. The client controls whether the
// rest of the team can access them (restricted = client-only).
export const SYSTEM_FOLDERS = ['Design', 'Project Documents']

export async function ensureSystemFolders(clientId) {
  for (const name of SYSTEM_FOLDERS) {
    const existing = await db.folder.findFirst({ where: { clientId, name, system: true } })
    if (!existing) await db.folder.create({ data: { clientId, name, system: true } })
  }
}

function docKind(mimetype = '') {
  if (mimetype.startsWith('image')) return 'image'
  if (mimetype.startsWith('video')) return 'video'
  if (mimetype === 'application/pdf') return 'pdf'
  return 'file'
}

// Visibility: 'public' = whole company. 'private' = uploader + the Client
// (account owner) - so everything anyone uploads is always visible to the client.
function visibleWhere(req) {
  if (req.user.role === 'CLIENT') return {}
  return { OR: [{ visibility: 'public' }, { uploaderId: req.user.id }] }
}

const folderLocked = (req, folder) => folder.restricted && req.user.role !== 'CLIENT'

function shapeDoc(req) {
  return (d) => ({
    id: d.id, name: d.name, kind: d.kind, url: '/uploads/' + d.path,
    visibility: d.visibility, folderId: d.folderId,
    by: d.uploader.name, mine: d.uploaderId === req.user.id,
    canManage: d.uploaderId === req.user.id || req.user.role === 'CLIENT',
    createdAt: d.createdAt,
  })
}

// List folders + documents of one folder ('root' or an id)
r.get('/', requireCap('docs.view'), async (req, res) => {
  await ensureSystemFolders(req.client.id)
  const folders = await db.folder.findMany({
    where: { clientId: req.client.id },
    orderBy: [{ system: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { documents: true } } },
  })
  const folderId = req.query.folder && req.query.folder !== 'root' ? +req.query.folder : null
  let locked = false
  if (folderId) {
    const folder = folders.find((f) => f.id === folderId)
    if (!folder) return res.status(404).json({ error: 'Folder not found' })
    locked = folderLocked(req, folder)
  }
  const documents = locked ? [] : await db.document.findMany({
    where: { clientId: req.client.id, folderId, ...visibleWhere(req) },
    include: { uploader: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json({
    folders: folders.map((f) => ({
      id: f.id, name: f.name, system: f.system, restricted: f.restricted,
      count: f._count.documents, locked: folderLocked(req, f),
    })),
    documents: documents.map(shapeDoc(req)),
    locked,
  })
})

// Upload documents (visibility chosen by the uploader)
r.post('/', requireCap('docs.upload'), upload.array('files', 10), async (req, res) => {
  if (!(req.files ?? []).length) return res.status(400).json({ error: 'No files received' })
  let folderId = null
  if (req.body.folderId && req.body.folderId !== 'root') {
    const folder = await db.folder.findFirst({ where: { id: +req.body.folderId, clientId: req.client.id } })
    if (!folder) return res.status(404).json({ error: 'Folder not found' })
    if (folderLocked(req, folder)) return res.status(403).json({ error: 'This folder is restricted to the client' })
    folderId = folder.id
  }
  const visibility = req.body.visibility === 'private' ? 'private' : 'public'
  await db.document.createMany({
    data: req.files.map((f) => ({
      clientId: req.client.id, folderId, uploaderId: req.user.id,
      name: f.originalname || f.filename, path: f.filename,
      kind: docKind(f.mimetype), visibility,
    })),
  })
  await audit(req.client.id, req.user.name, 'docs.uploaded',
    `${req.files.length} file(s) (${visibility})${folderId ? ' → folder ' + folderId : ''}`)
  res.json({ ok: true })
})

// Rename / change visibility / move a document (uploader or client)
r.patch('/:id', requireCap('docs.upload'), async (req, res) => {
  const doc = await db.document.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!doc) return res.status(404).json({ error: 'Document not found' })
  if (doc.uploaderId !== req.user.id && req.user.role !== 'CLIENT')
    return res.status(403).json({ error: 'Only the uploader or the client can manage this document' })
  const data = {}
  if (req.body.name !== undefined && String(req.body.name).trim()) data.name = String(req.body.name).trim()
  if (req.body.visibility) data.visibility = req.body.visibility === 'private' ? 'private' : 'public'
  if (req.body.folderId !== undefined) {
    if (!req.body.folderId || req.body.folderId === 'root') data.folderId = null
    else {
      const folder = await db.folder.findFirst({ where: { id: +req.body.folderId, clientId: req.client.id } })
      if (!folder) return res.status(404).json({ error: 'Folder not found' })
      if (folderLocked(req, folder)) return res.status(403).json({ error: 'This folder is restricted to the client' })
      data.folderId = folder.id
    }
  }
  const updated = await db.document.update({ where: { id: doc.id }, data })
  await audit(req.client.id, req.user.name, 'docs.edited', updated.name)
  res.json({ ok: true })
})

r.delete('/:id', requireCap('docs.upload'), async (req, res) => {
  const doc = await db.document.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!doc) return res.status(404).json({ error: 'Document not found' })
  if (doc.uploaderId !== req.user.id && req.user.role !== 'CLIENT')
    return res.status(403).json({ error: 'Only the uploader or the client can delete this document' })
  await db.document.delete({ where: { id: doc.id } })
  await audit(req.client.id, req.user.name, 'docs.deleted', doc.name)
  res.json({ ok: true })
})

// ---- Folders ----

r.post('/folders', requireCap('docs.upload'), async (req, res) => {
  const name = (req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Folder name is required' })
  if (await db.folder.findFirst({ where: { clientId: req.client.id, name } }))
    return res.status(409).json({ error: 'A folder with this name already exists' })
  const folder = await db.folder.create({ data: { clientId: req.client.id, name } })
  await audit(req.client.id, req.user.name, 'docs.folder.created', name)
  res.json(folder)
})

r.patch('/folders/:id', requireCap('docs.upload'), async (req, res) => {
  const folder = await db.folder.findFirst({ where: { id: +req.params.id, clientId: req.client.id } })
  if (!folder) return res.status(404).json({ error: 'Folder not found' })
  const data = {}
  if (req.body.restricted !== undefined) {
    // Only the client decides who accesses the system folders (Design, Project Documents).
    if (req.user.role !== 'CLIENT') return res.status(403).json({ error: 'Only the client can change folder access' })
    if (!folder.system) return res.status(400).json({ error: 'Access control applies to Design and Project Documents' })
    data.restricted = !!req.body.restricted
    await audit(req.client.id, req.user.name,
      data.restricted ? 'docs.folder.restricted' : 'docs.folder.opened', folder.name)
  }
  if (req.body.name !== undefined) {
    if (folder.system) return res.status(400).json({ error: 'System folders cannot be renamed' })
    const name = String(req.body.name).trim()
    if (!name) return res.status(400).json({ error: 'Folder name is required' })
    data.name = name
    await audit(req.client.id, req.user.name, 'docs.folder.renamed', `${folder.name} → ${name}`)
  }
  const updated = await db.folder.update({ where: { id: folder.id }, data })
  res.json(updated)
})

r.delete('/folders/:id', requireCap('docs.upload'), async (req, res) => {
  const folder = await db.folder.findFirst({
    where: { id: +req.params.id, clientId: req.client.id },
    include: { _count: { select: { documents: true } } },
  })
  if (!folder) return res.status(404).json({ error: 'Folder not found' })
  if (folder.system) return res.status(400).json({ error: 'System folders cannot be deleted' })
  if (folder._count.documents > 0) return res.status(400).json({ error: 'Folder is not empty - move or delete its documents first' })
  await db.folder.delete({ where: { id: folder.id } })
  await audit(req.client.id, req.user.name, 'docs.folder.deleted', folder.name)
  res.json({ ok: true })
})

export default r
