/**
 * Supabase service-role client.
 *
 * Two purposes inside the bot:
 *  (1) Resolve `{username}` / `{product_name}` when a webhook/Realtime
 *      event fires (the payload only carries FKs).
 *
 * The service-role key BYPASSES RLS — it must never reach the browser or
 * any anon-endpoint. This client runs only inside the bot process.
 *
 * NOTE: this bot does NOT persist Baileys auth state to Supabase — that
 * is file-based via `useMultiFileAuthState` (kept compatible with the
 * working pairing flow).
 */

const { createClient } = require("@supabase/supabase-js");

const { loadEnv } = require("./env.js");
const { getLogger } = require("./logger.js");

const log = getLogger().child({ mod: "supabase" });

let cached = null;

function getSupabase() {
  if (cached) return cached;
  const env = loadEnv();
  cached = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      // The bot never authenticates a user — service_role only.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cached;
}

/**
 * Look up a profile's `full_name` for the human-friendly {username}
 * placeholder. Falls back through a chain so a missing profile or null
 * full_name still produces something readable.
 *
 * @returns The resolved name, or `null` if the profile does not exist.
 */
async function resolveUsername(userId) {
  if (!userId) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from("profiles")
    .select("full_name,email")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    log.warn(
      { userId, err: error.message },
      "resolveUsername: profiles query errored",
    );
    return null;
  }
  if (!data) {
    log.warn({ userId }, "resolveUsername: no profile row found for this user_id");
    return null;
  }

  const full = (data.full_name ?? "").trim();
  if (full) return full;
  if (data.email) {
    // Last resort: the local part of the email — ALWAYS present
    // because `auth.users.email` is required.
    return data.email.split("@")[0] || data.email;
  }
  return null;
}

/**
 * Look up a product's `name`. The webhook payload only carries
 * `product_id`; the template needs the human label.
 */
async function resolveProductName(productId) {
  if (!productId) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from("products")
    .select("name")
    .eq("id", productId)
    .maybeSingle();
  if (error || !data) return null;
  return ((data.name ?? "").trim()) || null;
}

/**
 * List active products for the `!product` / `.product` command.
 *
 * Returns an array sorted by name with the columns the command needs to
 * render the catalog card. Inactive products (`is_active = false`) are
 * filtered out — they're effectively "deleted" from the public catalog
 * but kept in the DB for order history.
 *
 * Returns `[]` on any error so the command can show an empty-state
 * message instead of crashing.
 */
async function listProducts() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("products")
    .select("id,name,slug,price,image_url,category")
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (error) {
    log.warn({ err: error.message }, "listProducts error");
    return [];
  }
  return data || [];
}

/**
 * Read the current website status from the singleton `site_status`
 * table (`id = 1`). Returns one of: `"operational"` | `"maintenance"`,
 * or `null` if the row is missing (treated as operational elsewhere).
 *
 * The schema is defined in
 * `supabase/migrations/20260722001000_site_maintenance.sql`. The
 * service-role key bypasses RLS, so this works regardless of policies.
 */
async function getSiteStatus() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("site_status")
    .select("status")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) {
    log.warn({ err: error?.message }, "getSiteStatus: no row found");
    return null;
  }
  return data.status || null;
}

/**
 * Set the website status. Updates the singleton row in `site_status`
 * (creating it if missing) and returns `{ ok, status }`.
 *
 * `value` accepts:
 *   - "operational" / "maintenance" — toggles the gate status.
 *   - `null` — clears the row back to operational (used by `!status off`).
 *
 * Optional fields (title, subtitle, description, auto_disable_at) are
 * written only when provided, so the simple `{status: "maintenance"}`
 * form leaves the existing copy intact.
 */
async function setSiteStatus(value, opts = {}) {
  const allowed = ["operational", "maintenance"];
  if (!allowed.includes(value)) {
    return { ok: false, error: `invalid status: ${value}` };
  }
  const sb = getSupabase();
  const payload = {
    id: 1,
    status: value,
    updated_at: new Date().toISOString(),
  };
  if (typeof opts.title === "string" && opts.title.length) payload.title = opts.title;
  if (typeof opts.subtitle === "string" && opts.subtitle.length) payload.subtitle = opts.subtitle;
  if (typeof opts.description === "string" && opts.description.length) payload.description = opts.description;
  if ("auto_disable_at" in opts) payload.auto_disable_at = opts.auto_disable_at; // may be null

  const { error } = await sb
    .from("site_status")
    .upsert(payload, { onConflict: "id" });
  if (error) {
    log.warn({ err: error.message }, "setSiteStatus error");
    return { ok: false, error: error.message };
  }
  return { ok: true, status: value };
}

/**
 * Look up a user's profile by their WhatsApp number (digits only).
 * Used by `!notif` to resolve the recipient for the FCM push.
 *
 * Returns the profile row `{ id, full_name }` or `null` if no match.
 */
async function resolveProfileByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const sb = getSupabase();
  // Normalize: keep digits only (Indonesian 08xxx → 628xxx).
  const digits = String(phoneNumber).replace(/\D/g, "");
  // Try with country-code prefix first, then local 0-prefix.
  const variants = new Set([digits]);
  if (digits.startsWith("0")) variants.add("62" + digits.slice(1));
  if (digits.startsWith("62")) variants.add("0" + digits.slice(2));

  const { data, error } = await sb
    .from("profiles")
    .select("id, full_name, whatsapp_number")
    .in("whatsapp_number", Array.from(variants))
    .maybeSingle();

  if (error) {
    log.warn({ err: error.message }, "resolveProfileByPhone error");
    return null;
  }
  return data || null;
}

/**
 * Insert a row into `public.notifications`.
 *
 * IMPORTANT — what this is NOT for:
 *   `public.notifications` is the dashboard's INBOX table. INSERTing a
 *   row here makes it appear in the user's notification bell via the
 *   `useRealtimeNotifications` hook. It does NOT trigger an FCM push.
 *
 *   FCM push is delivered by the `send-notification` Edge Function
 *   which is called via HTTP (see `triggerFcmPush` below). The Next.js
 *   inbox actions always do BOTH: an HTTP call to `send-notification`
 *   (for FCM) AND an INSERT into `notifications` (for inbox history).
 *
 * Returns `{ ok, id }` on success, `{ ok: false, error }` on failure.
 */
async function createNotification({ recipientId, type, title, body }) {
  if (!recipientId) return { ok: false, error: "missing recipientId" };
  const sb = getSupabase();
  const { data, error } = await sb
    .from("notifications")
    .insert({
      recipient_id: recipientId,
      type: type || "broadcast",
      title: String(title || ""),
      body: String(body || ""),
    })
    .select("id")
    .single();
  if (error) {
    log.warn({ err: error.message }, "createNotification error");
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data?.id };
}

/**
 * Trigger an FCM push via the deployed `send-notification` Supabase
 * Edge Function. This is THE SAME path the dashboard's Next.js server
 * actions use — `src/lib/notifications/send.ts` in the main repo —
 * so the push arrives in the user's mobile app identical to a normal
 * inbox notification.
 *
 * Why we don't just INSERT into `public.notifications`:
 *   The notifications table is the inbox history — read by the bell
 *   badge via Realtime. FCM is a separate HTTP roundtrip to the Edge
 *   Function which itself looks up `user_profiles.fcm_token` and
 *   pushes via Firebase Admin SDK. Skipping that roundtrip means
 *   the push never reaches the device.
 *
 * Returns `{ ok, messageId? }` on success, `{ ok: false, error }` on
 * failure.
 */
async function triggerFcmPush({ userId, title, body, data }) {
  if (!userId) return { ok: false, error: "userId is required" };
  if (!title || !body) {
    return { ok: false, error: "title and body are required" };
  }

  const env = loadEnv();
  if (!env.supabaseUrl) {
    return { ok: false, error: "SUPABASE_URL not set" };
  }

  const url = `${env.supabaseUrl.replace(/\/$/, "")}/functions/v1/send-notification`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        apikey: env.supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        user_id: userId,
        title: String(title),
        body: String(body),
        ...(data && typeof data === "object" ? { data } : {}),
      }),
      cache: "no-store",
    });

    const text = await res.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: parsed?.error || `Edge function returned status ${res.status}`,
      };
    }
    return { ok: true, messageId: parsed?.messageId };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

module.exports = {
  getSupabase,
  resolveUsername,
  resolveProductName,
  listProducts,
  getSiteStatus,
  setSiteStatus,
  resolveProfileByPhone,
  createNotification,
  triggerFcmPush,
};
