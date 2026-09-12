# Part 1 — Code Review

Reviewed as though this were a PR from a colleague. Findings are ranked most → least
important; the top five (marked **[FIXED]**) are implemented in this repo, isolated from
the Part 2 feature work by separate commits (`git log` shows the split cleanly).

## Ranking

1. **[FIXED]** Unauthenticated, unhashed invite/accept endpoint — critical account takeover / permanent lockout
2. **[FIXED]** Cross-tenant data leak on `GET /api/tickets/:id` — critical, breaks the one hard rule in the README
3. **[FIXED]** Missing role checks on delete and assign — critical, compounds with #2
4. **[FIXED]** Stored XSS in ticket comments — critical, session-theft path
5. **[FIXED]** `sortBy`/`order` interpolated into raw SQL — high, SQL injection surface
6. Pagination off by one page on every request — high, functional, documented only
7. Ticket vs. comment timestamps recorded on two different clocks — high, documented only, worked around in Part 2
8. Internal-only comments visible to the ticket's own customer — medium-high, documented only
9. List filters silently don't refetch until the page number also changes — medium, documented only (see note in DECISIONS.md — building the Part 2 filter control required touching this same code)
10. Secrets committed / weak fallback JWT secret — medium, documented only

Findings #2 and #3 are related (missing org filter + missing role checks compound each
other) but are listed and fixed separately since they're different bugs in different
mechanisms.

---

## 1. Unauthenticated invite/accept stores passwords in plaintext — CRITICAL — [FIXED]

**Where:** `server/src/routes/auth.js`, `POST /invite/accept` (was lines 42–54)

**What's wrong:** The route took `{ userId, password }` straight from the request body
with no auth check and no proof the caller was the invited person. It then ran
`UPDATE users SET password_hash = ?` with the *raw* password — never hashed.

**Why it matters here:** Anyone, unauthenticated, can loop through sequential user ids
and call this endpoint. Two things happen: (1) they've now "set" that user's password to
whatever they chose, and (2) even the legitimate account owner is permanently locked
out, because the stored value is no longer a bcrypt hash — `bcrypt.compare` can't parse
a plain string and always returns `false`, so *no* password will ever work again,
including the original one. This is a mass, permanent, unauthenticated account-lockout
and takeover primitive reachable against every user in the system, including admins.
There is no invite link anywhere in the client UI, so this can only be found by reading
the server code — this is the "not observable from the UI" bug the brief mentions.

**Fix:** Added an `invites` table (single-use token, expiry, `used_at`). The endpoint
now takes `{ token, password }`, looks up the invite by token, rejects unknown/expired/
already-used tokens, atomically marks the token used (`UPDATE ... WHERE used_at IS
NULL`, so a race can't redeem it twice), and hashes the password with bcrypt before
writing it. Seed data includes one pending invite (`newhire@northwind.test`) so the flow
is demonstrable after `npm run db:reset` — the token is printed to the console by the
seed script.

---

## 2. Cross-tenant data leak on ticket lookup — CRITICAL — [FIXED]

**Where:** `server/src/services/ticketService.js`, `getTicketById` (was lines 57–67);
consumed by `server/src/routes/tickets.js` (`GET /:id`, was lines 31–41)

**What's wrong:** `getTicketById` had no `org_id` filter — it fetched a ticket purely by
numeric id, regardless of who was asking.

**Why it matters here:** Any authenticated user from Northwind Trading could fetch a
Cobalt Logistics ticket (or vice versa) just by guessing/incrementing the id in the URL,
getting back the full ticket body plus the requester's name and email. This breaks the
one explicit hard rule in the README ("must not be able to see each other's tickets").
`comments.js` already checks `ticket.org_id !== req.user.orgId` on the equivalent path
for posting a comment, so this was an inconsistency/oversight in `ticketService.js`, not
an intentional design choice.

**Fix:** `getTicketById(id, orgId)` now takes an optional `orgId` and adds
`AND t.org_id = ?` to the query when it's supplied. Every route handler that takes a
ticket id from the URL (`GET /:id`, `PATCH /:id/assign`, `DELETE /:id`) now passes
`req.user.orgId`. `createTicket`'s internal lookup of its own just-inserted row doesn't
need it (there's no cross-org risk fetching a row you just created).

---

## 3. No role checks on delete and assign — CRITICAL — [FIXED]

**Where:** `server/src/routes/tickets.js`, `DELETE /:id` and `PATCH /:id/assign` (were
lines 62–84)

**What's wrong:** The README states delete is admin-only and claiming is agent/admin
work, but neither route called `requireRole` — `requireAuth` alone was the only guard.

**Why it matters here:** Any logged-in `requester` — the lowest-privilege role — could
delete any ticket or self-assign any unclaimed one. Stacked with finding #2 (no org
filter), this meant a requester in *either* organisation could delete or claim *any*
ticket belonging to *either* organisation, not just their own.

**Fix:** Added `requireRole('admin')` to the delete route and `requireRole('agent',
'admin')` to the assign route, alongside the org-scoping fix from #2 on the same routes.

---

## 4. Stored XSS in ticket comments — CRITICAL — [FIXED]

**Where:** `client/src/features/tickets/TicketDetail.jsx`, comment rendering (was line 65)

**What's wrong:** Comment `body` was rendered via
`dangerouslySetInnerHTML={{ __html: c.body }}` with no sanitisation.

**Why it matters here:** Any user who can post a comment — including a plain requester —
can inject a `<script>` that runs in the browser of every other person who later opens
that ticket, including agents and admins. The JWT is stored in `localStorage`
(`client/src/app/store.js`), so this is a direct session-theft path, not just a cosmetic
issue.

**Fix:** Comments are plain text, not markup — there was never a legitimate reason to
render them as HTML. Replaced with `<div className="comment-body">{c.body}</div>`, which
React escapes by default. No sanitiser dependency needed since no real HTML feature is
lost.

---

## 5. `sortBy`/`order` interpolated directly into raw SQL — HIGH — [FIXED]

**Where:** `server/src/services/ticketService.js` (was line 38), values sourced
unsanitised from `req.query` in `server/src/routes/tickets.js` (was lines 22–23)

**What's wrong:** No allow-list on the column name or sort direction before they were
spliced into the `ORDER BY` clause.

**Why it matters here:** The UI's own dropdown only ever sends safe values, so this is
invisible through normal use — but any direct API call can send arbitrary strings into
`ORDER BY t.${sortBy} ${order}`. This is a SQL injection surface, and (per the brief)
exactly the kind of thing that isn't reachable by clicking through the app.

**Fix:** Added an allow-list (`created_at`, `updated_at`, `priority`, `status`,
`subject`) and a strict `asc`/`desc` check; anything else falls back to the safe default
(`created_at DESC`) rather than erroring.

---

## 6. Pagination is off by one page on every request — HIGH — documented only

**Where:** `server/src/services/ticketService.js` — `offset = page * PAGE_SIZE` should
be `(page - 1) * PAGE_SIZE`.

**What's wrong:** Page 1 requests `OFFSET 20`, so it actually returns what should be
page 2's rows.

**Why it matters here:** 100% reproducible on every list view, for every user — the 20
most-recently-created tickets are never returned on any page. It's a real, visible bug,
but it's confined to the list endpoint and doesn't compromise data, so it ranks below
the security findings above.

**How I'd fix it:** `const offset = (page - 1) * PAGE_SIZE;` — a one-line change, but
outside the top five, so left untouched per the brief.

---

## 7. Ticket and comment timestamps recorded on two different clocks — HIGH — documented only

**Where:** `server/src/services/ticketService.js` (`createTicket` relies on the
`created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` column default) vs.
`server/src/routes/comments.js` (`new Date().toISOString().slice(0, 19)`, explicit UTC)

**What's wrong:** `docker-compose.yml` starts MySQL with `--default-time-zone=+05:30`,
so `CURRENT_TIMESTAMP` at ticket-insert time is IST wall-clock. `comments.js` instead
computes the value itself in Node as a UTC ISO string and writes that literal string
into the same `DATETIME` column type (which has no timezone attached — MySQL just
stores whatever wall-clock string it's given). A ticket and a comment created back to
back can end up 5.5 hours apart in the stored data, in either direction.

**Why it matters here:** This only affects *live* writes through the running app — the
seed script computes both `tickets.created_at` and `comments.created_at` the same way
(via the same JS `toISOString()` helper), so seed data is internally consistent. But any
ticket or comment created during a real demo session can produce a first-response
interval that's wrong by 5.5 hours, including negative. That's a direct threat to the
Part 2 SLA feature — see `DECISIONS.md`.

**How I'd fix it:** Stop relying on the DB's `CURRENT_TIMESTAMP` for `tickets.created_at`
and stamp it explicitly in the same way `comments.js` already does, so both columns are
always populated by the same code path and the same clock. Left untouched here since
it's not in the top five, but Part 2's SLA math is written defensively around it
(elapsed time is clamped to zero rather than allowed to go negative).

---

## 8. Internal-only comments are visible to the ticket's own customer — MEDIUM-HIGH — documented only

**Where:** `server/src/services/ticketService.js`, `listComments` returns every comment
regardless of the caller's role; the client (`TicketDetail.jsx`) only adds an
`internal` CSS class for styling — it doesn't hide anything.

**What's wrong:** A ticket's own requester can see comments marked internal-only, which
are meant for staff eyes only (e.g. internal handoff notes, in `agents' language about
the customer`).

**Why it matters here:** This is a confidentiality bug, not a system-compromise one —
still real, since staff may write things in an internal note they would not want the
customer to see. It's the same "is this comment visible to the customer" distinction
Part 2 relies on for its response-time definition (see `DECISIONS.md`, question 1).

**How I'd fix it:** Filter `listComments` (or the route) so a caller with role
`requester` never receives rows where `is_internal = 1`. Left untouched — not in the top
five.

---

## 9. List filters silently do nothing until the page also changes — MEDIUM — see note below

**Where:** `client/src/features/tickets/TicketList.jsx` — the data-fetching
`useEffect` originally depended only on `[page]`.

**What's wrong:** Changing search, status, priority, or sort doesn't trigger a refetch
until the page number *also* changes, so the UI looks broken (you type a search term,
nothing happens).

**Why it matters here:** Visibly broken, no data-integrity risk — ranks below the
confidentiality issue above.

**Note:** Building the Part 2 "breached only" filter control required adding it (and,
to make it actually work, the other existing filters) to that same `useEffect`'s
dependency array. That incidentally fixes this bug as a side effect of building the new
feature correctly — it was not one of the five findings chosen for a standalone fix, and
no other change was made to work around or disguise it. See `DECISIONS.md`.

---

## 10. Secrets committed to the repo / weak fallback JWT secret — MEDIUM — documented only

**Where:** `.gitignore` (does not exclude `server/.env`, which contains a real DB
password and JWT secret); `server/src/config.js` (`jwtSecret` silently falls back to the
hardcoded string `'dev-secret-change-me'` if the env var is missing)

**What's wrong:** Two separate issues bundled together since they're both secrets
hygiene: real credentials are trivially committable by accident, and a missing
`JWT_SECRET` env var degrades silently to a well-known default instead of failing
loudly.

**Why it matters here:** If `.env` is ever committed (easy to do without a `.gitignore`
entry), the DB password and JWT signing secret leak with it — and the JWT secret leaking
means anyone can forge valid tokens for any user/role. The silent fallback also means a
misconfigured deployment (env var typo'd or unset) doesn't fail fast — it just quietly
runs with a secret anyone can find in the source.

**How I'd fix it:** Add `server/.env` to `.gitignore`; have `config.js` throw at startup
if `JWT_SECRET` is unset in any environment other than a clearly-marked local-dev mode,
rather than defaulting silently. Left untouched — not in the top five, and only
findable by reading, not by using the app (the second "not observable from the UI"
instance, alongside #1).
