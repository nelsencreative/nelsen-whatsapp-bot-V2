/**
 * Pino logger.
 *
 * Lazy-loaded singleton so we can configure LOG_LEVEL from .env at the
 * first call site (after loadEnv() has run). Subsequent calls return
 * the same root logger; callers use `.child({ mod: "..." })` to tag
 * their module.
 */

const P = require("pino");

let cached = null;

function getLogger() {
  if (cached) return cached;
  let level = process.env.LOG_LEVEL || "info";
  // basebot sets `logger = P({ level: 'silent' })` for its own Baileys
  // instance — don't be confused: that's a separate logger, not ours.
  cached = P({
    level,
    base: { app: "nelsen-notify" },
    timestamp: P.stdTimeFunctions.isoTime,
  });
  return cached;
}

module.exports = { getLogger };
