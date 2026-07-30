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
 *   !send {nomor}|{pesan} / .send ...            — super-owner DM-only.
 *                                                  Bot sends `{pesan}` to
 *                                                  `{nomor}` as if it were
 *                                                  the bot itself, with a
 *                                                  cta_url button pointing
 *                                                  at `config.urlButtonSend`.
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
const { phoneToJid } = require('../lib/formatter');

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
    const { command, isSuperOwner, isGroup, Hanz, sender } = m;
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
        case 'promo': {
            // DM-only, open to everyone.
            //
            // Why DM-only: promo count + a single CTA button is a
            // friendly one-liner that's useful privately but
            // noisy/repetitive in a group chat. The bot doesn't
            // react at all in groups (`return` with no reply) so a
            // user typing `!promo` in a group isn't greeted with
            // silence followed by confusion; they simply don't see
            // anything happen, which is the conventional WhatsApp
            // bot behavior for a private-only command.
            if (isGroup) {
                return;
            }

            const count = await listActivePromos();

            if (!count) {
                // Empty-state: same banner + footer + CTA as the
                // success branch, but the headline reads
                // "Promo tidak tersedia" instead of a count. The
                // CTA still points at /promos so a future admin
                // can spin one up and have the bot pick it up
                // immediately (no restart, no redeploy).
                return m.sendInteractiveWithImage({
                    imageSource: getImage('banner'),
                    text: '❌Promo tidak tersedia',
                    footer: '> © 2026 Nelsen Creative, All Rights Reserved.',
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
                                display_text: 'Lihat Halaman Promo',
                                url: 'https://nelsen.web.id/promos',
                            }),
                        },
                    ],
                });
            }

            const noun = count === 1 ? 'promo' : 'promo';
            return m.sendInteractiveWithImage({
                imageSource: getImage('banner'),
                text: `🔖Promo tersedia (${count})`,
                footer: '> © 2026 Nelsen Creative, All Rights Reserved.',
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
                            display_text: 'Lihat Halaman Promo',
                            url: 'https://nelsen.web.id/promos',
                        }),
                    },
                ],
            });
        }

        // ────────────────────────────────────────────────────────────
        case 'assets': {
            // Open to everyone, including in groups — assets are
            // public discoverability. (Unlike `promo`, which is
            // DM-only by spec.)
            const assets = await listActiveAssets();
            const total = assets.length;

            if (!total) {
                // Empty-state — same banner + footer + CTA pattern
                // as `!promo`.
                return m.sendInteractiveWithImage({
                    imageSource: getImage('banner'),
                    text: '❌Tidak ada assets tersedia saat ini.',
                    footer: '> © 2026 Nelsen Creative, All Rights Reserved.',
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
                                display_text: 'Lihat Halaman Assets',
                                url: 'https://nelsen.web.id/assets',
                            }),
                        },
                    ],
                });
            }

            // Build the asset list as numbered plain text. Each
            // entry includes title, description, link, platform,
            // status. Headline reads "Total asset (N)" per the spec.
            // Using `IDR <number>` for paid, `IDR 0` for free so
            // the formatting matches what the web /assets page
            // shows.
            const lines = [`Total asset (${total})`, ''];
            assets.forEach((a, idx) => {
                const priceLabel = a.status === 'paid' && a.price
                    ? `IDR ${Number(a.price).toLocaleString('id-ID')}`
                    : 'IDR 0';
                lines.push(`${idx + 1}. ${a.title}`);
                if (a.description) lines.push(`${a.description}`);
                lines.push(`Link: ${a.link_url}`);
                lines.push(`Platform: ${a.platform}`);
                lines.push(`Status: ${a.status === 'paid' ? 'Paid' : 'Free'} (${priceLabel})`);
                lines.push('');
            });
            lines.push('> © 2026 Nelsen Creative, All Rights Reserved.');

            return m.sendInteractiveWithImage({
                imageSource: getImage('banner'),
                text: lines.join('\n'),
                footer: 'Nelsen Studio',
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
                            display_text: 'Lihat Halaman Assets',
                            url: 'https://nelsen.web.id/assets',
                        }),
                    },
                ],
            });
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
        case 'send': {
            // Bot-initiated send: pipe `{nomor}|{pesan}` dari owner,
            // bot forward ke nomor tujuan dengan tombol CTA_URL.
            //
            // Why this exists:
            //   Admin kadang butuh kirim pesan atas nama brand
            //   langsung dari WhatsApp tanpa buka phone/webapp —
            //   mis. konfirmasi order, follow-up invoice, atau
            //   kontak personal yang tercatat di profil user. Spam-
            //   prevention: kita batasi ke super-owner (sama
            //   seperti `!notif` dan `!status`).
            //
            // Format:
            //   `{prefix}send {nomor}|{pesan}`
            //
            // Contoh:
            //   `!send 6285733370411|halo ini nelsen`
            //   `!send 085733370411|halo`           (auto-normalize)
            //
            // Akses:
            //   - Super-owner only (sejalan dengan `!notif`).
            //   - DM-only. Di grup admin tidak akan lihat reply
            //     sama sekali (`return` tanpa reply). Alasan:
            //     command ini sering sebut nomor + isi pesan, dan
            //     membalas di grup adalah privacy leak kepada
            //     semua member lain.
            //
            // Bentuk pesan yang dikirim ke tujuan:
            //   - body: `{pesan}` (apa adanya, tanpa prefix "Bot:").
            //   - footer: config.footerTxt (atau fallback).
            //   - tombol: cta_url dengan display_text "Buka Nelsen
            //     Studio" dan url `config.urlButtonSend` (default
            //     https://nelsen.web.id). Itu tombol persis mengikuti
            //     shape `sendCtaUrlButton` yang sudah terbukti jalan
            //     untuk dispatcher orders/invoices — jadi kita pakai
            //     helper yang sama persis, menghindari "CTAs arrive
            //     as text-only" bug yang sudah-sudah.
            //
            // Audit:
            //   Setiap send di-log ke pino dengan
            //     `{ from, to, messageLength, targetExists }`
            //   sehingga ada trail kalau owner pakai `!send` untuk
            //   hal sensitif. Log ini ke stdout/stderr Pterodactyl,
            //   bukan ke WhatsApp admin.
            if (!isSuperOwner) {
                return m.reply({ text: '❌ Khusus Super Owner!' });
            }

            if (isGroup) {
                // DM-only — silent ignore di grup supaya admin tidak
                // bocorin nomor/pesan ke member grup lain.
                return;
            }

            if (!fullArgs || !fullArgs.trim()) {
                return m.reply({
                    text:
                        `📌 Format: \`${p}send {nomor}|{pesan}\`\n\n` +
                        `Contoh:\n` +
                        `\`${p}send 6285733370411|halo ini nelsen\`\n\n` +
                        `Nomor tujuan akan di-normalisasi (08xx → 628xx). ` +
                        `Pesan harus mengandung satu karakter (pipe) sebagai ` +
                        `pemisah nomor dan body.`,
                });
            }

            // Pipe split: split pada PIPE PERTAMA saja. Body pesan
            // boleh mengandung `|` (mis. "Halo | saya Nelsen"), tapi
            // pipe pertama adalah pemisah `nomor|body` yang tetap.
            const raw = String(fullArgs).trim();
            const pipeIdx = raw.indexOf('|');
            if (pipeIdx === -1) {
                return m.reply({
                    text:
                        `❌ Format salah. Pakai \`|\` sebagai pemisah nomor dan pesan.\n\n` +
                        `Contoh:\n` +
                        `\`${p}send 6285733370411|halo ini nelsen\``,
                });
            }

            const rawPhone = raw.slice(0, pipeIdx).trim();
            const messageBody = raw.slice(pipeIdx + 1).trim();

            if (!rawPhone || !messageBody) {
                return m.reply({
                    text:
                        `❌ Nomor atau pesan kosong.\n\n` +
                        `Contoh:\n\`${p}send 6285733370411|halo\``,
                });
            }

            // Normalisasi nomor. Auto-rewrite 0xxxxxxxx → 62xxxxxxxx
            // untuk admin yang terbiasa pakai format lokal.
            const normalized = normalizePhone(rawPhone);
            if (!normalized) {
                return m.reply({
                    text:
                        `❌ Nomor tidak valid: \`${rawPhone}\`\n\n` +
                        `Format yang diterima:\n` +
                        `• \`628xxxxxxxxxx\` (internasional)\n` +
                        `• \`08xxxxxxxxxx\` (otomatis dikonversi ke 62)\n\n` +
                        `Minimal 9 digit, maksimal 15 digit (standar E.164).`,
                });
            }

            // Soft cap panjang pesan. WhatsApp text allow sampai ~64k,
            // tapi di atas ±4000 char pesan pecah jadi multiple
            // bubble di recipient chat — UX buruk. Soft-reject lebih
            // awal dengan instruksi yang jelas.
            const MAX_BODY = 4000;
            if (messageBody.length > MAX_BODY) {
                return m.reply({
                    text:
                        `❌ Pesan terlalu panjang (${messageBody.length} karakter). ` +
                        `Maksimal ${MAX_BODY} karakter per kirim.`,
                });
            }

            const targetJid = phoneToJid(normalized);
            const senderNumber = m.senderNumber || '(unknown)';
            const buttonUrl = config.urlButtonSend || 'https://nelsen.web.id';

            // ── Audit log (sebelum attempt). Kalau bot crash di
            // tengah attempt, log entry ini tetap muncul. ──
            log.info({
                cmd: 'send',
                from: senderNumber,
                to: normalized,
                jid: targetJid,
                messageLength: messageBody.length,
            }, 'send: dispatch start');

            // ── Kirim via helper yang sudah terbukti aman. Pakai
            // `sendCtaUrlButton` (dipakai dispatcher orders) — shape
            // persis sama dengan `!sc` di general.js:94-107 yang
            // render normal di chat recipient. Helper ini melakukan
            // pre-flight socket check + fallback text-only kalau
            // CTA gagal (lihat interactiveHelper.js:210). Kalau helper
            // throw (mis. socket null), kita tangkap dan reply
            // error-friendly. ──
            let sendResult;
            try {
                const { sendCtaUrlButton } = require('../utils/interactiveHelper');
                sendResult = await sendCtaUrlButton(Hanz, targetJid, {
                    text: messageBody,
                    footer: config.footerTxt || '> Bot Nelsen Studio',
                    buttons: [{ text: 'Buka Nelsen Studio', url: buttonUrl }],
                });
            } catch (err) {
                log.error({
                    cmd: 'send',
                    from: senderNumber,
                    to: normalized,
                    err: err?.message || String(err),
                }, 'send: dispatch threw');
                return m.reply({
                    text:
                        `❌ Gagal kirim ke ${normalized}. Error: ` +
                        `\`${err?.message || String(err)}\`\n\n` +
                        `Cek koneksi bot / status socket.`,
                });
            }

            log.info({
                cmd: 'send',
                from: senderNumber,
                to: normalized,
                path: sendResult?.path,
                ok: sendResult?.ok,
            }, 'send: dispatch done');

            if (!sendResult?.ok) {
                return m.reply({
                    text:
                        `❌ Gagal kirim ke ${normalized}.\n` +
                        `Path: \`${sendResult?.path || 'unknown'}\`\n` +
                        `Error: \`${sendResult?.error || '-'}\``,
                });
            }

            // Reply konfirmasi ke admin. Memberi tahu path yang
            // dipakai (cta_url vs text-fallback) supaya admin tahu
            // kalau recipient cuma dapat plain text (mungkin button
            // tidak nge-render di versi WA mereka).
            const pathNote = sendResult.path === 'cta_url'
                ? '✅ tombol CTA tampil normal.'
                : `⚠️ path fallback \`${sendResult.path}\` — pesan terkirim tapi tombol mungkin tidak tampil di recipient.`;

            return m.reply({
                text:
                    `✅ Pesan terkirim ke *${normalized}*.\n` +
                    `Path: \`${sendResult.path}\`\n` +
                    `${pathNote}`,
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

/**
 * Normalize an admin-typed phone number to its E.164 digit form.
 *
 * Accepts:        "6285733370411"  (international)
 *                 "085733370411"   (local with leading 0)
 *                 "+62 857-3337-0411"
 *                 "62 857 33370411"
 *
 * Returns the digits-only E.164 form (e.g. "6285733370411"), or
 * `null` when the input is malformed (too short, contains letters,
 * wrong country code, etc.).
 *
 * Rules:
 *   - Strip every non-digit character (`+`, spaces, dashes, parens).
 *   - If the result starts with `0`, replace the leading `0` with
 *     `62` (the Indonesian country code). This matches the project's
 *     primary audience; Indonesian admins naturally type `08xx` and
 *     we should not require them to remember the `62` prefix.
 *   - If the result does NOT start with `62` (after the `0` → `62`
 *     rewrite), reject. We can't tell whether `81xxxxxxxx` is Japan
 *     or a typo of `62`, so we err on the side of safety.
 *   - Minimum length 9 digits, maximum 15 digits (ITU-T E.164 spec).
 */
function normalizePhone(raw) {
    if (raw == null) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) return null;
    let normalized = digits;
    if (normalized.startsWith('0')) {
        normalized = '62' + normalized.slice(1);
    }
    if (!normalized.startsWith('62')) return null;
    if (normalized.length < 9 || normalized.length > 15) return null;
    return normalized;
}

module.exports = handler;
