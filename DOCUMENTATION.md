# CMS (Construction Management System) - System Documentation

Multi-tenant SaaS for end-to-end construction project management.
Built July 2026. Requirements source: `Bridge_Construction_PRD_2.docx` (OneDrive Desktop).

---

## 1. Architecture at a glance

```
┌────────────────────┐         ┌─────────────────────┐         ┌──────────┐
│  web/  (React 18)  │  /api → │  api/  (Express 5)  │ Prisma →│  MySQL   │
│  Vite, port 5330   │/uploads→│  port 4311          │         │ `bridge` │
└────────────────────┘         └─────────────────────┘         └──────────┘
                                     │
                                     └── uploads/  (photos, videos, voice notes, files)
```

- **Multi-tenancy**: one database, shared schema. Every tenant-owned row carries `clientId`.
  Every query in every route filters by the authenticated user's `clientId` - verified:
  a second company sees zero data from the first.
- **Project scoping inside a tenant** (`api/src/scope.js`): staff assigned to projects
  (via `ProjectMember`) see only those projects' phases, updates, stock, workers and
  attendance. Staff on no project see everything (default); admins and guests always
  see the whole account. Stock/workers with no project = shared "general store".
- **Auth**: JWT (7-day expiry), `Authorization: Bearer <token>`. Passwords bcrypt-hashed.
  Optional TOTP 2FA per user; account-wide 2FA enforcement per tenant. Special tokens:
  15-min 2FA-setup tokens and 8-hour Super Admin support-mode tokens (`actAs`).
- **Subscriptions**: 14-day trial → paid plan via manual MoMo payment confirmed by the
  Super Admin. Expired trial/subscription hard-locks the API (except billing/auth/account)
  and the UI shows a pay-to-unlock screen.
- **Permissions as data**: role capabilities + per-client feature toggles, resolved
  server-side in `api/src/auth.js` (`capsFor`). The frontend receives the resolved
  capability list at login and uses it only for showing/hiding UI - the API is the
  actual gate.
- **Production**: single process - the API serves the built web app (`web/dist`) itself.
  See [DEPLOY.md](DEPLOY.md) for the full hosting guide (VPS or Railway/Render).
- **Video calls**: embedded Jitsi Meet (no in-house WebRTC), per PRD §8.7.

### Tech stack

| Layer | Technology |
|---|---|
| API | Node 20, Express 5, Prisma 5, multer (uploads), jsonwebtoken, bcryptjs |
| Database | MySQL 8 (local service `MySQL84`, db `bridge`, `root`/no password in dev) |
| Web | React 18, Vite 5, react-router-dom 6 (hash routing), lucide-react icons |
| Fonts | Poppins (body/headings), Caveat (handwritten accents) via Google Fonts |
| Calls | Jitsi Meet embedded iframe - `JITSI_BASE` in `web/src/pages/Chat.jsx` |

---

## 2. Getting started

Requires Node 20+ and a local MySQL reachable at `mysql://root@localhost:3306/bridge`
(configure in `api/.env` → `DATABASE_URL`).

```bash
# API - port 4311
cd api
npm install
npx prisma db push        # creates/updates all tables
npm run seed              # demo company, users, projects, stock, messages
npm run dev               # node --watch src/server.js

# Web - port 5330 (proxies /api and /uploads to :4311)
cd web
npm install
npm run dev
```

Open http://localhost:5330.

### Demo accounts (password `demo1234` unless noted)

| Email | Role | Sees |
|---|---|---|
| chantal@demo.rw | Admin (account owner) | Everything the roles below can do, plus settings, billing, team; daily updates still arrive forwarded |
| eric@demo.rw | Senior Engineer | Everything operational: phases, stock (with amounts), approvals, team |
| jp@demo.rw / aline@demo.rw | Site Engineers | Assigned work, daily updates, stock quantities (if enabled), chat |
| divine@demo.rw | Stock Manager | Stock **quantities only** - no money, no damaged items; can request |
| guest@demo.rw | Guest | View-only: dashboard, projects, updates |
| super@bridge.app (`super1234`) | Super Admin | Platform panel: all client accounts + demo bookings |

---

## 3. Roles & permissions

### Capability model

`api/src/auth.js` defines `ROLE_CAPS` (what each role can do) plus **settings-conditional
grants** - toggles the Admin controls in *Settings → Permissions* that add or remove
capabilities at runtime.

**The Admin rule**: the CLIENT role is displayed as **"Admin"** everywhere and its
capabilities are computed as the **union of Senior Engineer + Site Engineer + Stock
Manager** - anything those roles can do, the admin can do. One deliberate exception:
daily reports still reach the admin through the usual *submit → forward* chain
(the admin's updates feed is forwarded-only, like guests).

Settings › **Access Control** is organised HR-style: a collapsible *Access Levels*
overview plus a *Permissions* panel - pick an **Access Level** and a **Module** and
the matching switches appear as collapsible module cards.

| Access Level → Module toggle | Effect |
|---|---|
| Senior Engineer → Attendance (`attSenior`) | run sessions & record workers (on by default) |
| Senior Engineer → Team (`seniorTeamManage`) | suspend / activate / delete Site & Stock accounts |
| Site Engineer → Attendance (`attSite`) | record attendance (on by default) |
| Site Engineer → Stock (`stockVisibleToSite`) | grants `stock.view` (quantities only) |
| Stock Manager → Attendance (`attStock`) | FULL attendance: sessions, scanning, enrolment, cards (on by default) |
| Stock Manager → Projects (`projStock`) | view-only `projects.view` + `phases.view` for assigned projects |
| Stock Manager → Stock (`stockMgrEdit`) | grants `stock.edit` (default: submit requests for approval) |
| Guest → Phases / Schedule / Daily updates / Stock (`guestPhases` …) | each guest area enabled individually |
| All members → Media (`mediaDownload`) | grants `media.download` (in-app viewing is always on) |
| Security tab → Two-factor authentication (2FA) | **enforced**: all users must set up TOTP - see §4.2 |

The same tab also holds **Email notifications** (`emailPhaseDone`,
`emailDailyReport`, `emailLowStock` - each switchable) and the **Worker types**
list used by attendance enrolment and the daily-update crew picker.

### Who can create whom (PRD §3)

- **Admin** creates any team role: Senior Engineers, Site Engineers, Stock Managers, Guests.
- **Senior Engineer** creates Site Engineers and the Stock Manager.
- **Super Admin** manages company accounts (activate / suspend / terminate, confirm
  payments) and can open any company's workspace in **support mode** (§4.15).
- **Member lifecycle**: the Admin (and Senior Engineers when granted) can suspend,
  activate or delete members. Suspended users are refused at login and their
  sessions die on the next request. Deletion is refused while the member has
  recorded activity - suspend instead so history keeps its author.
- Every plan includes every team role - plans differ only in project count (§4.14).

### Hard server-side rules (not just hidden UI)

- Stock Manager responses have `unitCost`/`total` **stripped by the API**; damaged-item
  endpoints return 403.
- Admins and Guests only receive daily updates that the Senior Engineer **forwarded**.
- Staff assigned to projects are scoped to them across every endpoint (`api/src/scope.js`).
- DMs are returned only to their two participants.
- Suspended/terminated accounts cannot log in or call any endpoint; expired
  trials/subscriptions are blocked everywhere except billing, auth and account.
- When the tenant enforces 2FA, sessions of users without 2FA are invalidated and
  personal 2FA cannot be disabled.

---

## 4. Feature guide

### 4.1 Public site
- **Get Started** (`/`): hero with pricing up front, live CSS dashboard mockup,
  stats band, *"From the drawing board to the site"* device composite
  (blueprint tablet + desktop + phone), feature grid, roles section, dark
  differentiators band, footer.
- **Pricing** (`/pricing`): three tiers, 14-day trial messaging.
- **Support** (`/support`): contact card.
- **Book a Demo** (`/demo`): native 3-step scheduler - pick a day (14-day grid,
  Sundays off, Kigali time), pick a slot (09/10/11/14/15/16 CAT; already-booked and
  past slots disabled live from the DB), enter details + interest chips. Double
  booking is prevented by a unique constraint on the slot. Confirmation offers an
  **.ics calendar download**. Bookings appear in the Super Admin panel.

### 4.2 Authentication & 2FA
- **Sign up** creates the company (Client row) + owner user (the **Admin**), starts a
  **14-day trial** (`status: TRIAL`, `trialEndsAt`). Captures email*, password*,
  contact*, country*, location*, TIN, currency.
- **Login** returns `{ token, user, client, subscription, caps }`. If the user has 2FA,
  the login screen switches to a dedicated **verification step** (TOTP code or a
  one-time backup code).
- **Personal 2FA** (My Account): scan a QR code with any authenticator app, verify a
  6-digit code, receive **8 one-time backup codes** (copy/download, shown once,
  SHA-256-hashed at rest). Disable requires the account password.
- **Account-wide 2FA enforcement** (Settings toggle): once the admin turns it on,
  *every* user in the company must have 2FA. The admin is logged out to set up their
  own; existing sessions of users without 2FA are invalidated; at next login each user
  is walked through QR + backup-code setup (via a 15-minute setup token) before
  receiving a session. Personal disable is blocked while enforced.
- **Forgot password**: token flow. No mailer is configured in dev, so the reset token
  is returned in the response (`devToken`) - in production wire a mailer and remove that.
- **Admin-issued reset links** (Team page → ⋯ → Reset password): generates a 1-hour
  link (`#/login?reset=TOKEN`) the admin shares with the member; opening it prefills
  the "set a new password" screen. Owners can reset anyone; Seniors only the roles
  they manage. Audited.
- Account activation happens automatically when the Super Admin **confirms a
  subscription payment** (§4.14–4.15); manual Activate/Suspend/Terminate still exists.

### 4.3 Projects & project teams
- Admin creates projects (name, location, budget); currency copied from the account.
  Plan limits apply (Starter: 1 active project, Pro: 5 - §4.14).
- A project holds documents (names list), phases, daily updates, **its own team,
  stock and workers**.
- **Assign team** (project card): pick which Senior/Site engineers, Stock Manager and
  Guests work on this project. Assigned staff see **only their projects'** data across
  the whole app (projects, phases, updates, stock, workers, attendance, dashboard).
  Staff assigned to no project see everything - scoping is opt-in per person.
- `percent` = average of phase percents; `spent` = sum of phase spend.
- Status auto-moves Planning → In progress when the first phase is added.

### 4.4 Phases & key insights
- Kanban board (To do / In progress / Done) per project; phases carry timeline,
  budget, assignee, and labor rates (**cost per builder/day**, **cost per helper/day**).
- **Edit** (pencil): name, dates, budget, rates, assignee. **Delete** (trash):
  confirmation → drawn materials are **returned to stock**, daily updates keep their
  history (detached), insights removed; all audited.
- **Key insights** - the checklist that drives completion:
  - Each insight is an equal share of 100% (4 insights → 25% each). Phase percent is
    **derived** - the manual percent box disappears once insights exist.
  - Senior Engineer adds/removes insights; Senior + Site Engineers tick them
    (records who and when) and attach **photo/video/PDF proof** per insight.
  - A phase **cannot be signed off** until every insight is done.
- **Photo proof to close** (PRD §4.6): marking a phase done requires at least one
  photo - from a daily update on the phase or from an insight proof.
- **Materials**: drawn from stock into a phase (`POST /phases/:id/materials`);
  quantity is deducted and unit cost snapshotted. Items not in stock must be added
  to stock first.

### 4.5 Cost model (PRD §4.10)
```
phase labor      = Σ over daily updates ( builders × costPerBuilder + helpers × costPerHelper )
phase materials  = Σ over drawn materials ( qty × unit cost at time of draw )
phase spent      = labor + materials       → rolls up to project and account
```
Reports show budget vs actual per phase with variance and an "over budget pace"
flag when spend outruns progress by more than 5 points.

### 4.6 Daily updates (PRD §4.8)
- Site/Senior Engineers **and Stock Managers** submit: project, phase, **crew on
  site** (pulled automatically from today's attendance - who attended, their
  worker type and phase - with extra worker-type rows addable from the
  Settings-defined types), note, **items used** (validated against and deducted
  from stock), photos/videos (up to 12 files, 50 MB each). Auto-timestamped;
  geotagged when permitted. Crew is stored per type (`crew` JSON) with legacy
  builders/helpers rollups for the cost model.
- Senior Engineer **forwards** an update to the client; Clients/Guests see only
  forwarded updates. Emails: submission notifies **Senior Engineers only**; the
  Admin is emailed when the report is **forwarded** to them.
- Media plays in-app; photo downloads honor the *Media downloads* toggle.

### 4.7 Stock & inventory (PRD §4.7)
- Two categories: **Consumables** and **Machines** (serial number required).
- **Per-project stock**: every item (and request/damaged record) can belong to a
  project or to the shared **General store**. The inventory has a project filter and
  column; insert/request forms have a project selector. Staff scoped to projects only
  see their projects' stock + the general store.
- **Bulk upload**: download the CSV template (`name, category, qty, unit, unitCost,
  serial, lowThreshold`), fill one row per product, upload (up to 500 rows, into a
  chosen project or the general store). Bad rows are skipped and reported with line
  numbers and reasons; nothing fails silently.
- **Stores - one project can run several** (`StockStore`): the Admin/Senior
  Engineers create stores per project (Stores button on the Stock page), add
  products to each, and assign every store **its own Stock Manager**. A
  store-assigned manager's whole stock view narrows to exactly their store(s) -
  inventory, issues log, alerts - while their edit rights (via the toggle) keep
  working inside it. Deleting a store moves its items back to the project's
  unassigned stock.
- **Inter-store transfers** (`StockTransfer`): a store that runs short requests an
  item from another store that has it (minimal picker - name/qty/store, no costs).
  The **source store's manager** or anyone with `stock.approve` decides; approval
  moves the stock (full-quantity moves relocate the item, partial moves split it).
- **Issue items** - proof of consumption: recipient identified by **camera QR scan
  or typed card id** (workers or team members - one card namespace); quantities
  deduct and land in the Issued-items log with proof badges.
- Low-stock alerts via per-item threshold - dashboard, stock page and email all
  name **which store** is short; a transfer that drains the source below its
  threshold triggers the alert too.
- **Requests**: Stock Manager (or engineers) request items; Senior Engineer
  approves/rejects. Statuses: PENDING / APPROVED / REJECTED.
- **Damaged items** log - hidden from the Stock Manager entirely.
- Total stock value and all monetary columns hidden from the Stock Manager
  (stripped server-side).
- The Reports hub (Materials & Stock) breaks holdings and usage down **per store**
  (manager, value, issued / reported / drawn, shortages) while project totals
  combine all stores.

### 4.8 Chat (PRD §4.9)
- **Conversations**: `Everyone` (company channel) + **direct messages** with any
  member. DMs are private to the two participants, enforced by the API. Unread
  dots per conversation (localStorage timestamps; per-browser).
- **Voice notes**: recorded in-browser (MediaRecorder), attach + send, inline playback.
- **Attachments**: up to 8 files / 50 MB each per message; images render inline,
  videos/audio get players, other files download chips.
- **Video calls**: embedded Jitsi room per call. "Start video call" opens an invite
  picker (any company member; in a DM the partner is pre-selected). Invitees get a
  ringing banner (auto-expires after 5 min) and a "You're invited" badge; anyone in
  the conversation can join. `JITSI_BASE` currently `https://fairmeeting.net`
  (public instance that permits iframe embedding, no login). **Self-host Jitsi or
  use 8x8 JaaS for production.**
- Polling every 4 s (no websockets yet).

### 4.9 Documents
- **Documents tab** with folders. Anyone except Guests can upload, create folders,
  and rename; Guests are view-only.
- **Visibility per document**: *Public* (whole company) or *Private* = **uploader +
  the Client** - so everything any user uploads is always visible to the client,
  and the client's own private documents are theirs alone. Enforced server-side.
- **System folders** `Design` and `Project Documents` exist in every account,
  cannot be renamed or deleted, and the **client controls access**: *Restrict to me*
  (client-only, shown locked to everyone else) or *Open to team*.
- Uploader or client can rename, toggle visibility, move, or delete a document;
  folders must be empty to delete. All actions audited.
- **Dashboard design slider**: images in the `Design` folder appear on the dashboard
  as an auto-sliding carousel (4 s interval, dots, click to open in the lightbox),
  respecting the folder restriction and per-document visibility.

### 4.10 Attendance
- **Workers registry**: workers enrolled once (name, **type from the
  Settings-defined worker types**, phone, optional daily rate, **project
  assignment**, auto-generated **card/badge id**), plus CSV **bulk enrolment**.
  Printable **badge sheet** with QR codes per worker - and a **Team member
  badges** group: every team member gets a card automatically at creation and can
  clock in/out by card like a worker (no wages, excluded from crew/present-absent
  totals).
- **Project filter across Workers / Badges / Cards tabs**: one shared dropdown
  (All projects / Shared / per project) filters the worker list, the printable badge
  sheet (print one project's badges at a time) and the issued-cards log, which also
  has a Project column. Workers with no project are shared across the account.
- **Sessions**: started per project - with an optional *"record per phase?"* choice
  that ties attendance to one phase. One active session per project per day.
  Modes: **clock-in** (default) → **clock-out** (any recorder flips) → **closed**.
- **Recording**: *auto* via **camera QR scan or typed card id** on the fullscreen
  **kiosk** page (`/kiosk/:sessionId` - no USB reader needed; cards serve both
  attendance and stock issues), or *manual* tick by engineers/stock manager.
  Every record shows its method (auto/manual) and who recorded it.
- **Live / paused sessions**: several sessions may be open per day, but exactly
  ONE is *live* (receiving taps) per project. Opening or activating another
  phase **pauses** the current one - it stays open with its records, and can be
  activated again later (e.g. run phase 2's clock-in, switch back to phase 1
  for its clock-out). Taps on a paused session are refused; the kiosk shows
  "phase paused".
- **Close & day cycle**: a session only closes once everyone is clocked out -
  closing is blocked while workers are still in (use the explicit **Clock out
  everyone** action, labelled with the recorder). Stale sessions from previous
  days auto-close at the first call after midnight (most recent scope re-opens
  live, others paused). With **time windows** enabled, sessions run a full day
  cycle by themselves: auto-open when the clock-in window starts (same scope as
  yesterday) and auto-close after the clock-out window ends, sweeping any
  remaining clock-outs as `system`.
- **Access is granted per role by the Admin** (Settings › Access Control):
  `attSenior` / `attSite` / `attStock` toggles (all on by default). For Stock
  Managers the grant is FULL access - open/close sessions, record and scan,
  enrol workers and generate cards. Session closing follows the
  `attendance.session` capability.
- **Integrations**: today's attendance feeds the Daily Update form automatically
  (attended workers with type + phase become the crew rows); date-range
  **report** per worker × day with hours, method, pay, **present/absent summary**
  (green/red), CSV export and print.

### 4.11 Photo viewer
Every photo in the system (update media, insight proofs, chat images) opens in an
in-app **lightbox** with a Download button. Chat images are always downloadable;
progress/proof photos honor the *Media downloads* toggle.

### 4.12 Reports & audit (PRD §4.11, §8.3)
- Budget vs actual table per project/phase (labor + materials split, variance,
  status), print/PDF via the browser print dialog.
- **Audit trail**: append-only log of key actions - stock inserted/edited, requests
  decided, updates submitted/forwarded, phases created/edited/deleted/signed off,
  insights added/done/proofed, settings changed, accounts created/suspended.
  **Super-Admin-only**: it lives in the platform area (`/admin/audit`,
  cross-company with a company filter) - company admins do not see it.

### 4.13 Team page
Card directory of the company's members (searchable, role + 2FA filters, card /
list / **org chart** view toggle, CSV export, member count). Each card shows role
pill, avatar/photo, email, joined date and a 2FA or **Suspended** badge. The ⋯
menu offers **View more** (details incl. badge/card id), **Reset password**
(email invitation or direct set - §4.2), and **Suspend / Activate / Delete**
(admin, or Senior Engineers when granted; delete refused while the member has
activity). "+ Add Team Member" respects role rules and auto-generates the
member's QR badge/card.

### 4.14 Settings, billing & subscriptions
- **Settings** (admin-only): permission toggles (see §3), account currency, company
  location (drives the weather widget), TIN, attendance time windows, and the
  account-wide 2FA toggle. Branding is a Phase-4 placeholder.
- **Plans** (`api/src/plans.js`, server-side source of truth). **Every plan has
  the full feature set and full team roles - plans differ only in active-project
  count** (feature gating may return later):
  | Plan | Price (RWF/mo) | Active projects |
  |---|---|---|
  | Starter | 30,000 | 1 |
  | Pro (Most popular) | 80,000 | 5 |
  | Enterprise | 100,000 | unlimited |

  Trials get the full product; the project limit bites once a paid plan is
  active and returns a clear "upgrade in Billing" error.
- **Billing page** (admin nav): current status (trial ends / paid until), plan cards
  with a 1/3/6/12-month duration picker, payment history. **Manual MoMo checkout**:
  choosing a plan creates a payment intent with a unique reference (`BR-XXXXXX`);
  the admin sends the money to the platform's MoMo number (env `MOMO_NUMBER`/
  `MOMO_NAME`), enters the payer phone and submits "I've sent the money". The
  Super Admin matches it on the MoMo statement and confirms - the account activates
  instantly (`paidUntil` extends by 30 days × months, stacking on remaining coverage).
- **Expiry lock**: when the trial or `paidUntil` lapses, the API blocks everything
  except billing/auth/account and the web app shows a lock screen - the admin gets
  the Billing page embedded to pay; other roles see "ask your admin". Confirming a
  payment lifts the lock immediately.

### 4.15 Super Admin
`super@bridge.app` gets a platform workspace with two nav items:

- **Dashboard**: monthly finance cards - **Received this month** (confirmed
  payments), **Due this month** (companies whose trial/coverage ends in the month),
  **Pending to confirm**; an amber **Renewal reminders** card listing companies whose
  coverage ends within the configurable window (days-left / overdue badges + one-click
  "Open" into support mode); the falling-due list; the **MoMo payment queue**
  (Confirm / Reject); demo bookings; and **Platform settings** (renewal reminder
  window, default 5 days, stored in the `PlatformSettings` singleton).
- **Companies**: Team-style card directory of every company on the platform -
  search, status filter (Trial/Active/Suspended/Terminated), grid/list toggle, CSV
  export. Cards show status, user/project counts, coverage and a **Renewal**
  date with "in Xd"/"overdue" badges. The ⋯ menu has Activate / Suspend / Terminate.
- **Support mode (impersonation)**: clicking a company opens its workspace **as its
  admin** - full access to every feature and setting (e.g. toggling features for
  them while giving support). Locks are bypassed on purpose (suspended / expired /
  2FA-enforced accounts stay reachable for support). An amber "Support mode" bar
  with **Exit support** stays pinned; the visit is recorded in the company's audit
  trail; the 8-hour support token cannot call any `/admin/*` platform endpoint.

---

## 5. API reference

Base URL `/api`. All routes except `auth/*` and `demo/*` require
`Authorization: Bearer <token>`. Errors: `{ "error": "message" }` with 4xx/5xx.

### Auth & public
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | company, name, email, password, contact, country, location, tin, currency |
| POST | `/auth/login` | → `{ token, user, client, subscription, caps }`; `need2fa` challenge or `need2faSetup` + setup token when the tenant enforces 2FA |
| GET | `/auth/me` | current session (+ `impersonating` in support mode) |
| POST | `/auth/2fa/setup` | setup token → QR + secret (forced-setup flow) |
| POST | `/auth/2fa/enable` | setup token + code → backup codes + full session |
| POST | `/auth/impersonate/:clientId` | SUPER only → 8-hour support-mode token |
| POST | `/auth/forgot` | → `{ ok, devToken }` (dev only) |
| POST | `/auth/reset` | token + new password (also used by `#/login?reset=TOKEN` links) |
| GET | `/demo/slots?day=YYYY-MM-DD` | taken slot ISO times |
| POST | `/demo` | day, time, name, email, company, phone, teamSize, interests[] |

### Workspace
| Method | Path | Cap | Notes |
|---|---|---|---|
| GET | `/dashboard` | dashboard | aggregates; money nulled without `stock.amounts` |
| GET | `/projects` | projects.view | projects + shaped phases (+insights, spend, team); scoped |
| POST | `/projects` | projects.create | plan limit on active projects |
| PUT | `/projects/:id/team` | team.create | replace the project's member list |
| POST | `/projects/:id/phases` | phases.edit | |
| PATCH | `/projects/phases/:id` | phases.edit | status/percent/assignee/details; done-guards |
| DELETE | `/projects/phases/:id` | phases.edit | returns materials to stock |
| POST | `/projects/phases/:id/materials` | phases.edit | draws from stock |
| POST | `/projects/phases/:id/insights` | phases.edit | |
| PATCH | `/projects/insights/:id` | updates.submit | tick/untick (records doneBy/doneAt) |
| POST | `/projects/insights/:id/proof` | updates.submit | multipart `media` files |
| DELETE | `/projects/insights/:id` | phases.edit | |
| GET | `/projects/updates` | updates.view | clients/guests: forwarded only |
| POST | `/projects/updates` | updates.submit | multipart `media`, counts, note, geotag |
| POST | `/projects/updates/:id/forward` | updates.forward | |
| GET | `/stock` | stock.view | money stripped without `stock.amounts`; project-scoped; store-scoped for assigned managers |
| POST | `/stock` | stock.edit | machine ⇒ serial required; optional projectId / storeId (a store pins the project) |
| POST | `/stock/bulk` | stock.edit | CSV template rows (≤500); returns added + skipped w/ reasons |
| PATCH | `/stock/:id` | stock.edit | incl. moving between stores |
| GET/POST | `/stock/stores` | stock.view / stock.edit | stores per project; POST/PATCH/DELETE are admin & Senior only; `managerId` assigns the store's Stock Manager |
| PATCH/DELETE | `/stock/stores/:id` | stock.edit | rename / set manager; delete moves items to unassigned |
| GET | `/stock/transferable` | stock.request | other stores' items (minimal: name/qty/store) for transfer requests |
| GET/POST | `/stock/transfers` | stock.view / stock.request | inter-store transfer requests; destination must be own store for assigned managers |
| PATCH | `/stock/transfers/:id` | source-store manager or stock.approve | APPROVED moves the stock / REJECTED |
| GET | `/stock/card/:cardId` | stock.issue | resolve a scanned card → worker or team member |
| POST | `/stock/issues` | stock.issue | hand items to a card-identified person; deducts stock |
| GET | `/stock/issues` | stock.view | issued-items log (store-scoped for assigned managers) |
| GET/POST | `/stock/requests` | stock.view / stock.request | |
| PATCH | `/stock/requests/:id` | stock.approve | APPROVED / REJECTED |
| GET/POST | `/stock/damaged` | damaged.view / stock.edit | |
| GET | `/members` | chat | id/name/role only (for invites & DMs) |
| GET | `/messages?to=all\|userId` | chat | channel or DM thread |
| GET | `/messages/threads` | chat | per-thread lastAt + incoming call invite |
| POST | `/messages` | chat | multipart `files`, text, recipientId, callRoom, invited[] |
| GET/POST | `/attendance/workers` | attendance.view / workers.manage | registry; unique card per client; optional projectId |
| POST | `/attendance/workers/bulk` | workers.manage | CSV rows; optional projectId for the batch |
| PATCH | `/attendance/workers/:id` | workers.manage | incl. card assignment, project, deactivate |
| GET | `/attendance/workers/badges` | attendance.view | QR badge sheet data (+ project per worker) |
| GET/POST | `/attendance/cards` | attendance.view | issued-cards log / generate a card (`workerId` or `userId` - team members too) |
| GET | `/attendance/sessions/active?projectId` | attendance.view | triggers midnight rollover |
| POST | `/attendance/sessions` | attendance.session | projectId + optional phaseId |
| PATCH | `/attendance/sessions/:id` | attendance.record | `{action:'mode'}` flip; `{action:'close'}` (managers) |
| POST | `/attendance/sessions/:id/scan` | attendance.record | card scan → auto record (workers AND team members) |
| POST | `/attendance/sessions/:id/tick` | attendance.record | manual toggle, labelled |
| GET | `/attendance/counts?projectId&phaseId` | attendance.view | today's crew: builders/helpers + `byType` + attended workers with phase |
| GET | `/attendance/report?projectId&from&to` | attendance.view | worker × day matrix |
| GET | `/docs?folder=root\|id` | docs.view | folders + docs of one folder; visibility filtered |
| POST | `/docs` | docs.upload | multipart `files`, folderId, visibility |
| PATCH | `/docs/:id` | docs.upload | rename/visibility/move (uploader or client) |
| DELETE | `/docs/:id` | docs.upload | uploader or client |
| POST | `/docs/folders` | docs.upload | |
| PATCH | `/docs/folders/:id` | docs.upload | rename (non-system); `restricted` (client, system only) |
| DELETE | `/docs/folders/:id` | docs.upload | non-system, empty only |
| GET | `/team` | team.view | incl. `totpEnabled`, `suspended`, `cardId` per member |
| POST | `/team` | team.create | role rules per creator; auto-generates the member's card id |
| PATCH | `/team/:id` | team.manage | `{ suspended }` - suspend / activate |
| DELETE | `/team/:id` | team.manage | refused while the member has recorded activity |
| POST | `/team/:id/reset-link` | team.create | reset link, optionally emailed (`sendEmail`) |
| POST | `/team/:id/password` | team.create | set a member's password directly |
| GET | `/reports?from&to&projectId&phaseId` | reports | reports-hub aggregate (KPIs, phases, labor, materials + per-store breakdown) |
| GET/PATCH | `/settings` | - / settings.edit | toggles + currency + location/TIN + worker types |
| POST/DELETE | `/settings/logo` | settings.edit | company branding logo |

### Account & personal 2FA
| Method | Path | Notes |
|---|---|---|
| PATCH | `/account/profile` | name/email |
| POST | `/account/password` | current + new |
| POST | `/account/2fa/setup` | → QR + secret |
| POST | `/account/2fa/enable` | code → 8 one-time backup codes |
| POST | `/account/2fa/disable` | password; 403 while the tenant enforces 2FA |

### Billing (cap `billing` - the Admin)
| Method | Path | Notes |
|---|---|---|
| GET | `/billing` | subscription state, plans, MoMo details, pending payment, history |
| POST | `/billing/checkout` | `{ plan, months }` → pending payment with `BR-XXXXXX` reference |
| POST | `/billing/payments/:id/submit` | `{ payerPhone }` - "I've sent the money" |
| POST | `/billing/payments/:id/cancel` | cancel own pending intent |

### Super Admin
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/dashboard` | monthly received/pending/due + renewal reminders + status counts |
| GET/PATCH | `/admin/settings` | platform settings (`renewalReminderDays`, 1–60) |
| GET | `/admin/clients` | all tenants + counts, plan, paidUntil, renewalAt |
| PATCH | `/admin/clients/:id` | `{ status: TRIAL\|ACTIVE\|SUSPENDED\|TERMINATED }` |
| GET | `/admin/payments` | MoMo payment queue (all companies) |
| PATCH | `/admin/payments/:id` | `{ action: confirm\|reject }` - confirm activates the company |
| GET | `/admin/demos` | demo-booking book (lifecycle: scheduled/done/no-show/canceled, time tracking) |
| GET | `/admin/audit?clientId&q` | cross-company **audit trail** (Super-Admin-only since audit left company reports) |

Static: uploaded media is served at `/uploads/<filename>`.

---

## 6. Data model (Prisma, `api/prisma/schema.prisma`)

| Model | Purpose / key fields |
|---|---|
| `Client` | tenant: company, contact, country, currency, `status`, `trialEndsAt`, **`plan`**, **`paidUntil`**, `settings` (Json toggles) |
| `User` | `clientId` (null for SUPER), role: SUPER/CLIENT/SENIOR/SITE/STOCK/GUEST, bcrypt hash, **`totpSecret`/`totpEnabled`/`backupCodes`**, `photo`, **`cardId`** (QR badge, unique), **`suspended`** |
| `ResetToken` | password-reset tokens, 1 h expiry |
| `ProjectMember` | project ↔ user assignment (unique pair) - drives project scoping |
| `Payment` | subscription payment: plan, months, amount, unique `reference` (BR-XXXXXX), payerPhone, status PENDING/CONFIRMED/REJECTED/CANCELED, confirmedBy |
| `PlatformSettings` | singleton (id 1): `renewalReminderDays` |
| `Project` | name, location, status, currency, budget, `documents` Json |
| `Phase` | status todo/active/done, percent (derived when insights exist), dates, budget, `costPerBuilder/Helper`, assignee |
| `KeyInsight` | phase checklist item: title, done, doneAt/doneBy, `media` Json proof |
| `PhaseMaterial` | stock draw snapshot: qty, `unitCostSnap`, `nameSnap` |
| `DailyUpdate` | builders, helpers, **`crew` Json** (per-worker-type counts from attendance), note, geotag, `forwarded`, → `Media[]`, `UpdateMaterial[]` |
| `UpdateMaterial` | items a daily report consumed: qty + name/unit/cost snapshots, deducted from stock on submit |
| `Media` | daily-update file: kind photo/video, path |
| `StockItem` | category Consumable/Machine, qty, unit, unitCost, serial, `lowThreshold`, **`projectId`** (null = general store), **`storeId`** (which of the project's stores holds it) |
| `StockStore` | a project's store: name (unique per project), **`managerId`** (its Stock Manager) - one project can run several |
| `StockTransfer` | inter-store request: item, fromStore → toStore, qty, status PENDING/APPROVED/REJECTED, requestedBy, decidedBy |
| `StockIssue` / `StockIssueItem` | proof of consumption: card-identified recipient (worker or user), issuer, items with qty + snapshots |
| `StockRequest` | itemName, qty, status PENDING/APPROVED/REJECTED, requester, **`projectId`** |
| `DamagedItem` | name, serial, note (invisible to STOCK role), **`projectId`** |
| `Message` | text, `attachments` Json (files + call invites w/ invited ids), `recipientId` (null = channel) |
| `Worker` | attendance registry: name, type (from Settings worker types), `cardId` (unique - one namespace with team members), dailyRate, `photo`, active, **`projectId`** (null = shared) |
| `CardIssue` | issued-card log: worker **or user** (team member), cardId, issuedBy |
| `AttendanceSession` | per project/day: optional phase, mode in/out/closed, opened/closed by |
| `AttendanceRecord` | per worker **or team member** per session: clockIn/OutAt, in/outMethod auto/manual, recorder, **`rateSnap`** (wage snapshot at clock-in; null for team members) |
| `Folder` | document folder: name, `system` (Design/Project Documents), `restricted` (client-only) |
| `Document` | name, path, kind, `visibility` public/private, uploader, optional folder |
| `AuditLog` | append-only: userName, action, detail |
| `DemoBooking` | public demo scheduler: unique `slot`, contact, interests |

Money is stored as integer amounts in the account currency (RWF by default).

---

## 7. Project layout

```
bridge/
├── logo.png                      # master logo (web copy at web/public/logo.png)
├── DEPLOY.md                     # hosting guide (VPS / Railway) + production checklist
├── api/
│   ├── prisma/schema.prisma      # data model
│   ├── src/server.js             # express app, route mounting, /uploads static,
│   │                             # serves web/dist in production
│   ├── src/auth.js               # JWT (+2FA setup & support-mode tokens), ROLE_CAPS,
│   │                             # capsFor, 2FA/expiry enforcement in authRequired
│   ├── src/plans.js              # subscription plans, prices, limits, MoMo details
│   ├── src/scope.js              # per-project scoping helpers
│   ├── src/db.js                 # prisma client + audit() helper
│   ├── src/seed.js               # demo data (idempotent)
│   ├── src/routes/{auth,demo,account,users,projects,stock,docs,attendance,billing,misc}.js
│   └── uploads/                  # user media (gitignore in production)
└── web/
    ├── vite.config.js            # port 5330 + /api,/uploads proxy (dev only)
    ├── index.html                # fonts (Poppins, Caveat), favicon /logo.png
    ├── public/logo.png           # served at /logo.png (sidebar, nav, badges, favicon)
    └── src/
        ├── api.js                # fetch wrapper (token, FormData), fmtMoney/fmtDate
        ├── auth.jsx              # AuthProvider: session, caps, can(), subscription,
        │                         # impersonating, refresh()
        ├── ui.jsx                # Modal, Field, ErrorNote, Avatar, Lightbox, useForm
        ├── App.jsx               # nav (cap-gated), routes, expiry lock screen,
        │                         # support-mode banner
        ├── styles.css            # entire design system
        └── pages/                # GetStarted, Pricing, Support, Demo, Login, Signup,
                                  # Dashboard, Projects, Kanban, Updates, Documents,
                                  # Attendance, Kiosk, Stock, Chat, Team, Reports,
                                  # Settings, Billing, Admin, Companies, Account
```

Dev-server launch configs (`bridge-web`, `bridge-api`) live in the Sales folder's
`.claude/launch.json` for Claude Code preview sessions.

---

## 8. Production checklist (before real users)

Full hosting walkthrough (VPS with PM2/nginx/certbot, or Railway/Render):
**[DEPLOY.md](DEPLOY.md)**. Highlights:

1. **Secrets & env**: strong `JWT_SECRET` (dev default is a placeholder!), real
   `DATABASE_URL`, `MOMO_NUMBER`/`MOMO_NAME` for checkout instructions.
2. **SPA serving is built in**: `cd web && npm run build` - the API serves `web/dist`
   automatically. One Node process + MySQL is the whole deployment.
3. **HTTPS is mandatory** (login tokens + kiosk camera needs a secure origin).
4. **Hardening**: add `helmet` and auth rate limiting; consider moving `uploads/`
   to S3-compatible storage (e.g. Cloudflare R2). Back up MySQL **and** `uploads/` daily.
5. **Mailer**: wire nodemailer for password resets (remove `devToken` from
   `/auth/forgot`), demo-booking notifications, and renewal-reminder emails.
6. **Jitsi**: self-host (Docker) or 8x8 JaaS; change `JITSI_BASE` in `Chat.jsx`.
7. **Seeded super admin**: change `super@bridge.app`'s password (or replace the user).

## 9. Known gaps / roadmap (PRD phases 3–5)

- Automated payment provider (MoMo Open API / Flutterwave) to replace the manual
  Super-Admin confirm - the flow and data model are already provider-shaped
- Customer-facing renewal notifications (email/SMS) - in-app Super Admin reminders exist
- Guests scoped per project by default (mechanism exists; guests currently see all)
- Offline-first PWA capture for field roles (PRD §8.2 differentiator)
- Per-client branding (logo/background), multi-currency per project UI
- Change orders / BOQ, PDF export beyond browser print
- Websockets for chat (currently 4 s polling); cross-device read receipts
- Visitor log, project schedule reminders
- Phase archive (soft delete) as an alternative to hard delete
