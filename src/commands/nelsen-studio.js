/**
 * Nelsen Studio commands.
 *
 * Drop-in commands added after the basebot migration. The filename
 * is `nelsen-studio.js` so the auto-generated menu category reads
 * `nelsen-studio` (the PluginLoader derives the category label from
 * the basename). Renaming the file is the right way to change the
 * label — there is no separate display-name field.
 *
 *   !product / .product                          — list active products.
 *   !promo / .promo                              — active promo count + CTA.
 *                                                 DM-only; ignored in groups.
 *   !assets / .assets                            — list assets + CTA.
 *                                                 Open to everyone.
 *   !statusweb / .statusweb                      — show current site status.
 *   !status {mode} / .status {mode}              — toggle status (legacy simple).
 *   !status {fields} / .status {fields}          — full multi-field edit (pipe).
 *   !notif {judul}|{isi} / .notif {judul}|{isi}  — admin broadcast. Fans out
 *                                                  an FCM push to every user
 *                                                  with a registered
 *                                                  `fcm_token` (Edge
 *                                                  Function `send-notification`
 *                                                  broadcast mode).
 *
 * `promo` and `assets` are public. Everything else is super-owner-only.
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
    listActivePromos,
    listActiveAssets,
    getSiteStatus,
    setSiteStatus,
    triggerFcmPush,
} = require('../lib/supabase');
const { getLogger } = require('../lib/logger');

const log = getLogger().child({ mod: 'commands.nelsen-studio' });

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
            // Admin broadcast — fans out a single notification to
            // EVERY user that has a registered `fcm_token` in
            // `user_profiles`. Mirrors how a marketing push works:
            // one author, many recipients, all through the same
            // Edge Function the Next.js inbox uses.
            //
            // Earlier revisions of this command also sent a copy to
            // the admin's own WhatsApp (`NOTIFY_TARGET_NUMBER`) and
            // looked up the admin's profile by phone. Both of those
            // were removed because:
            //
            //   - The WA send was redundant — the admin typed the
            //     command, they already see it on their phone.
            //   - The profile lookup required
            //     `config.superOwner`'s `whatsapp_number` to match a
            //     row in `profiles`. When it didn't match (the most
            //     common case — the super-owner is identified by
            //     their bot account, not their web app account), the
            //     push silently dropped with "Profile ... tidak
            //     ditemukan". The bug report was: "saya ingin
            //     notifikasi muncul pada semua user (bukan hanya
            //     user yang setting nomor)".
            //
            // Format: `{prefix}notif {judul}|{isi}`
            //
            // Example: `!notif PROMO SPECIAL|Yuk order sekarang!`
            //
            // The Edge Function `send-notification` is called with
            // `broadcast: true` — see
            // `supabase/functions/send-notification/index.ts`. It
            // returns `{ total, sent, failed }` which we surface in
            // the response so the admin knows how many devices were
            // actually reached.
            if (!isSuperOwner) {
                return m.reply({ text: '❌ Khusus Super Owner!' });
            }

            if (!fullArgs || !fullArgs.trim()) {
                return m.reply({
                    text:
                        `📌 Format: \`${p}notif {judul}|{isi}\`\n\n` +
                        `Contoh:\n` +
                        `\`${p}notif Special Promo|Yuk order sekarang di Nelsen Studio!\`\n\n` +
                        `Notifikasi akan dikirim ke SEMUA user yang punya aplikasi mobile ` +
                        `dengan fcm_token aktif (tidak berdasarkan nomor WhatsApp).`,
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

            // ---- Broadcast to all users with fcm_token ----
            //
            // The Edge Function `send-notification` handles the
            // fan-out via `sendEachForMulticast`. One HTTP roundtrip
            // from us; Firebase batches the individual sends server-
            // side. We just surface the result counts.
            const pushResult = await triggerFcmPush({
                broadcast: true,
                title: judul,
                body: isi,
                data: { type: 'broadcast', source: 'whatsapp-bot' },
            });

            if (!pushResult.ok) {
                // `error` covers both: HTTP-level failure (network,
                // auth, missing secrets) and "every target failed"
                // (failed === total). Either way the admin needs to
                // know the broadcast did NOT reach anyone.
                log.warn(
                    { err: pushResult.error, total: pushResult.total },
                    '!notif broadcast failed',
                );
                return m.reply({
                    text:
                        `❌ Push FCM broadcast gagal.\n` +
                        `Pesan error: ${pushResult.error || 'unknown'}\n\n` +
                        `Cek:\n` +
                        `• Apakah Edge Function \`send-notification\` sudah di-deploy?\n` +
                        `• Apakah \`FIREBASE_SERVICE_ACCOUNT_JSON\` sudah di-set?`,
                });
            }

            // ---- Compose the admin-facing response ----
            //
            // User asked for: ganti "✅ WhatsApp: terkirim" menjadi
            // "✅Status: Terkirim ke semua user". We show a single
            // status line plus a breakdown so the admin can see at a
            // glance whether the fan-out was clean.
            const total = pushResult.total ?? 0;
            const sent = pushResult.sent ?? 0;
            const failed = pushResult.failed ?? 0;

            if (total === 0) {
                return m.reply({
                    text:
                        `⚠️Status: Tidak ada user dengan fcm_token aktif.\n` +
                        `Belum ada aplikasi mobile yang mendaftarkan push token.`,
                });
            }

            if (failed === 0) {
                return m.reply({
                    text:
                        `✅Status: Terkirim ke semua user\n` +
                        `• Total target: ${total}\n` +
                        `• Berhasil: ${sent}\n` +
                        `• Gagal: 0`,
                });
            }

            // Partial success — some tokens may be stale (user uninstalled
            // the app, cleared app data, etc.). Surface this rather than
            // hide it: silent partial failures are the worst kind.
            return m.reply({
                text:
                    `⚠️Status: Terkirim sebagian\n` +
                    `• Total target: ${total}\n` +
                    `• Berhasil: ${sent}\n` +
                    `• Gagal: ${failed}\n\n` +
                    `Token yang gagal biasanya karena user sudah uninstall aplikasi ` +
                    `atau app data dibersihkan. Token失效 akan di-bersihkan otomatis ` +
                    `oleh Edge Function pada push berikutnya.`,
            });
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
