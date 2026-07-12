import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { db } from './db.js'

const day = 24 * 3600 * 1000
const ago = (d) => new Date(Date.now() - d * day)
const ahead = (d) => new Date(Date.now() + d * day)

async function main() {
  const hash = await bcrypt.hash('demo1234', 10)

  // Super admin (platform operator)
  await db.user.upsert({
    where: { email: 'super@bridge.app' },
    update: {},
    create: { name: 'Super Admin', email: 'super@bridge.app', passwordHash: await bcrypt.hash('super1234', 10), role: 'SUPER' },
  })

  if (await db.client.findFirst({ where: { company: 'Amahoro Construction Ltd' } })) {
    console.log('Demo client already seeded - skipping.')
    return
  }

  const client = await db.client.create({
    data: {
      company: 'Amahoro Construction Ltd', contact: '+250 788 000 111',
      country: 'Rwanda', location: 'Kigali', tin: '10203040', currency: 'RWF',
      status: 'TRIAL', trialEndsAt: ahead(9),
      settings: { stockVisibleToSite: true, stockVisibleToClient: true, mediaDownload: false, stockMgrEdit: false, twoFA: true, guestAccess: true },
    },
  })
  const cid = client.id

  const mk = (name, email, role) =>
    db.user.create({ data: { clientId: cid, name, email, passwordHash: hash, role } })
  const chantal = await mk('Chantal U.', 'chantal@demo.rw', 'CLIENT')
  const eric = await mk('Eric M.', 'eric@demo.rw', 'SENIOR')
  const jp = await mk('Jean-Paul K.', 'jp@demo.rw', 'SITE')
  const aline = await mk('Aline I.', 'aline@demo.rw', 'SITE')
  const divine = await mk('Divine N.', 'divine@demo.rw', 'STOCK')
  await mk('Guest Viewer', 'guest@demo.rw', 'GUEST')

  const p1 = await db.project.create({
    data: {
      clientId: cid, name: 'Kacyiru Apartment Block A', location: 'Kacyiru, Kigali',
      status: 'In progress', currency: 'RWF', budget: 385_000_000,
      documents: ['Structural drawings v3.pdf', 'BOQ - Block A.xlsx', 'Site permit.pdf'],
    },
  })
  const p2 = await db.project.create({
    data: {
      clientId: cid, name: 'Musanze Primary School', location: 'Musanze District',
      status: 'In progress', currency: 'RWF', budget: 120_000_000,
      documents: ['Classroom layout.pdf', 'BOQ - School.xlsx'],
    },
  })
  await db.project.create({
    data: { clientId: cid, name: 'Rubavu Warehouse', location: 'Rubavu', status: 'Planning', currency: 'RWF', budget: 210_000_000, documents: ['Feasibility notes.docx'] },
  })

  const phase = (projectId, name, status, percent, startD, endD, budget, cpb, cph, assigneeId, orderIdx) =>
    db.phase.create({
      data: {
        projectId, name, status, percent, budget, costPerBuilder: cpb, costPerHelper: cph,
        startDate: ago(startD), endDate: status === 'done' ? ago(endD) : ahead(endD),
        assigneeId, orderIdx,
      },
    })

  const ph1 = await phase(p1.id, 'Foundation', 'done', 100, 125, 78, 82_000_000, 9000, 5000, jp.id, 0)
  const ph2 = await phase(p1.id, 'Structure & Columns', 'active', 72, 76, 25, 145_000_000, 9000, 5000, jp.id, 1)
  const ph3 = await phase(p1.id, 'Roofing', 'active', 15, 10, 48, 64_000_000, 10000, 5500, aline.id, 2)
  await phase(p1.id, 'Electrical & Plumbing', 'todo', 0, -27, 72, 48_000_000, 12000, 6000, aline.id, 3)
  await phase(p1.id, 'Finishing & Handover', 'todo', 0, -67, 123, 46_000_000, 8000, 4500, null, 4)
  const ph6 = await phase(p2.id, 'Finishing', 'active', 78, 40, 20, 30_000_000, 8000, 4500, jp.id, 0)

  const stock = (name, category, qty, unit, unitCost, serial, low) =>
    db.stockItem.create({ data: { clientId: cid, name, category, qty, unit, unitCost, serial, lowThreshold: low } })
  const cement = await stock('Cement (50kg bag)', 'Consumable', 640, 'bags', 11_500, null, 100)
  const sand = await stock('Sand', 'Consumable', 18, 'trucks', 160_000, null, 4)
  const bricks = await stock('Bricks', 'Consumable', 4_200, 'pcs', 180, null, 5_000)
  const rebar = await stock('Rebar 12mm', 'Consumable', 260, 'bars', 9_800, null, 60)
  await stock('Concrete mixer', 'Machine', 2, 'units', 3_400_000, 'CMX-2024-0117', 0)
  await stock('Power drill (Bosch)', 'Machine', 5, 'units', 145_000, 'BD-889-2211', 2)
  await stock('Paint (20L)', 'Consumable', 8, 'buckets', 68_000, null, 12)

  const draw = (phaseId, item, qty) =>
    db.phaseMaterial.create({ data: { phaseId, stockItemId: item.id, nameSnap: item.name, qty, unitCostSnap: item.unitCost } })
  await draw(ph1.id, cement, 2_400); await draw(ph1.id, sand, 42); await draw(ph1.id, rebar, 900)
  await draw(ph2.id, cement, 3_100); await draw(ph2.id, rebar, 1_400); await draw(ph2.id, bricks, 60_000)
  await draw(ph3.id, cement, 300)
  await draw(ph6.id, cement, 800); await draw(ph6.id, bricks, 22_000)

  const upd = (projectId, phaseId, userId, builders, helpers, note, geotag, daysAgo, forwarded) =>
    db.dailyUpdate.create({
      data: { clientId: cid, projectId, phaseId, userId, builders, helpers, note, geotag, forwarded, createdAt: ago(daysAgo) },
    })
  // A few weeks of labor history so phase spend is realistic
  for (let d = 20; d > 0; d--) {
    await upd(p1.id, ph2.id, jp.id, 16 + (d % 4), 22 + (d % 5), null, 'Kacyiru site · -1.9441, 30.0619', d, false)
  }
  await upd(p1.id, ph2.id, jp.id, 18, 26,
    'Second-floor slab poured. Curing starts tomorrow; formwork for columns C12–C18 in place.',
    'Kacyiru site · -1.9441, 30.0619', 0, true)
  await upd(p1.id, ph3.id, aline.id, 6, 9,
    'Trusses delivered and inspected. Two damaged trusses returned to supplier.',
    'Kacyiru site · -1.9440, 30.0621', 0, true)
  await upd(p2.id, ph6.id, jp.id, 9, 12,
    'Classroom block painting 60% done. Window fitting continues Monday.',
    'Musanze site · -1.4996, 29.6342', 1, false)

  await db.stockRequest.create({ data: { clientId: cid, itemName: 'Bricks', qty: '10,000 pcs', requestedById: divine.id, status: 'PENDING', createdAt: ago(1) } })
  await db.stockRequest.create({ data: { clientId: cid, itemName: 'Cement (50kg bag)', qty: '200 bags', requestedById: divine.id, status: 'APPROVED', createdAt: ago(3) } })
  await db.stockRequest.create({ data: { clientId: cid, itemName: 'Scaffolding planks', qty: '60 pcs', requestedById: jp.id, status: 'REJECTED', note: 'Use stock on site B', createdAt: ago(7) } })

  await db.damagedItem.create({ data: { clientId: cid, name: 'Power drill (Bosch)', serial: 'BD-889-2204', note: 'Motor burnt - under review', createdAt: ago(5) } })
  await db.damagedItem.create({ data: { clientId: cid, name: 'Wheelbarrow', note: 'Frame cracked', createdAt: ago(14) } })

  const msg = (userId, text, daysAgo) =>
    db.message.create({ data: { clientId: cid, userId, text, createdAt: ago(daysAgo) } })
  await msg(chantal.id, 'Eric, can you forward this week’s progress on Block A? The bank asked for photos of the slab work.', 0.2)
  await msg(eric.id, 'Yes - forwarding Jean-Paul’s update from today with 4 photos and the pour video. Slab is on schedule.', 0.19)
  await msg(jp.id, 'Added two more close-ups of the column formwork.', 0.18)
  await msg(eric.id, 'Also flagging: bricks are running low (4,200 left). Divine raised a request for 10,000 - approving tomorrow unless you object.', 0.17)
  await msg(chantal.id, 'Approved from my side. Keep the phase under budget please \u{1F44D}', 0.16)

  await db.auditLog.createMany({
    data: [
      { clientId: cid, userName: 'Eric M.', action: 'stock.inserted', detail: '640 bags Cement (50kg bag)', createdAt: ago(1) },
      { clientId: cid, userName: 'Eric M.', action: 'stock.request.approved', detail: '200 bags × Cement (50kg bag)', createdAt: ago(3) },
      { clientId: cid, userName: 'Jean-Paul K.', action: 'update.submitted', detail: 'Kacyiru Block A: 18 builders, 26 helpers', createdAt: ago(0.1) },
      { clientId: cid, userName: 'Eric M.', action: 'phase.signedoff', detail: 'Foundation', createdAt: ago(78) },
    ],
  })

  console.log('Seeded demo client + users. Logins (password demo1234):')
  console.log('  chantal@demo.rw (Client) · eric@demo.rw (Senior) · jp@demo.rw (Site) · divine@demo.rw (Stock) · guest@demo.rw (Guest)')
  console.log('Super admin: super@bridge.app / super1234')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
