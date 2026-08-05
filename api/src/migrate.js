// Startup schema step for a LIVE database.
//
// This replaces `prisma db push`. push compares the schema to the database and
// reshapes it on the spot: it keeps no history, offers no rollback, and on a
// destructive change either refuses (leaving the deploy down) or, with
// --accept-data-loss, drops columns full of real data. Migrations are recorded,
// reviewable in the repo, and replayed in the same order everywhere.
//
// Three cases are handled automatically:
//   1. Empty database        → every migration runs, creating the schema.
//   2. Existing database with no migration history (an installation that used
//      `db push` before this change) → baselined: 0_init is marked as already
//      applied rather than re-run, so nothing is recreated or dropped.
//   3. Already migrated      → only genuinely pending migrations run.
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const BASELINE = '0_init'
const log = (msg) => console.log(`[cms:migrate] ${msg}`)

const prisma = new PrismaClient()

// Prisma returns BigInt for COUNT() on MySQL.
const count = (rows) => Number(rows[0]?.c ?? 0)

async function waitForDatabase(attempts = 30, delayMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`
      return
    } catch (e) {
      if (i === attempts) throw new Error(`database unreachable after ${attempts} attempts: ${e.message}`)
      log(`database not ready (attempt ${i}/${attempts}) - retrying in ${delayMs / 1000}s`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

// Prefer the installed CLI over `npx`: in the container this runs as an
// unprivileged user, and npx wants a writable cache and may reach for the
// registry. The local entrypoint is just a Node script, so run it directly.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_CLI = path.join(HERE, '..', 'node_modules', 'prisma', 'build', 'index.js')

function runPrisma(args) {
  const res = existsSync(LOCAL_CLI)
    ? spawnSync(process.execPath, [LOCAL_CLI, ...args], { stdio: 'inherit' })
    : spawnSync('npx', ['prisma', ...args], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (res.status !== 0) throw new Error(`prisma ${args.join(' ')} failed (exit ${res.status})`)
}

async function main() {
  await waitForDatabase()

  const historyRows = await prisma.$queryRaw`
    SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = '_prisma_migrations'`
  const tableRows = await prisma.$queryRaw`
    SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name <> '_prisma_migrations'`

  const hasHistory = count(historyRows) > 0
  const hasTables = count(tableRows) > 0

  if (!hasHistory && hasTables) {
    // An existing installation that predates migrations. Its tables already
    // match 0_init, so record it as applied instead of trying to create them.
    log(`existing schema found with no migration history - baselining as ${BASELINE}`)
    runPrisma(['migrate', 'resolve', '--applied', BASELINE])
  }

  log('applying pending migrations...')
  runPrisma(['migrate', 'deploy'])
  log('schema up to date')
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(`[cms:migrate] FAILED: ${e.message}`)
    console.error('[cms:migrate] The app was NOT started. Nothing has been changed that a')
    console.error('[cms:migrate] retry would fix on its own - read the error above, and')
    console.error('[cms:migrate] restore from backup first if a migration half-applied.')
    await prisma.$disconnect().catch(() => {})
    process.exit(1)
  })
