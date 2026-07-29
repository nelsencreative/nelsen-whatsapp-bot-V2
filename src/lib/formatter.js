/**
 * Display formatters used in outbound WhatsApp messages.
 *
 * Times are formatted in Asia/Jakarta (WIB) — the project's primary
 * timezone — regardless of the bot's host time zone. Dates use the
 * en-GB locale to get "27 Jul 2026" rather than "Jul 27, 2026".
 */

/** Convert a digit-only phone string to a WhatsApp JID. */
function phoneToJid(digits) {
  return `${digits}@s.whatsapp.net`;
}

/**
 * Format a date as e.g. "27 Jul 2026". Accepts an ISO string or a Date.
 * Returns the original input if it can't be parsed.
 */
function formatDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(d);
}

/**
 * Format a time-of-day as 24h "HH:mm" in Asia/Jakarta.
 */
function formatTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Jakarta",
  }).format(d);
}

/**
 * Format a numeric amount as Indonesian Rupiah with thousands separator.
 * We do NOT add decimals — all Nelsen order totals are integers in IDR.
 *
 * @example formatRupiah(1234567) → "Rp 1.234.567"
 */
function formatRupiah(amount) {
  if (!Number.isFinite(amount)) return `Rp ${amount}`;
  return (
    "Rp " +
    new Intl.NumberFormat("id-ID", {
      maximumFractionDigits: 0,
    }).format(amount)
  );
}

/** Footer signature on every outbound message. */
const SIGNATURE = "> Bot Nelsen Studio";

module.exports = {
  phoneToJid,
  formatDate,
  formatTime,
  formatRupiah,
  SIGNATURE,
};
