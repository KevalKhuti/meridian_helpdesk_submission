import { query } from '../db/pool.js';
import { FIRST_RESPONSE_JOIN_SQL, breachedExprSql, attachSlaState } from './sla.js';

const PAGE_SIZE = 20;

// Part 1 fix (finding #5): sortBy/order used to be interpolated straight from
// req.query into the raw SQL string with no allow-list, so any direct API
// call (not just the UI's own dropdown) could inject arbitrary SQL there.
// Anything not on this list silently falls back to a safe default instead of
// erroring, since an unrecognised sort is a client mistake, not something the
// user needs an error page for.
const SORTABLE_COLUMNS = new Set(['created_at', 'updated_at', 'priority', 'status', 'subject']);

function safeSortColumn(sortBy) {
  return SORTABLE_COLUMNS.has(sortBy) ? sortBy : 'created_at';
}

function safeSortOrder(order) {
  return String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}

/**
 * Paginated ticket list for the current organisation.
 *
 * Supports free-text search on subject, filtering by status and priority,
 * and sorting by any column the UI exposes in its dropdown.
 */
export async function listTickets({ orgId, page = 1, search = '', status, priority, sortBy = 'created_at', order = 'desc', breachedOnly = false }) {
  const where = ['t.org_id = ?'];
  const params = [orgId];

  if (search) {
    where.push('t.subject LIKE ?');
    params.push(`%${search}%`);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    where.push('t.priority = ?');
    params.push(priority);
  }

  const breachedExpr = breachedExprSql();
  if (breachedOnly) {
    where.push(`(${breachedExpr}) = 1`);
  }

  const whereSql = where.join(' AND ');
  const offset = page * PAGE_SIZE;
  const sortColumn = safeSortColumn(sortBy);
  const sortOrder = safeSortOrder(order);

  const rows = await query(
    `SELECT t.id, t.subject, t.status, t.priority, t.created_at, t.updated_at,
            t.assignee_id, u.name AS assignee_name, r.name AS requester_name,
            fr.first_response_at, (${breachedExpr}) AS breached
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
       ${FIRST_RESPONSE_JOIN_SQL}
      WHERE ${whereSql}
      ORDER BY t.${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  // Attach the comment count each row needs for the list badge, and the SLA
  // state for the breach badge (Part 2).
  for (const row of rows) {
    const [{ c }] = await query('SELECT COUNT(*) AS c FROM comments WHERE ticket_id = ?', [row.id]);
    row.comment_count = c;
    attachSlaState(row);
  }

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total
       FROM tickets t
       ${FIRST_RESPONSE_JOIN_SQL}
      WHERE ${whereSql}`,
    params
  );

  return { rows, total, page, pageSize: PAGE_SIZE };
}

/**
 * Part 1 fix (findings #2/#3): this used to have no org_id filter at all, so
 * any authenticated user from either organisation could fetch, assign, or
 * delete any ticket by id, regardless of which company it belonged to. The
 * orgId parameter is optional so internal callers (e.g. right after
 * createTicket inserts a row it already knows the org of) don't need to pass
 * it, but every route handler that takes a ticket id from the URL must pass
 * the caller's orgId here.
 */
export async function getTicketById(id, orgId) {
  const where = ['t.id = ?'];
  const params = [id];
  if (orgId !== undefined) {
    where.push('t.org_id = ?');
    params.push(orgId);
  }

  const breachedExpr = breachedExprSql();
  const rows = await query(
    `SELECT t.*, u.name AS assignee_name, r.name AS requester_name, r.email AS requester_email,
            fr.first_response_at, (${breachedExpr}) AS breached
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
       ${FIRST_RESPONSE_JOIN_SQL}
      WHERE ${where.join(' AND ')}`,
    params
  );
  return rows[0] ? attachSlaState(rows[0]) : null;
}

export async function listComments(ticketId) {
  return query(
    `SELECT c.id, c.body, c.is_internal, c.created_at, u.name AS author_name, u.role AS author_role
       FROM comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = ?
      ORDER BY c.created_at ASC`,
    [ticketId]
  );
}

export async function createTicket({ orgId, subject, body, priority, requesterId }) {
  const result = await query(
    `INSERT INTO tickets (org_id, subject, body, priority, requester_id)
     VALUES (?, ?, ?, ?, ?)`,
    [orgId, subject, body, priority, requesterId]
  );
  return getTicketById(result.insertId);
}

export async function assignTicket(ticketId, assigneeId, orgId) {
  const ticket = await getTicketById(ticketId, orgId);
  if (!ticket) return null;

  if (ticket.assignee_id) {
    return { conflict: true, ticket };
  }

  // Look up the agent so the response carries a display name for the toast.
  const [agent] = await query('SELECT id, name FROM users WHERE id = ?', [assigneeId]);

  await query('UPDATE tickets SET assignee_id = ?, status = ? WHERE id = ?', [assigneeId, 'pending', ticketId]);
  return { conflict: false, assignedTo: agent, ticket: await getTicketById(ticketId, orgId) };
}

export async function deleteTicket(id) {
  await query('DELETE FROM tickets WHERE id = ?', [id]);
}
