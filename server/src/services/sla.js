import { config } from '../config.js';

/**
 * Part 2 — SLA breach tracking.
 *
 * Spec gaps this resolves (see DECISIONS.md for the full reasoning):
 *
 *   1. "Responded" means the first comment from an agent or admin that is
 *      NOT marked internal — i.e. the first reply the customer can actually
 *      see. A requester's own follow-up doesn't stop the clock, and neither
 *      does an internal-only staff note.
 *   2. A ticket can only show as breached while it's still open or pending.
 *      Once resolved/closed, the badge disappears even if it historically
 *      missed its target.
 *   3. Targets are pure elapsed wall-clock time (P1=4h, P2=24h, P3=72h from
 *      server/src/config.js). There's no business-hours concept anywhere
 *      else in this app, so adding one here would be a feature, not a bug
 *      fix — out of scope.
 *
 * Finding #7 from Part 1 (ticket vs. comment timestamps can be recorded
 * under different clocks for live-created data) directly threatens this
 * math: a comment can appear to have been created before its own ticket.
 * Rather than "fixing" that here (it's not in the Part 1 top five, and
 * changing write-time behaviour is out of scope for a read-only feature),
 * every elapsed-time calculation below is clamped to zero seconds. A
 * ticket can therefore never appear to have been answered "before it was
 * even created" — worst case, a skewed pair reads as an instant response,
 * which is the safe direction for a false positive/negative to fail in
 * (nobody sees a phantom breach because of it).
 */

// Built from our own server-side config, never from request input, so this
// is safe to inline directly into SQL rather than parameterise.
function slaTargetSecondsCaseSql() {
  const cases = Object.entries(config.slaTargets)
    .map(([priority, hours]) => `WHEN '${priority}' THEN ${Math.round(hours * 3600)}`)
    .join(' ');
  return `CASE t.priority ${cases} END`;
}

/**
 * Subquery joined onto `tickets t` as `fr`, giving each ticket row a
 * `first_response_at` column: the earliest non-internal comment from an
 * agent or admin, or NULL if no one has replied to the customer yet.
 */
export const FIRST_RESPONSE_JOIN_SQL = `
  LEFT JOIN (
    SELECT c.ticket_id, MIN(c.created_at) AS first_response_at
      FROM comments c
      JOIN users cu ON cu.id = c.author_id
     WHERE c.is_internal = 0 AND cu.role IN ('agent', 'admin')
     GROUP BY c.ticket_id
  ) fr ON fr.ticket_id = t.id
`;

/**
 * SQL boolean (0/1) expression for whether a ticket is currently breached.
 * Requires the FIRST_RESPONSE_JOIN_SQL join to be present in the same query
 * (for fr.first_response_at) and clamps negative elapsed time to zero with
 * GREATEST(), per the finding #7 note above.
 */
export function breachedExprSql() {
  const targetSeconds = slaTargetSecondsCaseSql();
  return `
    CASE
      WHEN t.status IN ('resolved', 'closed') THEN 0
      WHEN fr.first_response_at IS NOT NULL THEN
        IF(GREATEST(TIMESTAMPDIFF(SECOND, t.created_at, fr.first_response_at), 0) > (${targetSeconds}), 1, 0)
      ELSE
        IF(GREATEST(TIMESTAMPDIFF(SECOND, t.created_at, NOW()), 0) > (${targetSeconds}), 1, 0)
    END
  `;
}

/**
 * Shapes the raw columns pulled back by FIRST_RESPONSE_JOIN_SQL +
 * breachedExprSql() into a clean `sla` object, and removes the raw columns
 * from the row so callers get one tidy nested field instead of loose
 * first_response_at/breached columns.
 */
export function attachSlaState(row) {
  const targetHours = config.slaTargets[row.priority] ?? null;
  const breached = Boolean(row.breached);
  const firstRespondedAt = row.first_response_at || null;
  delete row.first_response_at;
  delete row.breached;
  row.sla = {
    targetHours,
    firstRespondedAt,
    breached,
  };
  return row;
}
