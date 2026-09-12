# Part 2 — Decision Notes

The draft spec ("if we have not responded within the target, the ticket is breached")
leaves several things open. Here's what I hit, what I chose, and why.

## 1. What counts as "responded"?

Anyone can comment on a ticket — the customer, an agent, an admin — and any comment can
be marked internal-only. So "responded" could mean: (a) any comment at all, even the
customer's own follow-up; (b) any agent/admin comment, internal or not; or (c) only a
non-internal agent/admin comment — i.e. a reply the customer can actually see.

**Chosen: (c).** The spec's own framing is "have *we* responded" — that's a statement
about support's behaviour towards the customer, not about activity on the ticket in
general. Option (a) would let a customer's own message satisfy their own SLA, which
doesn't measure anything useful. Option (b) would let an internal-only note like
"assigning to Priya" silently stop the clock while the customer is still waiting with
zero visible reply — the exact opposite of what a breach flag is supposed to catch.
Implemented as: earliest comment with `is_internal = 0` from a user whose role is
`agent` or `admin` (`server/src/services/sla.js`).

## 2. Do resolved/closed tickets keep the badge?

A ticket could have missed its first-response target hours ago but be fully resolved
and closed today.

**Chosen: no — badge only shows for open/pending tickets.** The spec says "support needs
to see it," which is a statement about action needed now, not a historical scoreboard.
A closed ticket has nothing left to act on. (A retrospective "how many did we breach
last month" report would be a legitimate, different feature — but it's not what was
asked for here, and I didn't build it.) Implemented as a `CASE WHEN t.status IN
('resolved','closed') THEN 0 ...` at the top of the breach expression, so status always
wins regardless of the underlying timing.

## 3. Business hours vs. pure elapsed time

The targets are "P1 = 4 hours" etc. Nothing in this app has any concept of business
hours, holidays, or working-hours configuration anywhere — no config, no per-org
settings, nothing to build against.

**Chosen: pure elapsed wall-clock time**, exactly as `config.slaTargets` states it in
hours. Introducing a business-hours model would be a real feature addition on top of an
app that has zero infrastructure for it, and risks over-building past what a "should be
quick" feature request calls for. If Product wants business-hours-aware SLAs later,
that's a follow-up ticket with its own scope, not a silent assumption buried in this one.

## 4. Interaction with Part 1 finding #7 (timestamp clock mismatch)

Ticket `created_at` and comment `created_at` can be written under two different clocks
for live-created data (see `REVIEW.md`, finding #7) — a comment can appear to have been
created before its own ticket. I didn't fix the write-time bug (it's not in the Part 1
top five, and this is meant to be a read-only reporting feature, not a data-migration
task). Instead, every elapsed-time calculation in `sla.js` is wrapped in
`GREATEST(..., 0)`, so a negative interval reads as "responded instantly" rather than
producing a nonsensical negative duration or a phantom breach. This is a defensive
clamp, not a real fix — if that clock mismatch is ever corrected upstream, this code
needs no further change, since it degrades gracefully around the bad data in the
meantime.

## 5. Pagination + filtering

Filtering to `breached=true` needed to happen before `LIMIT`/`OFFSET`, or pagination
would report the wrong totals and wrong pages. The breach expression is duplicated in
both the row-selecting query and the `COUNT(*)` query (rather than computed once and
filtered in JS) specifically so the total/page count stay correct with the filter
applied — this is the "don't build something that crashes/lies on the edge case"
consideration.

## 6. A finding from Part 1 that changed how I built Part 2

Building the "breached only" checkbox meant adding it to `TicketList.jsx`'s
data-fetching `useEffect`, whose dependency array only ever listed `[page]` (Part 1,
finding #9 — search/status/priority/sortBy silently did nothing until the page number
also changed). There was no way to make my new filter actually refetch on toggle without
also wiring in the other filters that had the same problem — so this ships fixed as a
side effect of building Part 2 correctly. It was not one of the five findings chosen for
a standalone Part 1 fix; I'm flagging the overlap here rather than letting it look
unaccounted for.

## What I didn't build

No business-hours engine, no retrospective/reporting view for historically-breached
closed tickets, no notification/alerting on breach — none of these were asked for, and
each would be a real scope increase on top of "a red badge and a filter."
