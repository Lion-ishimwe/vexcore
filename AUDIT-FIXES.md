# Audit remediation + stock returns

Companion to [AUDIT.md](AUDIT.md). Date: 2026-08-02.
Every Critical and High finding is fixed, along with the security- and
data-integrity-relevant Mediums. Each item below was exercised against the
running app, not just edited.

---

## Critical

**C1 — Reset token returned in the response.** `api/src/routes/auth.js` no
longer emits `devToken` under any condition; without SMTP the link is printed to
the server console instead. `POST /api/auth/forgot` now returns
`{ok:true, emailed:true}` and nothing else.

**C2 — `/uploads` served with no authentication.** The static mount is gone.
`api/src/uploads.js` resolves each filename back to the record that owns it
(document, daily-update media, worker/user photo, company logo, chat attachment,
insight proof — the last two via `JSON_SEARCH`) and checks it against the
caller's account, plus document visibility and folder restriction. `<img>` tags
cannot send an `Authorization` header, so the session token is mirrored into an
**httpOnly** cookie set at login and kept in step with the sliding refresh; the
cookie is unreadable from script, so this does not widen the XSS surface.
Deleting a document, replacing a photo or removing a logo now unlinks the file.
Verified: logged-out fetch of a known file → **401**; same file in-app → 200
with `nosniff`; `../.env` traversal → 404.

**C3 — No upload type filter.** One shared `uploader()` factory in
`uploads.js` with an extension allowlist; the extension is re-derived from that
list rather than taken from the filename, so `Content-Type: image/png` +
`evil.html` is refused. `.html/.htm/.svg/.xhtml` are deliberately absent.
Non-media types are served `Content-Disposition: attachment`, everything gets
`nosniff` and a restrictive CSP. Verified: `evil.html` upload → **400 "not an
accepted file type"**; PNG upload → 200.

**C4 — `JWT_SECRET` fell back to `'dev'`.** The API now exits at boot if it is
missing or under 32 characters, printing a generator command. `jwt.verify` pins
`algorithms: ['HS256']`. The dev `.env` got a real 64-char secret; the entrypoint
performs the same check before touching the database.

---

## High

**H1 — Cross-tenant `phaseId` on daily updates.** The phase is now looked up
scoped to the posted project. Verified with a second tenant: posting company A's
update against company B's phase → **400 "That phase is not part of this
project"**.

**H2 — No rate limiting.** `api/src/rateLimit.js` (dependency-free, in-process):
login 10 per 15 min **per IP+email** — which also throttles the TOTP and
backup-code steps, since both live behind `/login` — plus limits on
`/forgot`, `/reset`, `/signup`. A successful login clears the counter so an
honest user who mistyped is not left locked out. Verified: 10×401 then
**429**, while a different account still logs in.

**H3 — Money masking was client-side only.** `GET /api/projects` now nulls
`budget`, `spent`, `wagesSpent`, `laborSpent`, `materialsSpent`,
`costPerBuilder/Helper` and material unit costs without `stock.amounts`, matching
what `/dashboard` and the phase report already did. Percentages and names still
come through. Verified: Site Engineer sees `budget:null, spent:null,
percent:37`; admin sees the real figures.

**H4 — Project delete broke once a store existed.** The delete transaction now
clears `StockTransfer` rows on both sides and `StockStore`, and releases
`storeId` as well as `projectId` on items. Verified: project + store + item →
delete → **200**.

**H5 — Chat froze past 100 messages.** `GET /api/messages` takes the newest 100
(`orderBy id desc` then reversed) and accepts `?before=<id>` to page back, with
`x-has-more` on the response.

**H6 — `checkLowStock` could kill the process.** Wrapped in try/catch, so the
fire-and-forget calls can no longer raise an unhandled rejection.

**H7 — Logout left the Super Admin token behind.** `endSession()` clears
`bridge_token` **and** `bridge_super_token` and calls a new `POST /auth/logout`
to drop the server cookie. It runs on logout, idle timeout, and every forced
sign-out path.

**H8 — multer 1.4.5-lts.1 (EOL, DoS CVEs).** Upgraded to **2.2.0**;
`npm audit` reports 0 vulnerabilities.

**H9 — Live Gmail app password in `api/.env`.** *Not something code can fix —
the credential must be revoked in the Google account's App Passwords page and
reissued.* Still outstanding on your side.

---

## Medium (security / data integrity)

- **Session revocation.** New `User.sessionsValidFrom`; password change, self-service
  reset and admin reset all stamp it, and `authRequired` rejects older tokens.
  The tab that changed the password is handed a replacement rather than kicked out.
- **Cross-tenant `assigneeId`** on phase create/patch → validated against the account.
- **Project-scope on phase children** — insights (edit/proof/delete/create), phase
  delete and material draws now go through `phaseInScope`/`phaseForInsight`.
- **Attendance scope** — `openSession` and a new `sessionInScope` cover
  `GET/PATCH /sessions/:id`, `/scan`, `/tick`; `/counts` validates `projectId`.
- **Negative stock races** — the three check-then-act paths (phase draw, daily
  report, issue) now decrement conditionally (`where qty >= n`) inside the
  transaction and return 409 if the item ran out, matching the pattern transfer
  approval already used.
- **Negative quantities/costs** refused on stock create/patch/bulk.
- **Phase status** restricted to `todo|active|done`; the PDF colour lookup also
  falls back rather than throwing mid-stream.
- **Empty checklist** no longer leaves a phase frozen at 100%.
- **Orphaned uploads** cleaned up on every post-upload failure path and in the
  global error handler.
- **Email injection** — body lines escaped (only `<b><i><em><strong><br>` kept),
  button URLs restricted to http(s), recipients and subject sanitised, and
  addresses validated on signup and team create.
- **CORS** restricted to `APP_URL`/`CORS_ORIGINS` instead of every origin.
- **`GET /api/settings`** returns the access-control toggles only to roles that
  can edit them.
- **500s → proper status codes** — unknown daily-report id on forward → 404;
  invalid `from`/`to` dates → 400 (verified).
- **Error handler** checks `headersSent` before writing a body.

## Medium (front end)

- Chat poll, attendance session poll, stock card lookup and the returns lookup
  are all generation-guarded, so a slow response can no longer overwrite newer
  state — this is what previously credited the wrong person on an issue slip and
  let taps be written against another site's session.
- Reports refetch is sequenced; date presets use local calendar days
  (`dayInput`), so "This month" starts on the 1st in every timezone.
- A 403 `accountClosed` now ends the session and explains why at the login
  screen, instead of leaving a live-looking UI whose buttons silently fail.
- `/auth/me` only drops the token on a real 4xx, so a brief offline moment no
  longer logs a site engineer out.
- Double-submit guards on create-account, insert-stock, create-phase,
  enrol-worker and email-reset.
- Attendance time-window inputs are debounced and local until saved.
- Microphone released if Chat unmounts mid-recording; kiosk shows a clear
  "taps are NOT being recorded" state instead of an endless spinner;
  `window.open` on documents uses `noopener`.

## Deployment

`Dockerfile` runs as **non-root** (with uploads ownership set before `VOLUME`,
so the mount stays writable) and has a `HEALTHCHECK` against the new public
`/healthz`. Compose can create a scoped DB account — defaulting to `root` so
existing deployments still start, with upgrade steps in DEPLOY.md. The entrypoint
fails fast on a weak `JWT_SECRET` and no longer implies "database unreachable"
when the real problem is a refused schema change. DEPLOY.md's backup commands
were wrong as written (host shell has no `$DB_PASSWORD`, hard-coded volume name)
and are fixed; Render/Railway `db push` moved from build to start.

### Live database: migrations + backups (done 2026-08-03)

**`prisma migrate` replaces `prisma db push`.** `api/prisma/migrations/0_init/`
holds the baseline (31 tables), and boot now runs `api/src/migrate.js`, which
waits for MySQL, **baselines** a database that has no migration history — marking
`0_init` applied rather than recreating anything, so upgrading an installation
built with `db push` loses nothing — then applies pending migrations, failing
the boot rather than serving against a schema it could not update.

Verified against real databases, not just read:

| Case | Result |
|---|---|
| Empty database | 31 tables + history created |
| Existing `db push` database **with data** | baselined; 1 client / 1 user intact, nothing dropped |
| Run again | "No pending migrations" — idempotent |
| New migration on the baselined database | applied, column added, data intact |

Day-to-day: `npm run migrate:new -- describe_change` writes a migration file to
commit; `npm run migrate:status` shows state; deploys apply it automatically.

**Automated backups.** A `backup` sidecar in compose dumps the database
(`--single-transaction`) *and* snapshots uploads nightly into `./backups` on the
host — both halves, because a database without its files restores an app of
broken links. Retention (`BACKUP_KEEP_DAYS`, default 14) prunes **only after a
successful run**, so a spell of failures cannot delete the last good copy;
writes go to `.part` files and are renamed on success, so a crash never leaves a
truncated backup looking valid. `./backups` is a bind mount, so it survives
`docker compose down -v`, and is gitignored/dockerignored. The scheduling
arithmetic was unit-tested across edge cases including exactly-on-the-hour
(which must wait 24h, not spin). For the VPS path, DEPLOY.md now installs a cron
script and runs it once to prove it works. Restore commands are documented.

**Still yours to do:** copy `./backups` off the machine (rclone/restic/S3) — a
backup on the same disk as the database does not survive losing the disk — and
test a restore into a scratch database before you need it.

**Still not verified by me:** none of the Docker changes have been executed,
because Docker is not installed on this machine. The shell scripts pass `sh -n`
and the compose file parses, but the first `docker compose up -d --build` should
be done somewhere you can watch `docker compose logs -f app backup`.

---

## New feature — stock returns

A worker takes 100 bags in the morning and brings the unused ones back in the
afternoon; that hand-back is now recorded.

**Model.** `StockReturn` + `StockReturnItem`, each return tied to the original
`StockIssue`, plus `StockIssueItem.returnedQty` — so *outstanding* (`qty -
returnedQty`) is always known per line.

**Rules.** Good quantities go back into the store's stock. Damaged ones do
**not** — they are written to the Damaged-items log with who returned them, so
stock never counts a broken item as usable. Partial returns are normal: whatever
is not handed back stays outstanding. Returning more than is outstanding, or
returning something issued to somebody else, is refused. A conditional update
guards against two people recording the same hand-back at once.

**Endpoints.** `GET /stock/outstanding/:cardId` (what this person still holds),
`POST /stock/returns`, `GET /stock/returns`; `GET /stock/issues` gained
`returnedQty`/`outstanding` per line.

**UI.** "Record return" next to "Issue items": scan the card, see exactly what
is still out, enter good and damaged per line ("Return everything" fills the
rest), submit. The issues table shows a running "still out" badge and the new
Returns table shows what came back, damaged items flagged.

Verified end to end in the browser: 100 bags issued → 30 good + 5 damaged
returned (stock +30, damaged log written, 65 still out) → 40 more returned via
the UI → 25 still out. Over-returning and wrong-person returns both refused.

---

## Round 3 (2026-08-03): wages, demo accounts, remaining correctness

**Wages were counted twice for a worker on two sites the same day.** The
de-duplication keyed on `project|worker|day`, so a worker who moved between
projects earned their daily rate once per project. Project spend, the dashboard
and the reports hub all overstated payroll while the attendance report (keyed on
worker+day) showed the true figure — the same worker-day produced different
money on different screens.

Now keyed on `worker|day` across the **whole account**, in both
`wagesForProjects` and the reports hub. Sessions are loaded for the entire
client rather than the filtered projects, because the de-dup has to see sessions
outside the current filter to know whether a day is already claimed; the
earliest session of the day wins, so attribution is stable whichever project you
are looking at.

Verified with a worker (rate 10,000) clocked into two projects on one day:
project spend **10,000**, attendance report **10,000**, reports hub **10,000** —
and under a project-2 filter the day correctly shows as already claimed by
project 1 rather than being counted again. Previously project spend was 20,000.

**Demo accounts.** `npm run purge:demo` suspends them, randomises their
passwords, clears any 2FA and revokes live sessions; `-- --wipe` deletes the
demo company outright. Run here in the safe mode: all six demo logins now return
401, the Super Admin and your own admin account still work, and all history
keeps its author.

**Super Admin is no longer a published default.** The seed takes
`SUPER_EMAIL`/`SUPER_PASSWORD` from the environment and refuses to create the
account without 12+ characters — there is no `super1234` fallback. The demo
dataset only loads with `SEED_DEMO=true`. Credentials were removed from README,
DOCUMENTATION.md and DEPLOY.md, replaced with the purge instructions.

**Other correctness fixes in this round:**

- **`guestAccess` was dead code** — declared but never read, so an admin who
  switched guest access off still left guests with the dashboard, projects and
  documents. It now revokes every capability.
- **Attendance day rollover** — auto clock-out stamped 23:59, crediting ~17
  hours to anyone who forgot to tap out; it now uses the configured clock-out
  window (or 18:00). Sessions nobody used no longer respawn daily for ever, the
  close is transactional, and a concurrent request can no longer create a
  duplicate session for the same project.
- **Subscription months** were 30-day blocks, so a yearly payment lost ~5 days
  every year. Now real calendar months, with short-month clamping (31 Jan + 1
  month → 28 Feb, not 3 Mar). Checked across seven edge cases.
- **Kiosk double-tap** returned a bare 500 to the gate guard; a duplicate insert
  is now reported as "already clocked in".
- **Payment intents** — concurrent checkouts could leave two open references;
  strays are retired. The retry loop no longer swallows genuine database errors
  as reference collisions.
- **Worker cards can no longer shadow a team badge** — scans resolve workers
  first, so this previously let stock issues and attendance be attributed to the
  wrong person.
- **Impersonation tokens** cut from 8 hours to 60 minutes (unrevocable, and they
  bypass suspension/2FA/subscription gates).
- **Unbounded lists** — stock requests and damaged items capped at 200.

## Round 4: "delete logs me out"

Three separate causes, two of them introduced by this remediation work:

**1. Sessions on suspended accounts are force-logged-out (mine).** `purge:demo`
suspended the six demo accounts, including `chantal@demo.rw`, which the docs
labelled "Admin (account owner)". Any browser still signed in as one of them now
gets `403 accountClosed` on its next request, and the client ends the session —
correct behaviour, but it lands mid-action and looks like the delete caused it.
**Sign in as a real account** (`lionelishimwe75@gmail.com`), not a demo one.

**2. Support-mode tokens had become a hard deadline (mine).** Shortening
impersonation from 8h to 60m exposed the fact that the `actAs` branch of
`authRequired` returns *before* the sliding-renewal block, so support tokens
never refreshed. At 8 hours nobody noticed; at 60 minutes support mode expired
mid-session → `401 sessionExpired` → forced logout. Support sessions now slide
on activity like normal ones, so 60 minutes is idle time, not total time.
Verified: no refresh header on a fresh token, a new one after 61s of age.

**3. A plain Super Admin got a 500 from every workspace route (pre-existing).**
`req.client` is null for a Super Admin — they have no company of their own — and
every workspace route dereferences `req.client.id`. `/projects`, `/docs`,
`/team`, `/settings`, `/dashboard`, `/stock` all returned 500. A new
`requireClient` guard returns a clear 400 explaining that they need to open a
company from Companies → *Open as support*. The platform panel (`/admin/*`) is
unaffected. Verified: 400 with guidance instead of 500; `/admin/*` still 200;
support mode can create and delete inside a company.

Also: a forced logout now carries its reason to the login screen instead of
dumping the user on a bare form.

Worth knowing (working as designed, not a bug): changing any password revokes
that account's other sessions, so a tab left open elsewhere gets logged out on
its next request.

## Round 5: Super Admin can permanently delete a company

`DELETE /api/admin/clients/:id` erases a tenant and everything it owns — users,
projects, phases, daily reports and media, attendance sessions and records,
workers and cards, stock items, stores, transfers, issues and returns,
documents and folders, messages, audit trail, payments — and unlinks its
uploaded files from disk. Suspend remains the reversible option; this is
deliberately the other one.

**Guards** (all verified against a throwaway tenant):

| Attempt | Result |
|---|---|
| Wrong / partial confirmation text | 400, nothing deleted |
| No confirmation at all | 400, nothing deleted |
| Ordinary company admin | 403 Super Admin only |
| From inside a support session | 403 (support mode drops the SUPER role) |
| Correct confirmation, real Super Admin | deleted, every table returns 0 rows |

The UI matches: the confirm button stays disabled until the typed name matches
exactly (partial and wrong-case both blocked), and the server re-checks it, so
the API cannot be driven around the dialog. Cancel leaves everything intact.

**The deletion leaves a record.** A deleted company takes its own `AuditLog`
rows with it, so a new `DeletedClient` table keeps company, plan, status, signup
date, who deleted it and per-table row counts — written **inside the same
transaction** as the deletion, so a company can never vanish without a trace.
Readable at `GET /api/admin/deleted-clients`.

The cascade lives in one place (`api/src/deleteClient.js`) and is shared with
`purge:demo -- --wipe`, so the two cannot drift as tables are added — a table
missed in one of two copies would leave orphan rows or an FK that blocks the
delete outright.

Also fixed while building this: `prisma migrate dev --skip-generate` left the
client without the new model, so the first delete succeeded but 500'd on the
record. Regenerated, and the record moved inside the transaction so a failure
there rolls the deletion back rather than losing the trace.

## Confirmation dialogs

All 19 native `window.confirm` / `alert` / `prompt` calls were replaced with a
centred in-app modal (`DialogProvider` in `web/src/ui.jsx`), keeping the same
await-able shape. Escape and backdrop cancel, Enter confirms, destructive
actions get a red icon and a named action button ("Delete project" rather than
"OK"). Verified centred to within 3px on both axes, and that Escape cancels
without deleting anything.
