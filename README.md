# CMS (Construction Management System)

Multi-tenant SaaS for end-to-end construction project management. Full requirements:
`Bridge_Construction_PRD_2.docx` (on the Desktop, OneDrive).

**Full system documentation - architecture, roles & permissions, feature guide, API
reference, data model, production checklist: [DOCUMENTATION.md](DOCUMENTATION.md).
Hosting guide: [DEPLOY.md](DEPLOY.md).**

## Structure

- `api/` - Node (Express 5) + Prisma on MySQL. Port **4311**. Uploads stored in `api/uploads/`.
- `web/` - React 18 (Vite). Port **5330**, proxies `/api` and `/uploads` to the API.

## Run locally

Requires Node 20+ and local MySQL (`mysql://root@localhost:3306/bridge`, DB auto-created).

```
cd api && npm install && npm run migrate && npm run dev    # API :4311
cd web && npm install && npm run dev                        # Web :5330
```

The API refuses to start without a `JWT_SECRET` of 32+ characters - generate one
with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

Create the platform Super Admin (password comes from the environment; there is
no default):

```
cd api && SUPER_PASSWORD="a-long-random-password" npm run seed
```

Or with Docker (app + MySQL + nightly backups, one command): `cp .env.example .env`,
fill it in, then `docker compose up -d --build` - details in [DEPLOY.md](DEPLOY.md).

## Demo dataset (local development only)

`SEED_DEMO=true npm run seed` loads a sample company - projects, phases, stock,
attendance and a set of demo logins - so the app has something to show while you
work on it.

**Those demo accounts share one well-known password and must never exist on an
instance anyone else can reach.** The seed prints the logins when it runs; before
going live, remove them:

```
cd api && npm run purge:demo            # suspend the demo logins, keep the data
cd api && npm run purge:demo -- --wipe  # delete the demo company entirely
```

## What's implemented (PRD phases 0–4)

- Public site: Get Started (Contractor Foreman-style layout, device composite), Pricing,
  Support, native **Book a Demo** scheduler (live slot availability, .ics invite),
  Login (incl. forgot-password), Sign Up → 14-day trial.
- Multi-tenancy: every row is scoped by `clientId`; verified isolation between clients.
- **Roles**: the account owner is the **Admin** - a strict superset of Senior/Site/Stock
  capabilities (daily reports still arrive via the submit → forward chain). Permissions
  as data: role capabilities + per-client feature toggles, enforced server-side.
  Stock Manager never receives monetary fields.
- **2FA**: per-user TOTP (QR + one-time backup codes) and **account-wide enforcement** -
  when the Admin turns it on, every user is walked through setup at next login.
- **Subscriptions & payments**: Starter (30k RWF, 1 project) / Pro (80k, 5 projects) /
  Enterprise (100k, unlimited projects) - **every plan has the full feature set**;
  they differ only in active-project count. Manual **MTN MoMo**
  checkout (unique reference → Super Admin confirms → account activates,
  `paidUntil` extends). Expired subscriptions get a **2-day grace window** - the
  workspace stays fully usable under a red renewal warning banner (with a Renew
  button); applies to every paid plan regardless of duration. After grace (and
  for ended trials) the workspace goes **view-only**: everyone can still log in,
  see and download everything as usual, but the server refuses every change
  (only billing/auth/account writes pass) until payment - enforced by HTTP
  method in the auth gate, not just hidden buttons. Plan limits enforced
  (projects count, team roles).
- **Project scoping**: each project has its own **team** (assigned members see only
  their projects), its own **stock** (+ shared general store), **workers**, phases and
  attendance. Project filters on stock, workers, badges and cards.
- Projects → phases → daily updates (photo/video upload, geotag, auto-timestamp), Kanban board
  with phase **edit/delete** (deleting returns drawn materials to stock).
- **Phase sign-off flow**: when the Senior Engineer marks a phase done, the Admin's
  dashboard shows a notification banner linking to a per-phase **completion report**
  (`/phases/:id/report`) - duration planned vs actual, budget vs actual with variance,
  cost-breakdown donut, daily activity chart, every worker with days + pay, materials
  used, and the insights checklist. Also reachable from done cards on the Kanban board.
- **Key insights** per phase: equal-share checklist that derives the phase percent
  (all done = 100%), with optional photo/file proof per insight. Photo proof enforced
  before a phase can be signed off.
- Phase costs: **worker wages accrue automatically from attendance** - each clocked-in
  worker earns their daily rate once per day (rate snapshotted on the record at clock-in),
  attributed to the session's phase. The crew estimate (daily-update counts × per-phase
  rates) only applies on days with no attendance wages, so nothing double-counts.
  Materials drawn from stock (deducts quantities, snapshots unit cost).
  Budget-vs-actual + wages/crew/materials breakdown in Reports; attendance report has a
  per-worker Pay column with total wages (hidden from roles without money rights).
- Daily reports close the day: the **crew on site is pulled automatically from
  attendance** (who attended, their worker type and phase) with extra worker-type
  rows addable from the Settings-defined types; the form includes **items used**
  (picked from the project's stock + general store, quantities validated and
  **deducted from stock** on submit, name/unit/cost snapshotted). Reports show the
  day's attended workers with their pay and the items/materials used when they
  reach the Senior Engineer / Admin (amounts hidden from Site/Guest). **Stock
  Managers submit daily reports by default.** The Admin never submits - reports
  reach them via the submit → forward chain; the submit email goes to Senior
  Engineers only and the Admin is emailed when the report is **forwarded** to
  them.
- Stock: consumables + machines (serial required), **CSV template + bulk upload**,
  low-stock alerts, request → approve/reject flow, damaged-item log (hidden from
  Stock Manager). **Issue items** - proof of consumption: items are handed to a
  person identified by **scanning their card's QR with the camera or typing the
  card id** (workers or team members); stock deducts and every hand-out lands in
  the "Issued items" log with proof badges. Audit trail on all key actions.
- **Multi-store stock**: a big project can run **several stores** (admin/Senior
  create them, add products to each); every store has **its own Stock Manager**
  who then sees ONLY their store's stock (inventory, issues, alerts) while
  keeping their edit rights inside it. **Inter-store transfer requests**: a store
  that runs short asks another store that has the item; the source store's
  manager (or Senior/Admin) approves and the stock physically moves. Shortage
  alerts (dashboard, stock page, email) name **which store** is short, and the
  Reports hub breaks usage down **per store** while project totals combine all
  stores.
- Attendance: worker registry (CSV bulk enrolment, admin-defined **worker types**
  from Settings, printable QR badges, issued-cards log), card-tap **kiosk** with
  camera QR scanning, per-phase sessions with pause/activate, time windows,
  reports with CSV export, **present/absent summary** (green/red, per day and per
  range) and a per-worker Pay column. **Team members carry auto-generated badges
  too** and can clock in/out by card like workers (no wages, not counted in crew
  totals). Attendance access is **granted per role by the admin** (Settings ›
  Access Control) - for Stock Managers the grant is FULL access (sessions,
  scanning, enrolment, cards).
- **Photos**: optional profile photo for every user (My Account) and every worker
  (click the avatar in the Workers tab) - shown across the app instead of initials.
- **Access Control** (Settings › Access Control, HR-style): a collapsible
  **Access Levels** overview plus a **Permissions** panel - pick an Access Level
  (Senior/Site/Stock/Guest/All members) and a Module, and the matching switches
  appear as collapsible module cards. Covers per-role attendance grants, Senior
  team management, Stock Manager project view, stock visibility/editing, all
  guest areas (Phases, Schedule, Daily updates, Stock) and media downloads -
  everything enforced server-side in the capability layer.
- **Team lifecycle**: members can be **suspended / activated / deleted** by the
  admin (and by Senior Engineers when granted); suspended users are blocked at
  login and their sessions die immediately; deletion is refused while the member
  has recorded activity (suspend instead, history keeps its author).
- Chat: company channel + **private DMs** with unread dots, **voice notes** (in-browser
  recording), attachments (8 × 50 MB), **video calls** (embedded Jitsi) with member
  invites and ringing banners. Every photo opens in an in-app lightbox with
  permission-gated download.
- Documents with folders, visibility rules and a dashboard design slider; weather widget.
- Team page: card directory with search/filters/CSV export, an **org chart view**
  (levels by role), suspend/activate/delete actions, and password resets by
  **email invitation or direct set**. New team members get a QR badge/card
  automatically at creation.
- **Branding** (Settings › Branding): per-company logo upload, applied to everything
  printed or exported - schedule PDF/Excel letterheads, worker badges and both faces
  of the ID cards (screen, print and PNG download). Falls back to the platform logo.
- **Reports hub**: one filter bar (date presets, project, phase) driving five tabs -
  Overview (KPIs, weekly spend chart, budget-vs-actual bars, alerts), Projects & Phases
  (expectation vs reality in money and days, burn-rate forecast at completion, links to
  phase reports), Labor & Attendance (wages, worker-days, presence chart, per-worker
  table), and Materials & Stock (consumption, stock value, damaged, requests, plus a
  **per-store breakdown** with manager, value, usage and shortages). CSV export per
  table + print. The **Audit trail is Super-Admin-only** (cross-company, in the
  platform area) - company admins no longer see it.
- **Super Admin**: finance dashboard (monthly received / due / pending, renewal
  reminders with a configurable window), MoMo payment queue plus a dedicated
  **Payments tab** (full history with received/pending/all-time tiles, status
  filter, search, CSV export and confirm/reject actions), **demo-booking popup
  notifications** (polled every 30s until acknowledged) and a **Demos tab** - the
  full booking book with lifecycle tracking (Scheduled / Done / No-show / Canceled),
  time spent per demo, held-at stamps, outcome notes, status filter, search and CSV
  export - plus a **Companies** directory
  (statuses, renewal dates) and **support mode** - open any company's workspace as its
  admin (audited, lock-bypassing, platform-endpoints blocked).
- Production-ready serving: the API serves the built web app - one Node process +
  MySQL. See [DEPLOY.md](DEPLOY.md).

## Not yet built (planned)

Automated payment provider API (manual MoMo confirm today), customer-facing renewal
emails/SMS, per-client theme colors (logo branding is live), offline-first PWA sync,
visitor log, websockets for chat.
