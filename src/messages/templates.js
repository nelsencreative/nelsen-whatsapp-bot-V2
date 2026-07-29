/**
 * Message body builders.
 *
 * Each template returns a `text` body. The dispatcher pairs the body
 * with a CTA button (`cta_url` to https://nelsen.web.id) and sends via
 * the interactive-message helper. Plain-text URLs are ALWAYS included
 * in the body so the recipient can tap the link even if the native
 * button fails to render (which Baileys' unofficial protocol does
 * occasionally).
 *
 * Every outbound message ends with the signature line.
 */

const {
  formatDate,
  formatRupiah,
  formatTime,
  SIGNATURE,
} = require("../lib/formatter.js");

/** Default note text when the order record has no `notes`. */
const DEFAULT_ORDER_NOTE = "(tidak ada catatan)";

/**
 * New order notification.
 *
 * Required fields per spec:
 *   username, product_name, quantity, date, time, note_or_default_text_if_empty
 *
 * Plus optional native button linking to https://nelsen.web.id (handled
 * by the dispatcher, not here).
 */
function buildNewOrderText(input) {
  const {
    username,
    product_name,
    quantity,
    total_price,
    notes,
    created_at,
  } = input;
  const date = formatDate(created_at);
  const time = formatTime(created_at);
  const noteText =
    notes && String(notes).trim().length > 0
      ? String(notes).trim()
      : DEFAULT_ORDER_NOTE;

  const lines = [
    "👋 Hi Nelsen, ada pesanan baru masuk!",
    "",
    `Nama: ${username}`,
    `Produk: ${product_name}`,
    `Jumlah: ${quantity}`,
    `Tanggal: ${date}`,
    `Jam: ${time}`,
  ];
  if (typeof total_price === "number" && Number.isFinite(total_price)) {
    lines.push(`Total: ${formatRupiah(total_price)}`);
  }
  lines.push(
    "━━━━━━━━━━━━━━",
    "📝 Catatan dari user:",
    noteText,
  );

  // Plain URL — WhatsApp auto-links, so this is the GUARANTEED tappable
  // link even if the native button below fails to render.
  lines.push("", "Buka dashboard: https://nelsen.web.id");
  lines.push(SIGNATURE);
  return lines.join("\n");
}

/**
 * Deploy success message. No dynamic data — fixed copy from the spec.
 */
function buildDeploySuccessText() {
  return [
    "✅ Website berhasil deploy!",
    "🌐 nelsen.web.id",
    SIGNATURE,
  ].join("\n");
}

/**
 * Deploy failure message.
 * `reason` is optional — Vercel's payload includes an error string we
 * can surface for quick triage.
 */
function buildDeployFailedText(reason) {
  const lines = [
    "❌ Website gagal deploy!",
    "🌐 nelsen.web.id",
  ];
  if (reason && String(reason).trim().length > 0) {
    lines.push(`Detail: ${String(reason).trim()}`);
  }
  lines.push(SIGNATURE);
  return lines.join("\n");
}

/**
 * Invoice-sent notification.
 *
 * Per spec:
 *   🧾 Invoice {invoice_id}
 *   Nama: {username}
 *   Produk: {product_name}
 *   Total: {total}
 *   Tanggal: {date}
 *   > Bot Nelsen Studio
 *
 * `invoice_id` per the spec means the friendly invoice_number string,
 * NOT the UUID — that's what the user already sees elsewhere in the app.
 */
function buildInvoiceSentText(input) {
  const {
    invoice_id,
    username,
    product_name,
    total,
    created_at,
    pdf_url,
  } = input;
  const date = formatDate(created_at);
  // PDF link is more useful when present; fall back to the home page.
  const linkTarget =
    pdf_url && String(pdf_url).trim().length > 0
      ? String(pdf_url).trim()
      : "https://nelsen.web.id";

  return [
    `🧾 Invoice ${invoice_id}`,
    "",
    `Nama: ${username}`,
    `Produk: ${product_name}`,
    `Total: ${formatRupiah(total)}`,
    `Tanggal: ${date}`,
    "",
    `Lihat invoice: ${linkTarget}`,
    SIGNATURE,
  ].join("\n");
}

/**
 * New user-report notification (e.g. user got blocked and is asking to
 * be unblocked). Pings `NOTIFY_TARGET_NUMBER` so the admin sees it
 * immediately and can resolve via the admin panel.
 *
 * Per spec:
 *   ⚠️ REPORT USER
 *   email: ...
 *   No WA: ...
 *   message: ...
 *   status: pending
 *
 * The native button leads to the admin reports page; the body's plain
 * URL guarantees a tappable link if the button fails to render.
 */
function buildReportText(input) {
  const { email, whatsapp_number, message, status } = input;
  const lines = [
    "⚠️ REPORT USER",
    "",
    `email: ${email || "(tidak ada)"}`,
    `No WA: ${whatsapp_number || "(tidak ada)"}`,
    `message: ${message || "(tidak ada)"}`,
    `status: ${status || "pending"}`,
    "",
    "Buka admin panel: https://nelsen.web.id/admin/reports",
    SIGNATURE,
  ];
  return lines.join("\n");
}

module.exports = {
  buildNewOrderText,
  buildDeploySuccessText,
  buildDeployFailedText,
  buildInvoiceSentText,
  buildReportText,
};
