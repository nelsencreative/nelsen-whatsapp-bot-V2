/**
 * Express HTTP API for the notification bot.
 *
 * Routes:
 *   GET  /health   → 200, used by UptimeRobot to keep the host alive.
 *   POST /notify   → Bearer-protected; dispatches the WhatsApp send
 *                    based on `body.type`. Accepts multiple shapes:
 *                    - our internal `{type:"new_order", record:{…}}`
 *                    - Supabase webhook default
 *                      `{type:"INSERT", table:"orders", record:{…}}`
 *                    - Vercel native
 *                      `{type:"deployment.succeeded", data:{…}}`
 *
 * The actual notification logic lives in `../messages/dispatcher.js`
 * so the realtime listener can reuse it verbatim.
 *
 * The `sock` (Baileys WASocket) is passed in by the caller so this
 * module never reaches into globals — it stays testable.
 */

const express = require("express");

const { bearerAuth } = require("./auth-middleware.js");
const { getLogger } = require("../lib/logger.js");
const { loadEnv } = require("../lib/env.js");
const { dispatchNotification } = require("../messages/dispatcher.js");

const log = getLogger().child({ mod: "http" });

/**
 * Build the express app. Exported as a factory so `index.js` can mount
 * it on any port and we can also reuse it for local tests.
 *
 * @param {WASocket} sock  — the live Baileys socket. The dispatcher
 *   uses this to call `sendMessage`. It is captured via a getter so
 *   that a reconnect (which replaces `global.conns[instanceKey]` with
 *   a new Hanz instance) is reflected automatically.
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
  // POST /notify — Bearer-authenticated dispatch.
  //
  // Log every incoming POST (auth'd or not) so we can prove from the
  // bot logs whether inbound webhooks are actually reaching us.
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
      const result = await dispatchNotification(sock, body);
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
 * Start the HTTP server on the configured PORT.
 *
 * Idempotent: returns the existing instance if already started (guarded
 * by `global.botHttpStarted`). The caller (`index.js`) invokes this on
 * every reconnect but only the first call mounts the listener.
 *
 * @param {WASocket} sock  — live Baileys socket to wire into /notify.
 * @returns {http.Server | null}  — the server instance, or null if
 *   loadEnv() failed.
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
    log.info({ port: env.port }, "HTTP server listening (GET /health, POST /notify)");
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
