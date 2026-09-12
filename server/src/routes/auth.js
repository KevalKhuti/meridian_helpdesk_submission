import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const rows = await query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { sub: user.id, orgId: user.org_id, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.org_id },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Completes an emailed invitation. The invite link carries a single-use,
 * expiring token (not a bare user id) — the new joiner proves they hold that
 * link before they can set a password.
 *
 * Part 1 fix (finding #1): the original version trusted a client-supplied
 * userId with no proof of possession of the invite, and wrote the raw
 * password straight into password_hash with no hashing at all. Anyone could
 * "accept" any user's invite — including already-active admins — and lock
 * them out permanently, since a plaintext string can never satisfy
 * bcrypt.compare on the next real login.
 */
router.post('/invite/accept', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'token and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const rows = await query(
      'SELECT id, user_id, expires_at, used_at FROM invites WHERE token = ?',
      [token]
    );
    const invite = rows[0];
    if (!invite) return res.status(400).json({ error: 'Invalid or unknown invite token' });
    if (invite.used_at) return res.status(400).json({ error: 'This invite has already been used' });
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This invite has expired' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Mark the invite used in the same request so a token can never be
    // redeemed twice, even under a race — the WHERE clause only succeeds
    // once per token.
    const result = await query(
      'UPDATE invites SET used_at = NOW() WHERE id = ? AND used_at IS NULL',
      [invite.id]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'This invite has already been used' });
    }

    await query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, invite.user_id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
