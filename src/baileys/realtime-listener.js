/**
 * Supabase Realtime listener for `orders` and `invoices` INSERTs.
 *
 * Why this exists: the bot can run inside a Pterodactyl container whose
 * inbound network port is not reachable from the public internet (the
 * owner's Cloudflare proxy does not forward arbitrary ports like 2576).
 * That means **no Supabase Database Webhook** can POST to the bot's
 * `/notify` endpoint — the connection just times out.
 *
 * To stay decoupled from inbound network reachability, the bot opens
 * an **outbound** WebSocket connection to Supabase Realtime and
 * subscribes to INSERT events on the two tables we care about. That
 * socket travels through the same egress path that other outbound
 * traffic (Supabase REST, etc.) already uses, so it works regardless
 * of the host's inbound firewall rules.
 *
 * The bot uses its **service-role** key for this subscription. Per the
 * Supabase docs, the service role bypasses RLS on `postgres_changes`
 * events, so every INSERT to `public.orders` / `public.invoices`
 * delivers here — including inserts from authenticated users running
 * the `cart_checkout` / `cart_apply_promo` RPC.
 *
 * Caveat: a connection drop causes Supabase to silently miss events
 * delivered during the gap. We log a noisy warning when the channel
 * status changes; for production safety, this should be paired with
 * the HTTP webhook path as a redundant fan-out (idempotency-checked
 * via the order/invoice id).
 */

const { getLogger } = require("../lib/logger.js");
const { getSupabase } = require("../lib/supabase.js");
const { dispatchNotification } = require("../messages/dispatcher.js");

const log = getLogger().child({ mod: "realtime" });

let channel = null;

/**
 * Start the realtime listener.
 *
 * Idempotent: returns silently if already started. The caller (`index.js`)
 * invokes this on every reconnect but only the first call subscribes.
 *
 * @param {WASocket} sock  — live Baileys socket to dispatch messages to.
 */
function startRealtimeListener(sock) {
  if (channel) {
    log.warn("Realtime listener already started — skipping re-init.");
    return;
  }

  const sb = getSupabase();

  // We subscribe to BOTH tables on a single channel — Supabase Realtime
  // supports multiple `.on(...)` listeners on the same channel name and
  // shares one WebSocket connection across them, which is what we want
  // (a single egress socket, not two).
  const ch = sb
    .channel("nelsen-bot-notifications")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "orders" },
      (payload) => {
        const id = payload?.new?.id;
        log.info({ table: "orders", id }, "Realtime orders INSERT");
        const body = {
          eventType: "INSERT",
          table: "orders",
          new: payload.new,
        };
        void dispatchNotification(sock, body);
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "invoices" },
      (payload) => {
        const id = payload?.new?.id;
        log.info({ table: "invoices", id }, "Realtime invoices INSERT");
        const body = {
          eventType: "INSERT",
          table: "invoices",
          new: payload.new,
        };
        void dispatchNotification(sock, body);
      },
    );

  ch.subscribe((status, err) => {
    if (err) {
      log.error(
        { status, err: err?.message || String(err) },
        "Realtime subscribe error",
      );
      return;
    }
    if (status === "SUBSCRIBED") {
      log.info(
        { tables: ["orders", "invoices"] },
        "✅ Subscribed to Supabase Realtime — waiting for INSERT events.",
      );
    } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
      log.warn(
        { status },
        "Realtime channel closed/errored — events will be missed until reconnected.",
      );
    } else {
      // TIMED_OUT / CONNECTING — informational.
      log.info({ status }, "Realtime channel state change");
    }
  });

  channel = ch;
}

/**
 * Unsubscribe the realtime channel. Called from graceful shutdown.
 */
async function stopRealtimeListener() {
  if (!channel) return;
  const sb = getSupabase();
  const ch = channel;
  channel = null;
  try {
    await sb.removeChannel(ch);
    log.info("Realtime listener stopped.");
  } catch (e) {
    log.warn(
      { err: e?.message || String(e) },
      "Realtime removeChannel failed (ignored).",
    );
  }
}

module.exports = { startRealtimeListener, stopRealtimeListener };
