// Audit log: persistent record of security-relevant events.
//
// Design rules:
//  1. Writes are best-effort — a failed insert MUST NOT break the user-facing
//     request. We swallow errors and console.error them.
//  2. Never log raw passwords, tokens, full session JWTs, or full request
//     bodies. Only identifiers and event-shape metadata.
//  3. Truncate user_agent at 300 chars (matches the interest_clicks pattern)
//     to prevent unbounded log bloat.
//
// Event types currently in use:
//   - login_success / login_failure
//   - register_success
//   - password_reset_requested / password_reset_completed
//   - email_verified
//   - admin_ban_toggle / admin_role_toggle / admin_balance_adjust
//   - admin_invite_create / admin_invite_revoke
//
// Add more by calling logEvent({ eventType: 'some_new_event', ... }).

import pool from '../database/postgres.js';

export async function logEvent({
  eventType,
  actorUserId = null,
  targetUserId = null,
  ip = null,
  userAgent = null,
  metadata = null,
}) {
  try {
    await pool.query(
      `INSERT INTO audit_log (event_type, actor_user_id, target_user_id, ip, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(eventType).slice(0, 64),
        actorUserId,
        targetUserId,
        ip ? String(ip).slice(0, 64) : null,
        userAgent ? String(userAgent).slice(0, 300) : null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
  } catch (e) {
    // Swallow: audit logging must never break the actual request.
    console.error('[audit_log] insert failed:', e.message);
  }
}

// Convenience: capture caller info from an Express request without leaking
// passwords or tokens. Use in handlers as logEvent({ ...reqInfo(req), eventType, ... }).
export function reqInfo(req) {
  return {
    ip: req.ip || null,
    userAgent: req.headers?.['user-agent'] || null,
  };
}
