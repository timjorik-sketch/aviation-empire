// Rate limiting (security audit C3, H6).
//
// Limiters key off req.ip. The server already calls app.set('trust proxy', 1)
// so req.ip reflects the real client behind Railway's reverse proxy — without
// that, every request would appear to come from the same proxy IP and one
// abusive user would lock everyone out.
//
// In-memory store. Multiple Railway instances would each track their own
// counts; that's acceptable for current scale. If we ever scale horizontally,
// swap in a shared store (rate-limit-redis).

import rateLimit from 'express-rate-limit';

// Generic ceiling for any caller. Generous enough that real users never hit it,
// tight enough to slow down scrapers and abusive bots.
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Brute-force window for credential / token endpoints.
// Skip successful requests so legitimate users aren't punished for typing
// their password right.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts, please try again in a few minutes.' },
});

// Public interest-counter endpoint. Already does IP-based dedup over 24h, but
// without a request limit anyone can grind through proxies to inflate the
// count. Tight per-IP cap stops casual abuse.
export const interestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});
