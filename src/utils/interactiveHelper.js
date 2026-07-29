const { generateWAMessageFromContent, proto, isJidGroup } = require('@whiskeysockets/baileys');

function buildInteractiveNodes(buttonType = 'mixed') {
    return [{
        tag: 'biz',
        attrs: {},
        content: [{
            tag: 'interactive',
            attrs: { type: 'native_flow', v: '1' },
            content: [{ tag: 'native_flow', attrs: { v: '9', name: buttonType } }]
        }]
    }];
}

function buildContextInfo(quoted, extra = {}) {
    const base = {};

    if (quoted) {
        try {
            const { key } = quoted;
            base.stanzaId      = key.id;
            base.participant   = key.participant || key.remoteJid;
            base.quotedMessage = quoted.message;
        } catch { /* skip */ }
    }

    const merged = { ...base, ...extra };
    return Object.keys(merged).length ? merged : null;
}

function buildMessage(jid, interactiveMsg) {
    return generateWAMessageFromContent(jid, proto.Message.fromObject({
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: interactiveMsg,
            }
        }
    }), { userJid: jid });
}

async function relayInteractive(Hanz, jid, message, buttonType) {
    const additionalNodes = buildInteractiveNodes(buttonType);
    if (!isJidGroup(jid)) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    return Hanz.relayMessage(jid, message.message, { messageId: message.key.id, additionalNodes });
}

async function sendButtons(Hanz, jid, content) {
    const { text, footer = '', buttons = [], quoted, contextInfo: extra = {} } = content;
    const contextInfo = buildContextInfo(quoted, extra);

    const interactiveMsg = proto.Message.InteractiveMessage.fromObject({
        body: { text },
        footer: { text: footer },
        header: { hasMediaAttachment: false },
        nativeFlowMessage: {
            buttons: buttons.map(btn => ({
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id })
            })),
            messageParamsJson: ''
        },
        ...(contextInfo ? { contextInfo } : {})
    });

    return relayInteractive(Hanz, jid, buildMessage(jid, interactiveMsg), 'quick_reply');
}

async function sendListMessage(Hanz, jid, content) {
    const { text, footer = '', buttonTitle = '📂 Pilih', sections = [], quoted, contextInfo: extra = {} } = content;
    const contextInfo = buildContextInfo(quoted, extra);

    const interactiveMsg = proto.Message.InteractiveMessage.fromObject({
        body: { text },
        footer: { text: footer },
        header: { hasMediaAttachment: false },
        nativeFlowMessage: {
            buttons: [{
                name: 'single_select',
                buttonParamsJson: JSON.stringify({
                    title: buttonTitle,
                    sections: sections.map(sec => ({
                        title: sec.title,
                        rows: sec.rows.map(row => ({
                            header: row.title,
                            title: row.title,
                            description: row.description || '',
                            id: row.id
                        }))
                    }))
                })
            }],
            messageParamsJson: ''
        },
        ...(contextInfo ? { contextInfo } : {})
    });

    return relayInteractive(Hanz, jid, buildMessage(jid, interactiveMsg), 'single_select');
}

async function sendInteractiveMessage(Hanz, jid, content) {
    const { text, footer = '', buttons = [], quoted, contextInfo: extra = {} } = content;
    const contextInfo = buildContextInfo(quoted, extra);

    const interactiveMsg = proto.Message.InteractiveMessage.fromObject({
        body: { text },
        footer: { text: footer },
        header: { hasMediaAttachment: false },
        nativeFlowMessage: { buttons, messageParamsJson: '' },
        ...(contextInfo ? { contextInfo } : {})
    });

    return relayInteractive(Hanz, jid, buildMessage(jid, interactiveMsg), 'mixed');
}

async function sendButtonWithImage(Hanz, jid, content) {
    const { text, footer = '', buttons = [], imageUrl, quoted, contextInfo: extra = {} } = content;
    const contextInfo = buildContextInfo(quoted, extra);

    try {
        const axios = require('axios');
        const { prepareWAMessageMedia } = require('@whiskeysockets/baileys');

        const { data } = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const media = await prepareWAMessageMedia({ image: Buffer.from(data) }, { upload: Hanz.waUploadToServer });

        const interactiveMsg = proto.Message.InteractiveMessage.fromObject({
            body: { text },
            footer: { text: footer },
            header: { hasMediaAttachment: true, ...media },
            nativeFlowMessage: {
                buttons: buttons.map(btn => ({
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id })
                })),
                messageParamsJson: ''
            },
            ...(contextInfo ? { contextInfo } : {})
        });

        return relayInteractive(Hanz, jid, buildMessage(jid, interactiveMsg), 'quick_reply');
    } catch (err) {
        console.error('Error button with image, fallback ke sendButtons:', err.message);
        return sendButtons(Hanz, jid, { text, footer, buttons, quoted });
    }
}

async function sendInteractiveWithImage(Hanz, jid, content) {
    const { text, footer = '', buttons = [], imageSource, quoted, contextInfo: extra = {} } = content;
    const contextInfo = buildContextInfo(quoted, extra);

    try {
        const { prepareWAMessageMedia } = require('@whiskeysockets/baileys');

        let mediaInput;
        if (Buffer.isBuffer(imageSource)) {
            mediaInput = { image: imageSource };
        } else if (imageSource?.url) {
            const axios = require('axios');
            const { data } = await axios.get(imageSource.url, { responseType: 'arraybuffer' });
            mediaInput = { image: Buffer.from(data) };
        } else {
            throw new Error('imageSource harus Buffer atau { url: "..." }');
        }

        const media = await prepareWAMessageMedia(mediaInput, { upload: Hanz.waUploadToServer });

        const interactiveMsg = proto.Message.InteractiveMessage.fromObject({
            body: { text },
            footer: { text: footer },
            header: { hasMediaAttachment: true, ...media },
            nativeFlowMessage: { buttons, messageParamsJson: '' },
            ...(contextInfo ? { contextInfo } : {})
        });

        return relayInteractive(Hanz, jid, buildMessage(jid, interactiveMsg), 'mixed');
    } catch (err) {
        console.error('Error sendInteractiveWithImage, fallback ke sendInteractive:', err.message);
        return sendInteractiveMessage(Hanz, jid, { text, footer, buttons, quoted });
    }
}

/**
 * Send a text message with one or more `cta_url` (URL-link) buttons.
 *
 * Used by the notification dispatcher to attach a "Buka Dashboard" /
 * "Lihat Invoice" CTA to order + invoice messages.
 *
 * Implementation note — why we use `sendInteractiveMessage` directly:
 *   The basebot's `!sc` command (src/commands/general.js:94-107) uses
 *   `m.sendInteractive({ buttons: [{ name: 'cta_url', buttonParamsJson:
 *   JSON.stringify({ display_text, url }) }, ...] })` and the
 *   "Buka GitHub" button renders correctly in the recipient's chat,
 *   tappable to open https://github.com/harissfx/basebot-wa.
 *
 *   That path is `sendInteractiveMessage(Hanz, jid, { text, footer,
 *   buttons })` — it relays the raw `nativeFlowMessage` payload via
 *   `Hanz.relayMessage`. We use the SAME call so we get the SAME
 *   render behaviour. Earlier attempts that bypassed this helper and
 *   used `Hanz.sendMessage(jid, { interactive: {...} })` directly came
 *   back as text-only — the modern protocol shape is recognised by
 *   the server but the legacy `nativeFlowMessage` over `relayMessage`
 *   is what basebot has shipped reliably.
 *
 * @param {WASocket} Hanz — the active Baileys socket.
 * @param {string} jid    — destination JID (e.g. `62857...@s.whatsapp.net`).
 * @param {object} content — { text, footer?, buttons: [{ text, url }] }
 * @returns {Promise<{ ok: boolean, path: 'cta_url' | 'text-fallback', error?: string }>}
 */
async function sendCtaUrlButton(Hanz, jid, content) {
    const { text, footer = '', buttons = [] } = content;
    const firstBtn = buttons[0] || { text: 'Buka', url: 'https://nelsen.web.id' };

    // Pre-flight: if the socket itself is missing/broken, every send will
    // throw with "Cannot read properties of undefined (reading 'relayMessage')"
    // or similar. Fail fast with a clear message so the dispatcher's log
    // shows the real cause instead of "ok:false, path:text-fallback".
    if (!Hanz || typeof Hanz.relayMessage !== 'function') {
        return {
            ok: false,
            path: 'no-socket',
            error: `Hanz socket invalid: ${typeof Hanz} (relayMessage=${typeof Hanz?.relayMessage})`,
        };
    }
    if (!jid || typeof jid !== 'string' || !jid.includes('@')) {
        return {
            ok: false,
            path: 'no-jid',
            error: `Invalid jid: ${JSON.stringify(jid)}`,
        };
    }

    // Shape the button exactly like `!sc` does — the proven-working
    // pattern. Do NOT add `merchant_url` or extra fields; the WA server
    // rejects malformed buttonParamsJson.
    const nativeButtons = [
        {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text: firstBtn.text,
                url: firstBtn.url,
            }),
        },
    ];

    try {
        // share sendInteractiveMessage's exact implementation: builds
        // the proto.Message, attaches `biz_bot` and `interactive` nodes,
        // and relays via `Hanz.relayMessage`. Same as `!sc` does.
        await sendInteractiveMessage(Hanz, jid, {
            text,
            footer,
            buttons: nativeButtons,
        });
        return { ok: true, path: 'cta_url' };
    } catch (err) {
        // CTA path failed — try plain text. Capture BOTH errors so the
        // dispatcher's log shows the full picture (not just the second
        // one which often hides the real cause).
        const ctaErr = err?.message || String(err);
        try {
            await Hanz.sendMessage(jid, { text });
            return { ok: true, path: 'text-fallback', error: ctaErr };
        } catch (err2) {
            const textErr = err2?.message || String(err2);
            return {
                ok: false,
                path: 'text-fallback',
                error: `cta_url=[${ctaErr}]; text=[${textErr}]`,
            };
        }
    }
}

/**
 * Send a plain-text message — no button, no media.
 *
 * Used by deploy_* notifications (no CTA needed). Returns a uniform
 * shape so the dispatcher can log success/failure consistently.
 */
async function sendTextFallback(Hanz, jid, text) {
    try {
        await Hanz.sendMessage(jid, { text });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/**
 * Send a `cta_url` button WITH an image header in one message.
 *
 * Used by checkout/invoice notifications that need both a banner image
 * (e.g. `src/media/banner.png`) and a clickable button pointing to
 * https://nelsen.web.id or the relevant order/invoice page.
 *
 * Behaviour:
 *   - Loads the image once via `prepareWAMessageMedia` and embeds it
 *     in `header: { hasMediaAttachment: true, ...media }` — same shape
 *     as the proven `sendInteractiveWithImage` path used by `!menu`.
 *   - The button is shaped exactly like `sendCtaUrlButton`:
 *     `{ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text, url }) }`.
 *   - On any failure (image upload error, network error, malformed
 *     payload), falls back to `sendCtaUrlButton` (text + button, no
 *     image). If THAT also fails, falls back to plain `sendMessage`.
 *
 * @param {WASocket} Hanz
 * @param {string} jid
 * @param {object} content — {
 *     text, footer?, imageSource: Buffer | { url }, buttons: [{ text, url }]
 *   }
 * @returns {Promise<{ ok, path: 'cta_url_with_image' | 'cta_url' | 'text-fallback' | 'no-socket' | 'no-jid', error? }>}
 */
async function sendCtaUrlButtonWithImage(Hanz, jid, content) {
    const { text, footer = '', imageSource, buttons = [] } = content;
    const firstBtn = buttons[0] || { text: 'Buka', url: 'https://nelsen.web.id' };

    // Pre-flight (same as sendCtaUrlButton) so a stale socket surfaces a
    // clear `no-socket` instead of two deep exception traces.
    if (!Hanz || typeof Hanz.relayMessage !== 'function') {
        return {
            ok: false,
            path: 'no-socket',
            error: `Hanz socket invalid: ${typeof Hanz}`,
        };
    }
    if (!jid || typeof jid !== 'string' || !jid.includes('@')) {
        return { ok: false, path: 'no-jid', error: `Invalid jid: ${JSON.stringify(jid)}` };
    }
    if (!imageSource) {
        // No image — defer to the plain cta_url path so callers don't
        // have to branch.
        return sendCtaUrlButton(Hanz, jid, { text, footer, buttons });
    }

    const nativeButtons = [
        {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text: firstBtn.text,
                url: firstBtn.url,
            }),
        },
    ];

    try {
        const { prepareWAMessageMedia } = require('@whiskeysockets/baileys');

        let mediaInput;
        if (Buffer.isBuffer(imageSource)) {
            mediaInput = { image: imageSource };
        } else if (imageSource?.url) {
            const axios = require('axios');
            const { data } = await axios.get(imageSource.url, { responseType: 'arraybuffer' });
            mediaInput = { image: Buffer.from(data) };
        } else {
            throw new Error('imageSource harus Buffer atau { url: "..." }');
        }

        const media = await prepareWAMessageMedia(mediaInput, { upload: Hanz.waUploadToServer });

        const interactiveMsg = proto.Message.InteractiveMessage.fromObject({
            body: { text },
            footer: { text: footer },
            header: { hasMediaAttachment: true, ...media },
            nativeFlowMessage: { buttons: nativeButtons, messageParamsJson: '' },
        });

        await relayInteractive(Hanz, jid, buildMessage(jid, interactiveMsg), 'cta_url');
        return { ok: true, path: 'cta_url_with_image' };
    } catch (err) {
        // Image path failed — try text+button, then plain text.
        const imgErr = err?.message || String(err);
        try {
            const r = await sendCtaUrlButton(Hanz, jid, { text, footer, buttons });
            return {
                ok: r.ok,
                path: r.path,
                error: imgErr,
            };
        } catch (err2) {
            try {
                await Hanz.sendMessage(jid, { text });
                return { ok: true, path: 'text-fallback', error: imgErr };
            } catch (err3) {
                return {
                    ok: false,
                    path: 'text-fallback',
                    error: `image=[${imgErr}]; cta_url=[${err2?.message || String(err2)}]; text=[${err3?.message || String(err3)}]`,
                };
            }
        }
    }
}

module.exports = {
    sendButtons,
    sendListMessage,
    sendInteractiveMessage,
    sendButtonWithImage,
    sendInteractiveWithImage,
    sendCtaUrlButton,
    sendCtaUrlButtonWithImage,
    sendTextFallback,
};