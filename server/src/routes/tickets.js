import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  listTickets,
  getTicketById,
  createTicket,
  assignTicket,
  deleteTicket,
  listComments,
} from '../services/ticketService.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await listTickets({
      orgId: req.user.orgId,
      page: Number(req.query.page || 1),
      search: req.query.search || '',
      status: req.query.status,
      priority: req.query.priority,
      sortBy: req.query.sortBy || 'created_at',
      order: req.query.order || 'desc',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ticket = await getTicketById(Number(req.params.id), req.user.orgId);
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const comments = await listComments(ticket.id);
    res.json({ ticket, comments });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { subject, body, priority } = req.body;
    if (!subject || !body) {
      return res.status(400).json({ error: 'subject and body are required' });
    }
    const ticket = await createTicket({
      orgId: req.user.orgId,
      subject,
      body,
      priority: priority || 'P3',
      requesterId: req.user.id,
    });
    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
});

// Part 1 fix (finding #3): the README states claiming a ticket is agent/admin
// work, but nothing enforced that — any requester could self-assign any
// ticket. requireRole closes that. Combined with the org filter now inside
// getTicketById/assignTicket, an agent from one org also can no longer claim
// (or even discover the existence of) another org's ticket by guessing an id.
router.patch('/:id/assign', requireAuth, requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const result = await assignTicket(Number(req.params.id), req.user.id, req.user.orgId);
    if (!result) return res.status(404).json({ error: 'Not found' });
    if (result.conflict) {
      return res.status(409).json({ error: 'Ticket already assigned', ticket: result.ticket });
    }
    res.json(result.ticket);
  } catch (err) {
    next(err);
  }
});

// Part 1 fix (finding #3): README states delete is admin-only; nothing
// enforced it. Stacked with the previously-missing org filter (finding #2),
// this used to mean any requester in either organisation could delete any
// ticket belonging to either organisation.
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const ticket = await getTicketById(Number(req.params.id), req.user.orgId);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    await deleteTicket(ticket.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
