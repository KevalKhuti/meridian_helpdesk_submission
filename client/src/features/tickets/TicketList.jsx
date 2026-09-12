import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { api } from '../../app/api';

const STATUSES = ['', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['', 'P1', 'P2', 'P3'];

export default function TicketList() {
  const user = useSelector((s) => s.auth.user);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [sortBy, setSortBy] = useState('created_at');
  const [breachedOnly, setBreachedOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  // Part 2: this effect used to depend only on [page] (Part 1 finding #9 —
  // changing search/status/priority/sortBy silently did nothing until the
  // page number also changed). The new "breached only" filter needs to
  // actually trigger a refetch when toggled, and there's no honest way to
  // wire that in without also wiring in the filters that were already
  // broken — so this fixes #9 as a side effect of building this feature
  // correctly. See REVIEW.md (#9) and DECISIONS.md.
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page, search, status, priority, sortBy, order: 'desc' });
    if (breachedOnly) params.set('breached', 'true');
    api(`/tickets?${params.toString()}`)
      .then((data) => {
        setRows(data.rows);
        setTotal(data.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, search, status, priority, sortBy, breachedOnly]);

  // Any filter change jumps back to page 1 — otherwise you can land on a
  // "page 3" that no longer exists once the result set shrinks.
  function updateFilter(setter) {
    return (value) => {
      setter(value);
      setPage(1);
    };
  }

  async function handleDelete(id) {
    await api(`/tickets/${id}`, { method: 'DELETE' });
    setRows(rows.filter((r) => r.id !== id));
  }

  const pageCount = Math.ceil(total / 20);

  return (
    <div className="ticket-list">
      <h1>Tickets</h1>

      <div className="filters">
        <input
          placeholder="Search subject…"
          value={search}
          onChange={(e) => updateFilter(setSearch)(e.target.value)}
        />
        <select value={status} onChange={(e) => updateFilter(setStatus)(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s || 'Any status'}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => updateFilter(setPriority)(e.target.value)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p || 'Any priority'}</option>
          ))}
        </select>
        <select value={sortBy} onChange={(e) => updateFilter(setSortBy)(e.target.value)}>
          <option value="created_at">Created</option>
          <option value="updated_at">Updated</option>
          <option value="priority">Priority</option>
          <option value="status">Status</option>
        </select>
        <label className="breach-filter">
          <input
            type="checkbox"
            checked={breachedOnly}
            onChange={(e) => updateFilter(setBreachedOnly)(e.target.checked)}
          />
          Breached only
        </label>
      </div>

      {loading && <p>Loading…</p>}

      <table>
        <thead>
          <tr>
            <th>#</th><th>Subject</th><th>Status</th><th>Priority</th>
            <th>SLA</th><th>Assignee</th><th>Comments</th><th>Created</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i}>
              <td>{t.id}</td>
              <td><Link to={`/tickets/${t.id}`}>{t.subject}</Link></td>
              <td>{t.status}</td>
              <td>{t.priority}</td>
              <td>{t.sla?.breached && <span className="badge-breach">Breached</span>}</td>
              <td>{t.assignee_name || '—'}</td>
              <td>{t.comment_count}</td>
              <td>{new Date(t.created_at).toLocaleString()}</td>
              <td>
                {user?.role === 'admin' && (
                  <button onClick={() => handleDelete(t.id)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pageCount || 1} · {total} tickets</span>
        <button disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
