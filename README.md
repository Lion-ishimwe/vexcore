# Bridge Construction

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
cd api && npm install && npx prisma db push && npm run seed && npm run dev   # API :4311
cd web && npm install && npm run dev                                          # Web :5330
```

## Demo logins (password `demo1234` unless noted)

| Email | Role |
|---|---|
| chantal@demo.rw | Admin (account owner) |
| eric@demo.rw | Senior Engineer |
| jp@demo.rw / aline@demo.rw | Site Engineers |
| divine@demo.rw | Stock Manager (no monetary amounts, no damaged items) |
| guest@demo.rw | Guest (view-only) |
| super@bridge.app / `super1234` | Super Admin (client management) |

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
- **Subscriptions & payments**: Starter/Pro/Enterprise plans, manual **MTN MoMo**
  checkout (unique reference → Super Admin confirms → account activates,
  `paidUntil` extends). Expired trial/subscription locks the workspace behind a
  pay-to-unlock screen. Plan limits enforced (projects count, team roles).
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
- Daily reports close the day: the submit form includes **items used** (picked from the
  project's stock + general store, quantities validated and **deducted from stock** on
  submit, name/unit/cost snapshotted). Reports show the day's attended workers with
  their pay and the items/materials used when they reach the Senior Engineer / Admin
  (amounts hidden from Site/Guest). Items consumed by a phase-scoped report count into
  that phase's materials cost. The Admin never submits daily updates - reports reach
  them via the submit → forward chain (enforced server-side).
- Stock: consumables + machines (serial required), **CSV template + bulk upload**,
  low-stock alerts, request → approve/reject flow, damaged-item log (hidden from
  Stock Manager). Audit trail on all key actions.
- Attendance: worker registry (CSV bulk enrolment, printable QR badges, issued-cards
  log), card-tap **kiosk**, per-phase sessions with pause/activate, time windows,
  reports with CSV export.
- Chat: company channel + **private DMs** with unread dots, **voice notes** (in-browser
  recording), attachments (8 × 50 MB), **video calls** (embedded Jitsi) with member
  invites and ringing banners. Every photo opens in an in-app lightbox with
  permission-gated download.
- Documents with folders, visibility rules and a dashboard design slider; weather widget.
- Team page: card directory with search/filters/CSV export and admin-generated
  **password-reset links**.
- **Super Admin**: finance dashboard (monthly received / due / pending, renewal
  reminders with a configurable window), MoMo payment queue, **Companies** directory
  (statuses, renewal dates) and **support mode** - open any company's workspace as its
  admin (audited, lock-bypassing, platform-endpoints blocked).
- Production-ready serving: the API serves the built web app - one Node process +
  MySQL. See [DEPLOY.md](DEPLOY.md).

## Not yet built (planned)

Automated payment provider API (manual MoMo confirm today), customer-facing renewal
emails/SMS, per-client branding, offline-first PWA sync, visitor log, PDF export
beyond print, websockets for chat.
