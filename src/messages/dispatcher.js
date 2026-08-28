/**
 * Shared notification dispatcher.
 *
 * Both the HTTP `/notify` handler and the Supabase Realtime listener
 * funnel into this single function so there is exactly one place that
 * owns the "what does a new_order mean and how do we send it?" logic.
 *
 * Returns a discriminated status object so callers can decide whether
 * to surface a 200 (`ok:true`) or a 5xx (`ok:false`) — the HTTP path
 * uses the latter to log a webhook failure, while the Realtime path
 * uses it only to decide whether to retry.
 *
 * The `sock` parameter is the live Baileys socket — the dispatcher
 * doesn't reach into globals, which keeps the call sites honest.
 */

const { loadEnv } = require("../lib/env.js");
const { getLogger } = require("../lib/logger.js");
const { phoneToJid } = require("../lib/formatter.js");
const { resolveProductName, resolveUsername } = require("../lib/supabase.js");
const {
  buildDeployFailedText,
  buildDeploySuccessText,
  buildInvoiceSentText,
  buildNewOrderText,
  buildReportText,
} = require("./templates.js");
const fs = require("fs");
const path = require("path");

const log = getLogger().child({ mod: "dispatcher" });

const {
  sendCtaUrlButton,
  sendCtaUrlButtonWithImage,
  sendTextFallback,
} = require("../utils/interactiveHelper");

const WEBSITE_URL = "https://nelsen.web.id";
const ADMIN_REPORTS_URL = "https://nelsen.web.id/admin/reports";

/**
 * Load the checkout/invoice banner image once at startup.
 *
 * Located at `src/media/banner.png` (16:9 ratio). The image is read
 * into a Buffer the first time the module loads and reused for every
 * subsequent notification — re-reading from disk per-event would burn
 * I/O for no reason. If the file is missing, we log a warning once and
 * fall back to the text-only path (the bot still notifies, just without
 * the banner image).
 */
let _bannerImage = null;
let _bannerMissingWarned = false;
function loadBannerImage() {
  if (_bannerImage) return _bannerImage;
  const bannerPath = path.join(__dirname, "..", "media", "banner.png");
  try {
    _bannerImage = fs.readFileSync(bannerPath);
    log.info({ bannerPath, bytes: _bannerImage.length }, "Banner image loaded");
  } catch (e) {
    if (!_bannerMissingWarned) {
      log.warn(
        { bannerPath, err: e?.message || String(e) },
        "Banner image not found — notifications will be sent without image header",
      );
      _bannerMissingWarned = true;
    }
    _bannerImage = null;
  }
  return _bannerImage;
}

/**
 * @param {object} sock  — live Baileys WASocket (Hanz).
 * @param {object} body  — inbound payload, any of the shapes below.
 * @returns {Promise<{ok: boolean, type: string, reason?: string}>}
 */
async function dispatchNotification(sock, body) {
  const env = loadEnv();
  const targetJid = phoneToJid(env.notifyTargetNumber);

  const { type, record } = normalizePayload(body);

  if (!type || !record) {
    return {
      ok: false,
      type: String(body?.type ?? body?.eventType ?? "null"),
      reason: "unknown shape or missing record",
    };
  }

  try {
    switch (type) {
      case "new_order": {
        const userId = stringField(record, "user_id");
        const productId = stringField(record, "product_id");
        const createdAt =
          stringField(record, "created_at") || new Date().toISOString();

        log.info(
          { userId, productId, orderId: stringField(record, "id") },
          "new_order: resolving usernames",
        );

        const [username, productName] = await Promise.all([
          userId ? resolveUsername(userId) : Promise.resolve(null),
          productId ? resolveProductName(productId) : Promise.resolve(null),
        ]);

        log.info(
          { userId, resolvedUsername: username, resolvedProduct: productName },
          "new_order: resolved",
        );

        const text = buildNewOrderText({
          username: username || "(user tidak ditemukan)",
          product_name: productName || "(produk tidak ditemukan)",
          quantity: numberField(record, "quantity") ?? 1,
          total_price: numberField(record, "total_price") ?? undefined,
          notes: stringField(record, "notes"),
          created_at: createdAt,
        });

        const result = await sendCtaUrlButtonWithImage(sock, targetJid, {
          text,
          footer: "Bot Nelsen Studio",
          imageSource: loadBannerImage(),
          buttons: [{ text: "Buka Dashboard", url: WEBSITE_URL }],
        });
        log.info(
          { type, path: result.path, ok: result.ok, err: result.error },
          "new_order sent",
        );
        return { ok: result.ok, type };
      }

      case "invoice_sent": {
        const userId = stringField(record, "user_id");
        const createdAt =
          stringField(record, "created_at") || new Date().toISOString();

        const [username] = await Promise.all([
          userId ? resolveUsername(userId) : Promise.resolve(null),
        ]);

        const text = buildInvoiceSentText({
          invoice_id: stringField(record, "invoice_number") || "(no number)",
          username: username || "(user tidak ditemukan)",
          product_name: "(lihat invoice)",
          total: numberField(record, "total") ?? 0,
          created_at: createdAt,
          pdf_url: stringField(record, "pdf_url"),
        });

        const result = await sendCtaUrlButtonWithImage(sock, targetJid, {
          text,
          footer: "Bot Nelsen Studio",
          imageSource: loadBannerImage(),
          buttons: [
            {
              text: "Lihat Invoice",
              url: stringField(record, "pdf_url") || WEBSITE_URL,
            },
          ],
        });
        log.info(
          { type, path: result.path, ok: result.ok, err: result.error },
          "invoice_sent sent",
        );
        return { ok: result.ok, type };
      }

      case "deploy_success": {
        const text = buildDeploySuccessText();
        const r = await sendTextFallback(sock, targetJid, text);
        log.info({ type, ok: r.ok }, "deploy_success sent");
        return { ok: r.ok, type };
      }

      case "deploy_failed": {
        const data = body?.data ?? {};
        const deployment = data?.deployment ?? {};
        const reason =
          stringField(deployment, "errorMessage") ??
          stringField(data, "reason") ??
          stringField(body, "reason");
        const text = buildDeployFailedText(reason ?? undefined);
        const r = await sendTextFallback(sock, targetJid, text);
        log.info({ type, ok: r.ok }, "deploy_failed sent");
        return { ok: r.ok, type };
      }

      case "report_user": {
        // User report (typically a "please unblock me" message from a
        // user who is currently blocked from the website). Pings the
        // admin via NOTIFY_TARGET_NUMBER with a button into the admin
        // reports page.
        const text = buildReportText({
          email: stringField(record, "email") ?? "",
          whatsapp_number: stringField(record, "whatsapp_number") ?? "",
          message: stringField(record, "message") ?? "",
          status: stringField(record, "status") ?? "pending",
        });
        const result = await sendCtaUrlButtonWithImage(sock, targetJid, {
          text,
          footer: "Bot Nelsen Studio",
          imageSource: loadBannerImage(),
          buttons: [{ text: "Buka Admin Reports", url: ADMIN_REPORTS_URL }],
        });
        log.info(
          { type, path: result.path, ok: result.ok, err: result.error },
          "report_user sent",
        );
        return { ok: result.ok, type };
      }

        case "custom_message": {
          // Expected record shape: { target: string (phone number), message: string }
          const target = stringField(record, "target") || stringField(body, "target");
          const target = stringField(record, "target") || stringField(body, "target");
          const text = stringField(record, "message") || stringField(body, "message");
          if (!target || !text) {
            return { ok: false, type, reason: "missing target or message" };
          }
          // Jika target sudah berupa JID (mengandung '@'), gunakan langsung; jika hanya nomor, konversi.
          const targetJid = target.includes("@") ? target : phoneToJid(target);
          const result = await sendTextFallback(sock, targetJid, text);
          log.info({ type, target, ok: result.ok, err: result.error }, "custom_message sent");
          return { ok: result.ok, type };
        }
        }
    }
  } catch (e) {
    log.error(
      { err: e?.message || String(e), type },
      "dispatchNotification crashed",
    );
    return { ok: false, type, reason: e?.message || String(e) };
  }
}

/**
 * Normalize the four possible inbound shapes into a single
 * `{type, record}` pair. The HTTP path and the Realtime path use
 * different field names (`record` vs `new`); the new dispatcher
 * accepts both so the call site does not have to care.
 */
function normalizePayload(body) {
  if (!body || typeof body !== "object") {
    return { type: null, record: null };
  }

  // (1) Our internal shape — `{type:"new_order", record:{...}}`.
  const t = body.type;
  if (typeof t === "string") {
    // (3) Supabase postgres_changes / webhook default — `{type:"INSERT", table:"orders", record:{...}}`.
    if (t === "INSERT") {
      const table = body.table;
      if (table === "orders") {
        return { type: "new_order", record: body.record ?? null };
      }
      if (table === "invoices") {
        return { type: "invoice_sent", record: body.record ?? null };
      }
      if (table === "reports") {
        return { type: "report_user", record: body.record ?? null };
      }
      return { type: null, record: null };
    }

    // (2) Vercel deploy webhooks — translate the literal.
    if (t === "deployment.succeeded") return { type: "deploy_success", record: null };
    if (t === "deployment.errored" || t === "deployment.failed") {
      return { type: "deploy_failed", record: null };
    }

    // (1) Internal shape, pass through.
    if (
      t === "new_order" ||
      t === "invoice_sent" ||
      t === "report_user" ||
      t === "deploy_success" ||
      t === "deploy_failed" ||
      t === "custom_message"
    ) {
      // Untuk custom_message, record adalah seluruh body karena target & message di root
      const record = t === "custom_message" ? body : (body.record ?? null);
      return { type: t, record };
    }
  }

  // (4) Supabase Realtime postgres_changes payload — `{eventType:"INSERT", new:{...}, table:"orders", schema:"public"}`.
  const et = body.eventType;
  if (typeof et === "string" && et === "INSERT") {
    const table = body.table;
    if (table === "orders") {
      return { type: "new_order", record: body.new ?? null };
    }
    if (table === "invoices") {
      return { type: "invoice_sent", record: body.new ?? null };
    }
    if (table === "reports") {
      return { type: "report_user", record: body.new ?? null };
    }
    return { type: null, record: null };
  }

  return { type: null, record: null };
}

function stringField(obj, key) {
  const v = obj?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numberField(obj, key) {
  const v = obj?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

module.exports = { dispatchNotification };
