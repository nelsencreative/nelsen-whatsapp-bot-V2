/**
 * Nelsen Studio commands.
 *
 * Drop-in commands added after the basebot migration:
 *
 *   !product / .product    — list active products (Fitur 3)
 *   !statusweb / .statusweb — show current site status           (Fitur 4)
 *   !status {mode} / .status {mode} — toggle site status         (Fitur 5)
 *   !notif {judul}, {isi}   — admin broadcast to NOTIFY_TARGET_NUMBER (Fitur 7)
 *
 * All commands are `isSuperOwner`-only except `product` which is open
 * to anyone (like `!menu`).
 *
 * Command loader picks up commands by scanning for `case '...':`
 * strings inside the handler function — keep them single-quoted and
 * lowercase so auto-detection works.
 */

const config = require('../config');
const fs = require('fs');
const path = require('path');
const { getImage } = require('../utils/helper');
const {
    listProducts,
    getSiteStatus,
    setSiteStatus,
} = require('../lib/supabase');
const { phoneToJid } = require('../lib/formatter');
const { loadEnv } = require('../lib/env');
const { getLogger } = require('../lib/logger');

const log = getLogger().child({ mod: 'commands.nelsen' });
const p = Array.isArray(config.prefix) ? config.prefix.join(' / ') : config.prefix;

const handler = async (m) => {
    const { command, isSuperOwner, Hanz, sender, args, fullArgs } = m;

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

            products.forEach((p, idx) => {
                lines.push(`${idx + 1}. ${p.name}`);
                lines.push(`Harga: ${formatRupiah(p.price)}`);
                if (p.slug) {
                    lines.push(`Link: https://nelsen.web.id/catalog/${p.slug}`);
                }
                lines.push('');
            });

            lines.push(
                'Mau pesan? Klik tombol di bawah untuk melihat semua produk.',
            );

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
            // Toggle website status. Super-owner only — this mutates
            // the live site_status row.
            if (!isSuperOwner) {
                return m.reply({ text: '❌ Khusus Super Owner!' });
            }

            const arg = String(args[0] || '').trim().toLowerCase();
            // Accept common spellings: "maintance" / "maintenance" /
            // "maintenis" (typos included so the admin doesn't have
            // to be precise). Canonical write is "maintenance".
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
                maintance: 'maintenance',
                off: 'maintenance',
                down: 'maintenance',
                offline: 'maintenance',
            };
            const canonical = map[arg];
            if (!canonical) {
                return m.reply({
                    text:
                        `❌ Mode tidak dikenal: \`${arg}\`\n\n` +
                        `Pakai: \n` +
                        `• \`${p}status operational\`\n` +
                        `• \`${p}status maintenance\``,
                });
            }

            const r = await setSiteStatus(canonical);
            if (!r.ok) {
                log.warn({ err: r.error }, 'setSiteStatus failed');
                return m.reply({ text: `❌ Gagal update status: ${r.error}` });
            }
            return m.reply({
                text:
                    canonical === 'operational'
                        ? '✅ Status website diubah ke *operational*.'
                        : '⚠️ Status website diubah ke *maintenance*.',
            });
        }

        // ────────────────────────────────────────────────────────────
        case 'notif': {
            // Admin broadcast: `!notif {judul}, {isi}`.
            // Sends to NOTIFY_TARGET_NUMBER (personal WhatsApp). Used
            // for promotions / events / anything the admin wants to
            // push to themselves (and from there forward manually if
            // needed).
            if (!isSuperOwner) {
                return m.reply({ text: '❌ Khusus Super Owner!' });
            }

            // Split on the FIRST comma — commas inside the body are
            // preserved verbatim.
            const raw = String(fullArgs || '').trim();
            const sepIdx = raw.indexOf(',');
            if (sepIdx === -1) {
                return m.reply({
                    text:
                        `📌 Format: \`${p}notif {judul}, {isi}\`\n\n` +
                        `Contoh:\n` +
                        `\`${p}notif Special Promo, Yuk segera order di Nelsen Studio!\``,
                });
            }

            const judul = raw.slice(0, sepIdx).trim();
            const isi = raw.slice(sepIdx + 1).trim();

            if (!judul || !isi) {
                return m.reply({
                    text:
                        '❌ Judul dan isi tidak boleh kosong.\n\n' +
                        `Contoh:\n\`${p}notif Special Promo, Yuk order sekarang\``,
                });
            }

            const env = loadEnv();
            const targetJid = phoneToJid(env.notifyTargetNumber);

            // Build the body and send as a plain text message. Image +
            // button is overkill for a personal admin broadcast.
            const body = [
                `📢 *${judul}*`,
                '',
                isi,
                '',
                '> Bot Nelsen Studio',
            ].join('\n');

            try {
                await Hanz.sendMessage(targetJid, { text: body });
                return m.reply({ text: '✅ Notifikasi terkirim.' });
            } catch (err) {
                log.warn({ err: err?.message || String(err) }, '!notif send failed');
                return m.reply({ text: `❌ Gagal kirim: ${err?.message || err}` });
            }
        }
    }
};

/**
 * Local helper — keep a private copy here so commands/nelsen.js does
 * not depend on lib/formatter.js exporting it (it does, but defining
 * the simplest formatter locally makes the file standalone for tests).
 */
function formatRupiah(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 'IDR 0';
    return 'IDR ' + num.toLocaleString('id-ID', {
        maximumFractionDigits: 0,
    });
}

module.exports = handler;
