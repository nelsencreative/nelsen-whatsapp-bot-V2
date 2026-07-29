/**
 * Hand-rolled env validator — keeps the dep footprint small (no zod).
 *
 * Required vars cause `loadEnv()` to print every missing var and exit.
 * Optional vars fall back to documented defaults.
 *
 * Loaded from process.env first (so Pterodactyl-level env vars win), then
 * from .env (loaded via dotenv on first invocation). Always call this
 * exactly once at startup, before any other module that touches env vars.
 */

let dotenvLoaded = false;

function loadDotenvOnce() {
  if (dotenvLoaded) return;
  try {
    // dotenv does NOT override existing process.env entries — perfect
    // for "Pterodactyl env vars > .env file" precedence.
    require("dotenv").config();
  } catch (e) {
    // dotenv is in package.json — this catch is defensive only.
  }
  dotenvLoaded = true;
}

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === "") return ""; // sentinel
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Normalize a phone string to digits only. The bot's env vars are typed
 * with country code (`6287811007088`), but as a courtesy we strip any
 * spaces / hyphens / parens / leading `+` a user might paste.
 */
function normalizePhone(raw) {
  return String(raw).replace(/[^0-9]/g, "");
}

let cached = null;

function loadEnv() {
  if (cached) return cached;

  loadDotenvOnce();

  const missing = [];
  const notifyTargetRaw = required("NOTIFY_TARGET_NUMBER");
  if (!notifyTargetRaw) missing.push("NOTIFY_TARGET_NUMBER");
  const notifyApiSecret = required("NOTIFY_API_SECRET");
  if (!notifyApiSecret) missing.push("NOTIFY_API_SECRET");
  const supabaseUrl = required("SUPABASE_URL");
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  const supabaseServiceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0) {
    console.error(`[env] Missing required env vars: ${missing.join(", ")}`);
    console.error("[env] See .env.example for the full list.");
    process.exit(1);
  }

  cached = {
    notifyTargetNumber: normalizePhone(notifyTargetRaw),
    notifyApiSecret,
    supabaseUrl,
    supabaseServiceRoleKey,
    port: parseInt(optional("PORT", "3000"), 10),
    realtimeEnabled: (optional("BOT_REALTIME_ENABLED", "true")) === "true",
    logLevel: optional("LOG_LEVEL", "info"),
  };

  return cached;
}

module.exports = { loadEnv, normalizePhone };
