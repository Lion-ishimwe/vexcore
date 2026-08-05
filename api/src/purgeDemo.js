// Removes the seeded demo accounts before an instance goes live.
//
// The demo logins (demo1234) are printed in the README and the documentation,
// so anyone who can read the repo can sign in to a deployment that still has
// them. This script exists so that is one command to fix, not a manual hunt.
//
//   npm run purge:demo            neutralise the demo LOGINS, keep the data
//   npm run purge:demo -- --wipe  delete the whole demo company and its data
//
// Default is deliberately the non-destructive one: the demo company is often
// also the workspace someone has been trying the system out in, and the
// security problem is the known passwords, not the rows.
import 'dotenv/config'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db } from './db.js'
import { deleteClientCascade } from './deleteClient.js'

const DEMO_EMAILS = [
  'chantal@demo.rw', 'eric@demo.rw', 'jp@demo.rw',
  'aline@demo.rw', 'divine@demo.rw', 'guest@demo.rw',
]
const DEMO_COMPANY = 'Amahoro Construction Ltd'
const wipe = process.argv.includes('--wipe')

async function neutralise() {
  const users = await db.user.findMany({ where: { email: { in: DEMO_EMAILS } } })
  if (!users.length) return console.log('No demo accounts found - nothing to do.')

  for (const u of users) {
    // A random password nobody holds, plus suspended (authRequired rejects
    // suspended users), plus a revocation stamp that kills any live session.
    await db.user.update({
      where: { id: u.id },
      data: {
        passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 10),
        suspended: true,
        sessionsValidFrom: new Date(Math.floor(Date.now() / 1000) * 1000),
        totpSecret: null,
        totpEnabled: false,
        backupCodes: null,
      },
    })
    await db.resetToken.deleteMany({ where: { userId: u.id } })
    console.log(`  suspended + password randomised: ${u.email}`)
  }
  console.log(`\n${users.length} demo login(s) can no longer sign in. Their history keeps its author.`)
  console.log('Run with --wipe to delete the demo company and all its data instead.')
}

async function wipeCompany() {
  const client = await db.client.findFirst({ where: { company: DEMO_COMPANY } })
  if (!client) return console.log(`No company named "${DEMO_COMPANY}" - nothing to wipe.`)

  const users = await db.user.findMany({ where: { clientId: client.id }, select: { email: true } })
  console.log(`Wiping "${DEMO_COMPANY}" (client ${client.id}) and ${users.length} user(s):`)
  for (const u of users) console.log(`  - ${u.email}`)

  // Same code path the Super Admin's delete uses, so the two cannot drift.
  const result = await deleteClientCascade(client.id, { deletedBy: 'purge:demo' })
  console.log(`\nRemoved: ${JSON.stringify(result.counts)}`)
  console.log(`${result.files} uploaded file(s) deleted from disk.`)
}

async function main() {
  await (wipe ? wipeCompany() : neutralise())
  const supers = await db.user.findMany({ where: { role: 'SUPER' }, select: { email: true } })
  console.log(`\nSuper Admin account(s) kept: ${supers.map(s => s.email).join(', ') || 'none'}`)
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect().catch(() => {}); process.exit(1) })
