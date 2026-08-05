# System Audit — Bridge CMS

Date: 2026-07-31
Scope: full system — `api/src` (all routes, auth, schema), `web/src` (all pages), Docker/compose/deploy config and docs.
Method: four independent reviewers (security, backend correctness, frontend, config/deployment), each reading the relevant files in full. Findings below were verified against the code before being recorded.

---

## Executive summary

The application is well built in most respects. Money is stored as integers throughout (no floating-point currency bugs), history is preserved with snapshot fields, there is no SQL injection, no mass-assignment or prototype-pollution surface, no `dangerouslySetInnerHTML` anywhere in the front end, route guards derive from server-issued capabilities, and the Docker build layout is internally consistent. Those are real strengths and they are worth keeping.

The problems are concentrated in three places: **the authentication perimeter**, **file uploads**, and **multi-tenant isolation on secondary records**. Any one of the four Critical/High items below is enough to compromise the platform in production, and none of them require a sophisticated attacker.

The single most urgent item is the password-reset endpoint returning the reset token in its own response.

---

## Critical — fix before any production deployment

### C1. Anonymous takeover of any account via password reset
`api/src/routes/auth.js:167,182`

`POST /api/auth/forgot` responds with `{ devToken: <valid reset token> }` whenever SMTP is not configured. `mailConfigured` is simply `!!process.env.SMTP_HOST` (`api/src/mail.js:4`), and both `.env.example` and `docker-compose.yml:31` ship `SMTP_HOST` empty. There is no `NODE_ENV` guard on this branch.

**Exploit:** an anonymous attacker POSTs `{"email":"super@bridge.app"}` to `/api/auth/forgot`, reads the token from the JSON response, then POSTs it with a new password to `/api/auth/reset`. Two unauthenticated requests, no rate limit, and they own the platform Super Admin — every tenant, every payment record, impersonation of every company.

**Fix:** delete the `devToken` branch entirely, or gate it on `process.env.NODE_ENV !== 'production'`. Deleting it is safer.

### C2. `/uploads` is served with no authentication
`api/src/server.js:39` — `app.use('/uploads', express.static(path.resolve('uploads')))` is mounted before any auth middleware.

Every uploaded file of every tenant is fetchable by URL by anyone who can reach the server, logged out: documents marked "Private (only me)", files inside `restricted` folders, worker ID-card portraits and photos, chat attachments, company logos. The UI at `web/src/pages/Documents.jsx:144-148` promises privacy that does not exist — `visibleWhere()` filters the *listing* only.

Two aggravating details: `api/src/routes/docs.js:139` deletes only the database row, so "deleted" documents remain downloadable forever; and the `mediaDownload` setting is advisory only (`projects.js:857-858` returns a `canDownload` flag alongside the raw URL).

**Fix:** replace the static mount with an authenticated route that resolves the file's owning record, checks `clientId` and document visibility, then streams it. Unlink files on delete.

### C3. Uploaded files keep the client's extension with no type filter — stored XSS on the app origin
`api/src/routes/docs.js:12-19`, `projects.js:16-23`, `misc.js:17-24` have no `fileFilter` at all. All upload configs build the stored name as `Date.now()-<rand> + path.extname(file.originalname)`. `photoUpload` (`account.js:23`) checks only the client-supplied `mimetype`, so `Content-Type: image/png` with `filename="x.html"` still lands as `.html`.

In production the same Express process serves both `web/dist` and `/uploads` (`server.js:39,55-63`), so an uploaded `.html` or `.svg` executes as first-party JavaScript. The session token lives in `localStorage.bridge_token` (`web/src/api.js:1-7`), and `web/src/pages/Documents.jsx:100-103` opens documents with `window.open(d.url)`.

**Exploit:** any user with `docs.upload` uploads `notes.html`, a colleague clicks the document card, and the file reads their token and exfiltrates it. If the victim is a Super Admin in support mode, the parked `bridge_super_token` goes too.

**Fix:** whitelist extensions server-side against a fixed list, re-derive the extension from the sniffed content type rather than the filename, and serve uploads with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. Serving user files from a separate origin is the durable fix.

### C4. `JWT_SECRET` falls back to the literal string `'dev'`
`api/src/auth.js:5` — `const SECRET = process.env.JWT_SECRET || 'dev'`.

`docker-compose.yml:28` enforces the variable, but the documented `npm start` / PM2 path (DEPLOY.md Option A) does not. If the variable is missing, anyone forges `HS256 {uid: <any id>}` and becomes that user, including SUPER. The dev value currently in `api/.env` (`bridge-dev-secret-change-in-production`) is equally guessable.

**Fix:** throw at boot if `JWT_SECRET` is unset or shorter than 32 bytes. Also pin `algorithms: ['HS256']` on every `jwt.verify` call (`auth.js:130,143`).

---

## High

### H1. Cross-tenant write via unvalidated `phaseId` on daily updates
`api/src/routes/projects.js:939` — `phaseId` is coerced to a number and stored without checking it belongs to the project or the caller's client. The project is validated at line 871; the phase is not.

A site engineer in company A submits an update against their own project but with a `phaseId` belonging to company B. The row is then pulled into B's phase report through the `updates` relation: it inflates B's crew estimate and spend, injects attacker-named materials into B's material list, and — because its uploaded photo satisfies the `hasPhotoProof` gate (`projects.js:363-365`) — lets a phase in company B be signed off without genuine proof.

### H2. No rate limiting or lockout anywhere on the API
`server.js` installs only `cors` and `json`; there is no `express-rate-limit` in `api/package.json`.

`/login` allows unlimited password guessing. More seriously, `/login` also allows **unlimited TOTP guessing** (`auth.js:85-99`) — six digits verified per request with no attempt counter — and unlimited backup-code guessing, so two-factor authentication is brute-forceable once the password is known. `/forgot`, `/reset`, and the public `/api/demo` booking endpoint (which emails every Super Admin per call) are equally open.

### H3. Money masking on projects and phases is client-side only
The UI hides amounts behind `showMoney = can('stock.amounts')` (`web/src/pages/Projects.jsx:82`, `Kanban.jsx:46`), but `GET /api/projects` returns `budget`, `spent`, `wagesSpent`, `laborSpent`, `materialsSpent`, `costPerBuilder` and `costPerHelper` unconditionally, gated only on `projects.view` (`api/src/routes/projects.js:99-111,142-145,171-177`).

A GUEST — described in the Access Control screen as "View-only visitor, never sees monetary amounts" (`web/src/pages/Settings.jsx:25`) — reads every project budget and spend figure from the network tab or a one-line `curl`. This is the odd one out: `/dashboard`, `/attendance/report` and the phase report all null out money server-side, so the pattern to copy already exists.

### H4. Project delete fails permanently once a stock store exists
`api/src/routes/projects.js:243-262` — the delete transaction cleans phases, updates, attendance, members, requests, damaged items, workers and stock items, but never `StockStore` (or `StockTransfer`). The schema declares no `onDelete` anywhere, so Prisma's default `Restrict` applies (`schema.prisma:270`).

Create a store for a project, then try to delete the project: the foreign key blocks it, the transaction throws, and the caller gets a generic 500. The project becomes permanently undeletable.

### H5. Chat returns the oldest 100 messages, so conversations freeze
`api/src/routes/misc.js:53-58` — `orderBy: { createdAt: 'asc' }, take: 100` returns the *first* 100 rows ever written, with no pagination.

Once a channel or DM thread passes 100 messages, nothing sent afterwards is retrievable by any client. The correct pattern (`desc` + reverse) is already used in `/api/stock/issues`.

### H6. Fire-and-forget `checkLowStock` can crash the process
Called without `await` or `.catch` at `projects.js:520`, `projects.js:966`, `stock.js:314`, `stock.js:444`, `stock.js:519`. The function performs up to three Prisma queries with no internal try/catch (`stockAlerts.js:8-38`).

A transient database error during the alert lookup after a stock draw becomes an unhandled rejection, which terminates Node ≥15 — killing every in-flight request. One `try/catch` inside `checkLowStock` fixes it.

### H7. Logout does not clear the parked Super Admin token
`web/src/auth.jsx:20` clears `bridge_token` only. `bridge_super_token` (written at `Companies.jsx:55`, `Admin.jsx:122`) is removed exclusively by "Exit support" (`App.jsx:135-141`) — not by logout, not by the idle timer (`App.jsx:154-158`), not by either 401 path in `api.js:26-37`.

An operator who enters support mode on a customer-site machine and then clicks "Log out" leaves a valid platform-wide SUPER token in `localStorage` for the next person at that keyboard.

### H8. multer 1.4.5-lts.1 is end-of-life with known DoS CVEs
`api/package.json:19`. Multer 1.x is deprecated; 2.x fixed CVE-2025-47935 (memory leak leading to resource exhaustion) and CVE-2025-47944 (malformed multipart request crashes the process). This app is upload-heavy and runs a single Node process, so an unauthenticated malformed request can take the whole system down.

### H9. Live Gmail app password sitting in the working tree
`api/.env:12-13` contains `abbridgeconstruction@gmail.com` and a live-format Google App Password. The file is correctly gitignored and verified untracked — but this project is itself a clone, which means the secret travelled with a folder copy. Anyone with read access to this directory can send mail as that mailbox.

**Action:** revoke it in the Google account's App Passwords page and issue a new one.

---

## Medium

**Multi-tenant and scope gaps**

- Cross-tenant `assigneeId` on phases (`projects.js:280,347`) accepts any user id with no client check, and the response includes the assignee's real name — so a senior can enumerate the name of every user on the platform, and permanently attach foreign users to their phases.
- Project-scope (`ProjectMember`) enforcement is missing on phase children: `phaseForInsight` (`projects.js:133-138`) filters on `clientId` only, so insight edit/proof/delete (`:462,477,491`), insight creation (`:445`), phase delete (`:420`) and material draws (`:501`) reach any phase in the company. Since insights drive phase percent, a user scoped to project A can move project B's completion — or delete B's phase and silently return its materials to stock.
- The same gap runs through attendance (`attendance.js:460,524,600,668,717`): an engineer scoped to project A can scan and clock out workers on project B's live session, forging wage-bearing records.
- Password change and reset do not invalidate existing sessions (`account.js:83-86`, `auth.js:190`); tokens carry only `{uid}` with no version check, so a stolen token survives the victim changing their password and renews itself indefinitely via the sliding-refresh header.

**Data integrity**

- Check-then-act races allow negative stock in three endpoints (`projects.js:507-521,926-962`, `stock.js:487-518`): availability is validated outside the transaction and decremented unconditionally inside it. Two concurrent issues of 8 against a stock of 10 both succeed. The correct pattern — re-checking inside the transaction — already exists at `stock.js:277-308`.
- Wage arithmetic disagrees between modules: project spend keys on `project|worker|day` (`projects.js:45`) and pays a worker twice for a day spent on two projects; the attendance report keys on worker+day and pays once. The same worker-day produces different money on different screens.
- Phase status accepts any string (`projects.js:346`), which skips sign-off logic and later throws mid-stream inside the schedule PDF (`projects.js:616` indexes a colour map with the unknown status), producing a corrupt download plus a "headers already sent" error.
- Deleting a phase's last insight leaves the stored percent frozen at its old value (`projects.js:126-131`), so an empty checklist can read as 100% complete.
- Negative quantities and costs are accepted into stock (`stock.js:359,429` use `Number(x) || 0`), feeding negative values into stock valuation and dashboard totals.
- `rolloverStale` (`attendance.js:48-124`) is non-transactional and self-perpetuating: concurrent requests create duplicate sessions, an abandoned session respawns daily forever, and auto clock-out stamps 23:59 — recording ~17 hours for a worker who forgot to tap out.
- Orphaned uploads accumulate on every post-upload validation failure (`projects.js:863-872`, `misc.js:109-121`, `projects.js:477-484`), and no delete path unlinks files.

**Front-end races and UX failures**

- Chat polling can paint one conversation's messages under another's header and mark the wrong thread read (`Chat.jsx:82-96`) — no request-generation guard.
- The attendance session poll can populate project B's view with project A's in-flight response, after which the engineer clocks workers against the wrong session (`Attendance.jsx:68-94`).
- Stock card lookup can name the wrong recipient on the issue slip while sending a different card id in the POST (`Stock.jsx:69-79,236-243`) — the permanent consumption record credits the wrong person.
- The fetch wrapper handles only two specific 401 shapes (`api.js:23-43`), so a suspended user (403) keeps a fully rendered UI with live buttons that silently fail, and is never returned to the login screen.
- Any `/auth/me` failure destroys the session (`auth.jsx:13-16`), so a brief offline moment logs a site engineer out.
- The kiosk hangs on "Loading…" indefinitely if its session id 404s or Wi-Fi drops at boot (`Kiosk.jsx:29-30,148`), with no indication that taps are not being recorded.
- Double-submit is possible on most forms — enrol worker, insert stock, create phase, create project, create team account, send reset invitation — because they lack the `busy` flag that `Chat.send` and `Updates.submit` use correctly.
- Attendance time-window settings PATCH on every keystroke with no debounce (`Settings.jsx:436-449`); racing responses can persist a clock-in window nobody chose.
- Date presets use `toISOString()` on local Dates (`Reports.jsx:20-21`, `Attendance.jsx:55-58`), so "This month" starts on the 2nd for any viewer at or west of UTC, dropping the 1st from every figure. The API deliberately avoids this; the client re-introduces it.
- A single failed background request replaces the entire page with one line of text and no retry control (`Stock.jsx:249` and five other pages).
- Video calls run on a public third-party Jitsi instance with guessable room names (`Chat.jsx:15,156`).
- The microphone is never released if Chat unmounts mid-recording (`Chat.jsx:90-94`).

**Other**

- HTML injection into outbound platform emails (`mail.js:29` interpolates `lines` unescaped): an anonymous demo booking with a `<a href>` in the name field sends platform-branded phishing to every Super Admin.
- No email format validation on signup or team creation (`auth.js:42`, `users.js:38`), and those raw values are later joined into a `to:` header.
- Wide-open CORS with no origin allowlist (`server.js:19`), and no `helmet`, so no `nosniff` on `/uploads`.
- Unbounded queries on hot endpoints: `GET /api/projects` includes every daily update with all media for every phase; `/api/reports` and `wagesForProjects` load the client's entire attendance history for a 7-day range; stock requests and damaged items have no `take` at all.
- Invalid date query strings become `Invalid Date` and reach Prisma as 500s (`misc.js:386-391`, `attendance.js:755-756`).
- `prisma db push` is the production migration strategy (`docker-entrypoint.sh:10`, DEPLOY.md). No migration history, no rollback; a destructive schema change either fails the entrypoint's 30-retry loop and leaves the deployment down, or drops data.
- The app connects to MySQL as root (`docker-compose.yml:27`) and the container runs as root (no `USER` in the Dockerfile).
- No automated backups anywhere — only a manual command and a commented-out crontab line in DEPLOY.md.
- No healthcheck on the app container, so a wedged Node process stays "Up" forever.
- Email links default to `http://localhost` unless `APP_URL` is set explicitly (`mail.js:3`, `docker-compose.yml:29`), and DEPLOY.md's VPS `.env` heredoc omits `APP_URL` entirely — so real reset emails go out with dead links.

---

## Low

Documented in the per-area findings; the notable ones are audit-log spoofing via a self-set display name (`db.js:5-7` with `account.js:36-41`), the `guestAccess` setting being dead code so disabling it does not actually revoke guest access (`auth.js:13,92-97`), impersonation tokens lasting 8 hours with no revocation (`auth.js:118-120`), `GET /api/settings` having no capability gate so a GUEST reads the tenant's security posture (`misc.js:660`), worker card ids being able to shadow team badges (`attendance.js:285-292`), subscription coverage extending by 30-day months (drifting ~5 days a year, `misc.js:966`), unbounded in-memory geo/weather caches (`misc.js:141-142`), missing `noopener` on document `window.open`, `URL.revokeObjectURL` called synchronously after `click()` in every export path, `fmtMoney` always using the `en-RW` locale regardless of currency, and unvirtualized attendance tables (a 90-day × 200-worker report renders ~18,000 cells).

---

## What is clean

Worth stating explicitly, because these were checked and held up:

- **No SQL injection.** The only raw query is a parameterless `SELECT 1`; everything else uses Prisma's typed API with no user-built `where` fragments.
- **No mass assignment or prototype pollution.** No route spreads `req.body` into Prisma data; settings merge through an explicit allowlist with type checks.
- **No path traversal in uploads.** Stored names are server-generated; the attacker controls the extension but not the directory.
- **No XSS in the React tree.** No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` anywhere in `web/src`; i18n has no interpolation.
- **Route guards are sound** and derive from server-issued capabilities, not client state. A GUEST cannot reach `/settings` or `/admin` by URL.
- **Money is integer RWF end to end** — no floating-point currency bugs.
- **The snapshot pattern** (`nameSnap`, `unitCostSnap`, `rateSnap`) is applied consistently, so history survives later edits.
- **Camera lifecycles are handled correctly** in both the QR scanner and the kiosk — RAF cancelled, async `getUserMedia` guarded against post-unmount resolution, all tracks stopped.
- **Docker layout is internally consistent:** the web build output, uploads volume, and all port numbers line up across Dockerfile, compose, `.env`, `server.js` and the Vite proxy. Secrets are correctly excluded from the image by `.dockerignore`, and `.gitignore` genuinely excludes `.env` and `uploads/`.
- **Express 5 async handling is correct** — the only unhandled-rejection vector is the fire-and-forget stock alert (H6).

---

## Suggested order of work

1. **Today:** delete the `devToken` branch (C1) and revoke the Gmail app password (H9). Both are minutes of work.
2. **Before production:** authenticate `/uploads` (C2), add an upload type whitelist (C3), fail fast on a missing `JWT_SECRET` (C4), add rate limiting to auth endpoints (H2), upgrade multer (H8).
3. **Next:** close the tenant-isolation gaps (H1, plus the `assigneeId` and project-scope items), mask money server-side on `/api/projects` (H3), and fix the two data-loss-shaped bugs — project delete (H4) and chat pagination (H5).
4. **Then:** the stock race conditions, the wage double-count, and the front-end request races, which all corrupt records rather than merely displaying wrong numbers.
5. **Operational hardening:** migrations instead of `db push`, a non-root database user and container, automated backups, a healthcheck, and a correct `APP_URL`.
