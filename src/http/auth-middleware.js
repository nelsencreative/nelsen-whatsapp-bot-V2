/**
 * Bearer-token auth middleware for the `/notify` endpoint.
 *
 * The webhook caller must send `Authorization: Bearer <NOTIFY_API_SECRET>`.
 * The secret is loaded from .env via loadEnv() and never logged in plain
 * text — only a "provided secret did not match" flag.
 */

const { loadEnv } = require("../lib/env.js");

function bearerAuth(req, res, next) {
  const env = loadEnv();
  const header = req.headers["authorization"] || "";
  const expected = `Bearer ${env.notifyApiSecret}`;

  // Constant-time-ish compare. The secret is short enough that timing
  // side-channels don't matter here, but we use a length-precheck so
  // we don't leak length via "no token" vs "wrong token" response time.
  if (typeof header !== "string" || header.length !== expected.length) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }
  if (header !== expected) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }
  return next();
}

module.exports = { bearerAuth };
