# Second system audit — Bridge CMS

Date: 2026-08-03. Follows [AUDIT.md](AUDIT.md) (first pass) and
[AUDIT-FIXES.md](AUDIT-FIXES.md) (remediation).

This pass focuses on **the code written during remediation**, which is the
newest and least-reviewed in the system — my own work, so I tested it against a
running instance rather than reading it and pronouncing it fine. Two throwaway
tenants and a 20,000-record dataset were created for the tests and removed
afterwards.

**Verdict: the first-pass findings are genuinely closed, and no new
tenant-isolation or authentication hole was introduced. But the remediation
added three defects of its own, and it made an existing performance problem
materially worse — 1.6 seconds per page for one site with one year of
attendance.**

---

## Confirmed still fixed (re-tested, not assumed)

| First-pass finding | Re-test |
|---|---|
| Reset token in `/forgot` response | absent; returns `{ok, emailed}` only |
| `/uploads` unauthenticated | 401 without credentials |
| Cross-tenant file read | tenant B → tenant A's private file = **404** |
| Cross-tenant API access | delete/patch A's project & phase as B = **404** |
| Upload type filter | `evil.html` refused; PNG accepted |
| IDOR by raw `:id` | every raw-id lookup that remains is behind `superOnly` |
| Money masking | Site Engineer sees `budget:null`, admin sees figures |
| Login brute force | 10 attempts then 429, per IP+email |

---

## New defects introduced by the remediation

### N1 — Sticky negative cache in the uploads handler (Medium)
`api/src/uploads.js` — `locate()` caches "no owner found" permanently
(`cacheOwner(name, null)`), and the cache only clears at 5,000 entries.

**Reproduced:** requested a filename before its `Document` row existed → 404;
inserted the row; requested again → **still 404**. That file is unreachable for
the life of the process.

Two ways this bites. Innocently: `POST /api/docs` writes files to disk *before*
inserting rows, so a request landing in that window poisons the entry. As an
attack: filenames are `Date.now()-random(1e6)`, and the timestamp half is
predictable, so an attacker can spray a millisecond range to make future uploads
permanently 404 — a quiet denial of service on file availability.

**Fix:** don't cache misses, or cache them with a short TTL.

### N2 — Store-scoped managers can accept returns for other stores' stock (Low)
`api/src/routes/stock.js` — `POST /stock/returns` never calls
`managedStoreIds()`, while `POST /stock/issues` does
(`storeId: { in: managedIssue }`) and so does `GET /stock/outstanding/:cardId`.
A manager assigned to one store can therefore hand back — and increment — an
item belonging to a different store. The returns feature is mine; the omission
is an inconsistency with its own sibling endpoint.

### N3 — `/forgot` rate limit is per IP only, so one attacker locks out everyone (Medium)
`api/src/rateLimit.js` + `api/src/routes/auth.js` — login is keyed on IP **and**
email, but `/forgot` is IP-only.

**Reproduced:** six requests for a nonsense address exhausted the bucket, and a
legitimate user's own reset then returned *"Too many attempts - wait 60
minutes"*. Behind NAT, a corporate network, or a reverse proxy without
`TRUST_PROXY=1`, every user shares one bucket and one actor disables password
reset for the whole deployment.

**Fix:** key it on IP+email like login, and keep a looser per-IP ceiling on top.

---

## Made worse by the remediation

### W1 — Wage pages now load the account's entire attendance history (High, performance)
Fixing the wage double-count required de-duplicating per worker per day across
the whole account, so `wagesForProjects` and the reports hub now load **every
attendance session for the client** on every call, not just the filtered
projects. The correctness fix is right; the cost is real.

**Measured** on one tenant, one project, 250 sessions × 80 workers = 20,000
attendance records (about a year of a single site):

| Endpoint | Time | Payload |
|---|---|---|
| `GET /api/projects` | **1.65 s** | 512 bytes |
| `GET /api/dashboard` | **1.55 s** | 285 bytes |
| `GET /api/reports` | **1.66 s** | 8 KB |

Note the payloads: hundreds of bytes returned for ~1.6 s of work. It is all
scan-and-discard, and it grows linearly with account age. Five sites and three
years puts these pages into tens of seconds. `GET /api/projects` additionally
still includes every daily update with all media for every phase (first-pass
finding M8, never fixed).

**Fix:** aggregate wages in SQL with a date filter, or precompute a per-worker
per-day wage table, rather than loading raw records into Node.

---

## Pre-existing, still open

- **25 MB of orphaned uploads** — 17 files that no `Document` or `Media` row
  references. They predate this work and are now unreachable (the new handler
  can't resolve an owner, so they 401), but nothing reaps them and nothing
  reaps future orphans either. A periodic sweep comparing disk against the DB
  is missing.
- **Logout is client-side only.** Verified: a captured `bridge_session` cookie
  keeps working after `/auth/logout` until it expires (≤30 min). This is
  inherent to stateless JWTs and equally true of the bearer token, but the
  cookie I added widens where a token can leak from (proxy logs, disk caches).
  Real revocation needs a token version or a server-side session store.
- **Audit-log author is free text.** `AuditLog.userName` is a snapshot of a
  name the user can change, so entries can still be attributed to a colleague.
- **Reset links carry the token in the URL**, so they land in browser history
  and messaging-app link previews.
- **Video calls** use a public Jitsi instance with guessable room names.
- **Company deletion has no built-in backup step** and scales linearly —
  measured **1.8 s** to erase a tenant with 12,000 attendance records; a much
  larger tenant will hold locks for a long time in one transaction.
- **Migration baselining assumes the existing schema matches `0_init`.** If a
  deployment's schema had drifted, `migrate.js` marks the baseline applied and
  the mismatch goes unnoticed until a later migration fails.
- **In-memory rate limiter and upload cache** are per-process, so both break if
  the API is ever run as more than one instance.
- **Still no automated tests.** Everything above — including the fixes from the
  first pass — is verified by hand and by me. Nothing prevents a regression.

---

## Recommended order

1. **N1** (sticky negative cache) and **N3** (reset lockout) — both small, both
   mine, both reachable by an unauthenticated or low-privilege actor.
2. **W1** — the pages people use every day take 1.6 s on a modest dataset and
   degrade from there. This is the thing users will feel first.
3. **N2**, orphan reaper, backup-before-delete.
4. A regression suite around auth, tenant isolation, and the wage/stock
   arithmetic, so the next change cannot silently undo any of this.

---

## Note on the environment

The database now holds **no companies and one Super Admin** (your account,
`SUPER` role) — the platform's correct production posture. The demo company was
deleted at 23:20 on 2026-08-02 by "Super Admin", recorded in `DeletedClient`;
the second record is my own throwaway test tenant from building that feature.
All audit test data created for this pass has been removed.
