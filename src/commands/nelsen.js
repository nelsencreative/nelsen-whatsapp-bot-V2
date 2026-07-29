/**
 * Nelsen Studio commands.
 *
 * Drop-in commands added after the basebot migration:
 *
 *   !product / .product                       — list active products.
 *   !statusweb / .statusweb                   — show current site status.
 *   !status {mode} / .status {mode}           — toggle status (legacy simple).
 *   !status {fields} / .status {fields}       — full multi-field edit (pipe).
 *   !notif {judul}|{isi} / .notif {judul}|{isi} — admin broadcast to
 *                                                NOTIFY_TARGET_NUMBER AND
 *                                                INSERT into
 *                                                `public.notifications` so
 *                                                the recipient's mobile app
 *                                                receives a real FCM push
 *                                                via the Edge Function.
 *
 * All commands except `product` are `isSuperOwner`-only.
 *
 * The pipe character (`|`) is the universal separator for multi-field
 * inputs — it never appears in Indonesian/English product copy, so it
 * is safe as a delimiter without escaping.
 *
 * Command loader picks up commands by scanning for `case '...':`
 * strings inside the handler function — keep them single-quoted and
 * lowercase so auto-detection works.
 */

const config = require('../config');
const { getImage } = require('../utils/helper');
const {
    listProducts,
    getSiteStatus,
    setSiteStatus,
    resolveProfileByPhone,
    createNotification,
    triggerFcmPush,
} = require('../lib/supabase');
const { phoneToJid } = require('../lib/formatter');
const { loadEnv } = require('../lib/env');
const { getLogger } = require('../lib/logger');

const log = getLogger().child({ mod: 'commands.nelsen' });

// Display prefix for help text. Use the FIRST entry of the array so
// users see one consistent example (`!`) instead of `!,.,/,#,?`.
const p = Array.isArray(config.prefix) ? config.prefix[0] : config.prefix;

/**
 * Split a pipe-separated input into trimmed parts, dropping empty
 * entries. Used by the multi-field `!status` and `!notif` commands.
 *
 * @param {string} raw
 * @param {number} [maxParts] — if given, splits into AT MOST that many
 *   parts; the last part absorbs any remaining pipes. This matters
 *   when the body itself contains a `|` (rare for `!status` body, but
 *   `!notif` deliberately splits into exactly 2 — judul / isi — and
 *   the isi may legitimately contain pipes in the future).
 */
function splitPipe(raw, maxParts) {
    if (!raw) return [];
    if (!maxParts || maxParts <= 0) {
        return String(raw).split('|').map(s => s.trim()).filter(Boolean);
    }
    const parts = String(raw).split('|');
    const head = parts.slice(0, maxParts - 1).map(s => s.trim());
    const tail = parts.slice(maxParts - 1).join('|').trim();
    return [...head, tail].filter(s => s.length > 0);
}

const handler = async (m) => {
    // IMPORTANT: `args` and `fullArgs` live on `m.command.*` — the
    // message handler does NOT pass them as top-level destructurable
    // keys (it spreads `{ Hanz, msg, sender, ..., command, text }`).
    // Reading them off `m.command.args` / `m.command.fullArgs` was the
    // root cause of the `Cannot read properties of undefined (reading
    // '0')` crash when running `!status maintance`.
    const { command, isSuperOwner, Hanz, sender } = m;
    const args = command?.args || [];
    const fullArgs = command?.fullArgs || '';

    switch (command.name) {
        // ────────────────────────────────────────────────────────────
        case 'product': {
            // Open to anyone. The product catalog has zero PII (no
            // prices for blocked users etc.) — it's a public-facing
            // card.
            const products = await listProducts();

            if (!products || products.length === 0) {
                return m.reply({ text: '📦 Belum ada produk tersedia saat ini.' });
            }

            const lines = [
                `📦 *TOTAL PRODUK TERSEDIA ${products.length}*`,
                '',
            ];

            products.forEach((prod, idx) => {
                lines.push(`${idx + 1}. ${prod.name}`);
                lines.push(`Harga: ${formatRupiah(prod.price)}`);
                if (prod.slug) {
                    lines.push(`Link: https://nelsen.web.id/catalog/${prod.slug}`);
                }
                lines.push('');
            });

            lines.push('Mau pesan? Klik tombol di bawah untuk melihat semua produk.');

            await m.sendInteractiveWithImage({
                imageSource: getImage('banner'),
                text: lines.join('\n'),
                footer: config.footerTxt || '> Bot Nelsen Studio',
                quoted: m.fakeOrder,
                contextInfo: {
                    mentionedJid: ['0@s.whatsapp.net'],
                    forwardingScore: 999,
                    isForwarded: true,
                },
                buttons: [
                    {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                            display_text: 'Lihat Katalog Lengkap',
                            url: 'https://nelsen.web.id/catalog',
                        }),
                    },
                ],
            });
            break;
        }

        // ────────────────────────────────────────────────────────────
        case 'statusweb': {
            const status = await getSiteStatus();
            const isOp = status === 'operational' || status == null;
            const line = isOp
                ? '🟢 Status web nelsen.web.id operational ✅'
                : '⚠️ Status web nelsen.web.id maintenance ⚠️';
            return m.reply({ text: line });
        }

        // ────────────────────────────────────────────────────────────
        case 'status': {
            // Owner-only: mutate the live `site_status` row.
            if (!isSuperOwner) {
                return m.reply({ text: '❌ Khusus Super Owner!' });
            }

            // Two forms, detected by the presence of a pipe:
            //
            //   SIMPLE:  `!status maintenance`
            //            -> just flip status, leave title/subtitle/etc
            //               as they were.
            //
            //   FULL:    `!status maintenance|{title}|{subtitle}|{description}|on|off`
            //            -> set status + title + subtitle + description +
            //               auto_disable_at. `auto_disable_at=on` schedules
            //               a 5-hour auto-flip back to operational;
            //               `auto_disable_at=off` clears it to NULL.
            //               Any field can be left empty to keep its
            //               existing value (except `auto_disable_at`
            //               which must be explicitly `on` or `off`).

            if (!fullArgs || !fullArgs.trim()) {
                return m.reply({
                    text:
                        `📌 Format:\n` +
                        `• \`${p}status maintenance\` (singkat)\n` +
                        `• \`${p}status maintance|{title}|{subtitle}|{description}|on/off\` (lengkap)\n\n` +
                        `Kolom \`on\` artinya auto-disable 5 jam ke depan.\n` +
                        `Kolom \`off\` artinya tanpa auto-disable (NULL).`,
                });
            }

            const hasPipe = fullArgs.includes('|');

            // ----- SIMPLE form: single-token status toggle.
            if (!hasPipe) {
                const arg = String(fullArgs).trim().toLowerCase();
                const map = {
                    operational: 'operational',
                    opr: 'operational',
                    on: 'operational',
                    normal: 'operational',
                    live: 'operational',
                    maintenance: 'maintenance',
                    maint: 'maintenance',
                    maintance: 'maintenance',
                    maintence: 'maintenance',
                    maintainance: 'maintenance',
                    off: 'maintenance',
                    down: 'maintenance',
                    offline: 'maintenance',
                };
                const canonical = map[arg];
                if (!canonical) {
                    return m.reply({
                        text:
                            `❌ Mode tidak dikenal: \`${arg}\`\n\n` +
                            `Pakai:\n` +
                            `• \`${p}status operational\`\n` +
                            `• \`${p}status maintenance\``,
                    });
                }
                const r = await setSiteStatus(canonical);
                if (!r.ok) {
                    return m.reply({ text: `❌ Gagal update: ${r.error}` });
                }
                return m.reply({
                    text:
                        canonical === 'operational'
                            ? '✅ Status website diubah ke *operational*.'
                            : '⚠️ Status website diubah ke *maintenance*.',
                });
            }

            // ----- FULL form: status|title|subtitle|description|auto_disable.
            // Allow up to 5 parts; anything beyond is ignored. Last part
            // (auto_disable_at) MUST be `on` or `off` (case-insensitive)
            // — refuse ambiguous input rather than silently dropping it.
            const parts = splitPipe(fullArgs, 5);
            if (parts.length < 5) {
                return m.reply({
                    text:
                        `❌ Format lengkap butuh 5 kolom dipisah \`|\`:\n` +
                        `\`${p}status status|title|subtitle|description|on|off\`\n\n` +
                        `Bagian \`on\`/\`off\` adalah kolom terakhir (auto_disable_at).`,
                });
            }
            const [statusField, title, subtitle, description, autoDisable] = parts;

            // Resolve status with the same map as the simple form.
            const statusKey = statusField.toLowerCase();
            const map = {
                operational: 'operational',
                opr: 'operational',
                on: 'operational',
                maintenance: 'maintenance',
                maint: 'maintenance',
                maintance: 'maintenance',
                maintence: 'maintenance',
                maintainance: 'maintenance',
            };
            const canonicalStatus = map[statusKey];
            if (!canonicalStatus) {
                return m.reply({
                    text:
                        `❌ Status tidak dikenal: \`${statusField}\`\n\n` +
                        `Bagian pertama harus \`operational\` atau \`maintenance\`.`,
                });
            }

            // auto_disable_at: `on` -> now + 5 hours; `off` -> NULL.
            // Anything else is an error — ambiguous inputs are the
            // worst kind of input for an auto-scheduler.
            const ad = autoDisable.toLowerCase();
            let autoDisableAt;
            if (ad === 'on') {
                autoDisableAt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
            } else if (ad === 'off') {
                autoDisableAt = null;
            } else {
                return m.reply({
                    text:
                        `❌ Auto-disable harus \`on\` atau \`off\` (got: \`${autoDisable}\`).\n\n` +
                        `• \`on\` → auto-flip ke operational 5 jam ke depan.\n` +
                        `• \`off\` → tanpa auto-flip (NULL).`,
                });
            }

            const r = await setSiteStatus(canonicalStatus, {
                title,
                subtitle,
                description,
                auto_disable_at: autoDisableAt,
            });
            if (!r.ok) {
                log.warn({ err: r.error }, '!status full update failed');
                return m.reply({ text: `❌ Gagal update: ${r.error}` });
            }

            const adText = ad === 'on'
                ? `\nAuto-disable aktif: ${new Date(autoDisableAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`
                : '\nAuto-disable: tidak aktif (NULL).';

            return m.reply({
                text:
                    `✅ Status website diperbarui.\n` +
                    `• status: *${canonicalStatus}*\n` +
                    `• title: ${title}\n` +
                    `• subtitle: ${subtitle}\n` +
                    `• description: ${description}` +
                    adText,
            });
        }

        // ────────────────────────────────────────────────────────────
        case 'notif': {
            // Admin broadcast. Two surfaces:
            //
            //   1. WhatsApp: send to NOTIFY_TARGET_NUMBER so the admin
            //      has a copy in their personal chat (handy for
            //      forwarding).
            //   2. Push notification: INSERT into `public.notifications`
            //      keyed on the super-owner's profile id. The Nelsen
            //      dashboard's Edge Function picks up that INSERT and
            //      pushes an FCM message to the user's mobile app —
            //      this is what makes the notif actually "appear in
            //      the application".
            //
            // Format: `{prefix}notif {judul}|{isi}`
            //
            // Example: `!notif Special Promo|Yuk order sekarang!`
            if (!isSuperOwner) {
                return m.reply({ text: '❌ Khusus Super Owner!' });
            }

            if (!fullArgs || !fullArgs.trim()) {
                return m.reply({
                    text:
                        `📌 Format: \`${p}notif {judul}|{isi}\`\n\n` +
                        `Contoh:\n` +
                        `\`${p}notif Special Promo|Yuk order sekarang di Nelsen Studio!\`\n\n` +
                        `Notifikasi akan dikirim ke:\n` +
                        `• WhatsApp pribadi (${config.superOwner})\n` +
                        `• Push notification ke aplikasi mobile`,
                });
            }

            // Pipe split into EXACTLY 2 parts: judul and isi. The isi
            // may legitimately contain `|` characters, so we split on
            // the FIRST pipe only.
            const raw = String(fullArgs).trim();
            const pipeIdx = raw.indexOf('|');
            if (pipeIdx === -1) {
                return m.reply({
                    text:
                        `❌ Format salah. Pakai \`|\` sebagai pemisah judul dan isi.\n\n` +
                        `Contoh:\n` +
                        `\`${p}notif Special Promo|Yuk order sekarang di Nelsen Studio!\``,
                });
            }

            const judul = raw.slice(0, pipeIdx).trim();
            const isi = raw.slice(pipeIdx + 1).trim();

            if (!judul || !isi) {
                return m.reply({
                    text:
                        '❌ Judul dan isi tidak boleh kosong.\n\n' +
                        `Contoh:\n\`${p}notif Special Promo|Yuk order sekarang\``,
                });
            }

            const env = loadEnv();
            const targetJid = phoneToJid(env.notifyTargetNumber);

            // ---- (1) WhatsApp — text-only is the right call here:
            // personal-chat notifications don't need a CTA button, and
            // the dashboard app's push will carry the actual deep link.
            const waBody = [
                `📢 *${judul}*`,
                '',
                isi,
                '',
                '> Bot Nelsen Studio',
            ].join('\n');

            let waOk = false;
            let waError = null;
            try {
                await Hanz.sendMessage(targetJid, { text: waBody });
                waOk = true;
            } catch (err) {
                waError = err?.message || String(err);
                log.warn({ err: waError }, '!notif WA send failed');
            }

            // ---- (2) Push notification — same path the Next.js
            // inbox uses: HTTP POST to the `send-notification` Edge
            // Function, which reads `user_profiles.fcm_token` and
            // pushes via Firebase Admin SDK. This is the ONLY path
            // that actually delivers a real OS-level push to the
            // user's mobile app.
            //
            // We also INSERT into `public.notifications` afterwards
            // so the bell badge updates via the
            // `useRealtimeNotifications` hook — same pattern as the
            // inbox flow (one HTTP push + one inbox row).
            const recipient = await resolveProfileByPhone(config.superOwner);
            let pushResult = null;
            let inboxResult = null;

            if (!recipient) {
                const errMsg =
                    `Profile untuk nomor ${config.superOwner} tidak ditemukan di tabel profiles. ` +
                    'Pastikan profile admin punya whatsapp_number yang sama dengan config.superOwner.';
                log.warn({ phone: config.superOwner }, '!notif: super-owner profile not found; skipping push');
                pushResult = { ok: false, error: errMsg };
            } else {
                // (2a) FCM push — Edge Function.
                pushResult = await triggerFcmPush({
                    userId: recipient.id,
                    title: judul,
                    body: isi,
                    data: { type: 'broadcast', source: 'whatsapp-bot' },
                });
                if (!pushResult.ok) {
                    log.warn(
                        { err: pushResult.error, userId: recipient.id },
                        '!notif FCM push failed',
                    );
                }

                // (2b) Inbox row — for the bell badge Realtime feed.
                // Only attempt if FCM didn't error out with a fatal
                // user-missing condition; otherwise the inbox row
                // would just be noise.
                if (pushResult.ok) {
                    inboxResult = await createNotification({
                        recipientId: recipient.id,
                        type: 'broadcast',
                        title: judul,
                        body: isi,
                    });
                    if (!inboxResult.ok) {
                        log.warn(
                            { err: inboxResult.error },
                            '!notif inbox insert failed (push already sent)',
                        );
                    }
                }
            }

            // Compose the response — be explicit so the admin knows
            // whether the push actually reached the device.
            const lines = [];
            if (waOk) lines.push('✅ WhatsApp: terkirim.');
            else lines.push(`❌ WhatsApp: gagal (${waError || 'unknown'}).`);

            if (pushResult?.ok) {
                lines.push(
                    `✅ Push FCM: terkirim ke aplikasi mobile` +
                    (pushResult.messageId ? ` (messageId=${pushResult.messageId})` : '') +
                    '.',
                );
                if (inboxResult?.ok) {
                    lines.push(`✅ Inbox: tersimpan (id=${inboxResult.id}).`);
                } else if (inboxResult) {
                    lines.push(`⚠️ Inbox: ${inboxResult.error}`);
                }
            } else if (pushResult) {
                lines.push(`❌ Push FCM: ${pushResult.error}`);
            }

            return m.reply({ text: lines.join('\n') });
        }
    }
};

/**
 * Local helper — keep a private copy here so commands/nelsen.js does
 * not depend on lib/formatter.js exporting it.
 */
function formatRupiah(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 'IDR 0';
    return 'IDR ' + num.toLocaleString('id-ID', {
        maximumFractionDigits: 0,
    });
}

module.exports = handler;
