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

module.exports = { getSupabase, resolveUsername, resolveProductName };
