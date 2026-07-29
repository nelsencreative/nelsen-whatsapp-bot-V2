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
 * Accepted `value` strings (canonical): `"operational"`, `"maintenance"`.
 * Unknown values are rejected — we don't want typos like `"maintanence"`
 * silently creating a row with garbage data.
 */
async function setSiteStatus(value) {
  const allowed = ["operational", "maintenance"];
  if (!allowed.includes(value)) {
    return { ok: false, error: `invalid status: ${value}` };
  }
  const sb = getSupabase();
  const { error } = await sb
    .from("site_status")
    .upsert(
      { id: 1, status: value, updated_at: new Date().toISOString() },
      { onConflict: "id" },
    );
  if (error) {
    log.warn({ err: error.message }, "setSiteStatus error");
    return { ok: false, error: error.message };
  }
  return { ok: true, status: value };
}

module.exports = {
  getSupabase,
  resolveUsername,
  resolveProductName,
  listProducts,
  getSiteStatus,
  setSiteStatus,
};
