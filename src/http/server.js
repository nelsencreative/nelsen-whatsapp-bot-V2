/**
 * Express HTTP API for the notification bot.
 *
 * Routes:
 *   GET  /health          → 200, used by UptimeRobot to keep the host alive.
 *   POST /notify          → Bearer-protected; dispatches the WhatsApp send.
 *   GET  /backup-session  → Bearer-protected; returns fresh `creds.json` as Base64 string.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const { bearerAuth } = require("./auth-middleware.js");
const { getLogger } = require("../lib/logger.js");
const { loadEnv } = require("../lib/env.js");
const { dispatchNotification } = require("../messages/dispatcher.js");
const config = require("../config.js");

const log = getLogger().child({ mod: "http" });

/**
 * Build the express app. Exported as a factory so `index.js` can mount
 * it on any port and we can also reuse it for local tests.
 *
 * @param {WASocket} sock  — the live Baileys socket.
 * @returns {express.Express}
 */
function buildApp(sock) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));

  // ---------------------------------------------------------------------
  // GET /health — UptimeRobot keeps the host alive via this.
  // ---------------------------------------------------------------------
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, uptime: process.uptime() });
  });

  // ---------------------------------------------------------------------
  // GET /backup-session — Bearer-protected session backup endpoint.
  // Returns current `creds.json` encoded as Base64 for easy restore.
  // ---------------------------------------------------------------------
  app.get("/backup-session", bearerAuth, (_req, res) => {
    try {
      const authFolder = config.authFolder || path.join(__dirname, "../database/session");
      const credsPath = path.join(authFolder, "creds.json");

      if (!fs.existsSync(credsPath)) {
        log.warn({ credsPath }, "Backup session requested but creds.json not found");
        return res.status(404).json({ ok: false, reason: "creds.json not found" });
      }

      const credsData = fs.readFileSync(credsPath, "utf-8");
      const base64Session = Buffer.from(credsData).toString("base64");

      log.info("GET /backup-session successfully generated fresh session base64");
      return res.status(200).json({
        ok: true,
        session_base64: base64Session,
      });
    } catch (e) {
      log.error({ err: e?.message || String(e) }, "GET /backup-session failed");
      return res.status(500).json({ ok: false, reason: e?.message || "Internal server error" });
    }
  });

  // ---------------------------------------------------------------------
  // POST /notify — Bearer-authenticated dispatch.
  // ---------------------------------------------------------------------
  app.post(
    "/notify",
    (req, _res, next) => {
      const t = req.body?.type;
      log.info(
        {
          method: req.method,
          path: req.path,
          ip: req.ip,
          ua: req.headers["user-agent"],
          type: typeof t === "string" ? t : null,
        },
        "POST /notify received",
      );
      next();
    },
    bearerAuth,
    async (req, res) => {
      const body = req.body ?? {};
      const result = await dispatchNotification(resolveLiveSocket(sock), body);
      res.status(result.ok ? 200 : 502).json({
        ok: result.ok,
        type: result.type,
        ...(result.ok ? {} : { reason: result.reason }),
      });
    },
  );

  return app;
}

/**
 * Resolve the currently-connected WASocket.
 */
function resolveLiveSocket(fallback) {
  try {
    const live = global?.conns?.session;
    if (live && typeof live.relayMessage === "function") return live;
  } catch (e) {
    // ignore — fall through to fallback
  }
  return fallback || null;
}

/**
 * Start the HTTP server on the configured PORT.
 */
function startHttpServer(sock) {
  if (global.botHttpStarted) {
    log.debug("HTTP server already started — skipping re-init.");
    return global.botHttpServer;
  }

  let env;
  try {
    env = loadEnv();
  } catch (e) {
    log.error({ err: e?.message || String(e) }, "loadEnv failed; HTTP server not started");
    return null;
  }

  const app = buildApp(sock);
  const server = app.listen(env.port, () => {
    log.info({ port: env.port }, "HTTP server listening (GET /health, POST /notify, GET /backup-session)");
  });

  global.botHttpStarted = true;
  global.botHttpServer = server;
  return server;
}

/**
 * Stop the HTTP server. Called on graceful shutdown.
 */
function stopHttpServer() {
  if (!global.botHttpStarted || !global.botHttpServer) return;
  const server = global.botHttpServer;
  global.botHttpStarted = false;
  global.botHttpServer = null;
  server.close((err) => {
    if (err) {
      log.warn({ err: err.message }, "HTTP server close error");
    }
  });
}

module.exports = { buildApp, startHttpServer, stopHttpServer };
      
