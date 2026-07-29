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
 * Why we DON'T use sendButtons() / sendInteractiveMessage() (the
 * viewOnceMessage + biz_bot path used by basebot's other helpers):
 *   - sendInteractiveMessage wraps the message in a `viewOnceMessage`
 *     stanza, which makes WhatsApp render it as a "view-once" message
 *     — the chat shows it but the notification banner often gets
 *     suppressed, and on some Android versions the message disappears
 *     from the chat list entirely once tapped.
 *   - sendInteractiveMessage also attaches a `biz_bot: '1'` additional
 *     node to non-group JIDs. That flag is the WhatsApp Business Bot
 *     API marker; on a personal WA account (NOTIFY_TARGET_NUMBER =
 *     6285733370411 in our case) the WA server can silently filter or
 *     reject messages carrying that flag, since the sender isn't
 *     actually a registered Business Bot.
 *   - The bot this migrated from (`whatsapp-bot/`) used
 *     `Hanz.sendMessage(jid, { text, footer, interactive: { buttons: [...] } })`
 *     directly — that path worked. We replicate it here verbatim so
 *     messages render as ordinary chat messages with a tappable button,
 *     not as view-once / business-bot stanzas.
 *
 * Reliability cascade (mirrors the original `sendWithButton`):
 *   1. Path 1: `sendMessage` with `interactive.buttons[name=cta_url]`
 *      — current WhatsApp API, what we WANT to succeed.
 *   2. Path 2 (fallback): legacy `buttons` array with `type: 1` URL
 *      button. Older API but still recognised by all WA clients.
 *   3. Path 3 (final fallback): plain text only — guaranteed to deliver
 *      even if all button APIs reject. The text body always contains
 *      the raw URL (WhatsApp auto-links bare URLs), so the recipient
 *      can still tap through.
 *
 * @param {WASocket} Hanz — the active Baileys socket.
 * @param {string} jid    — destination JID (e.g. `62857...@s.whatsapp.net`).
 * @param {object} content — { text, footer?, buttons: [{ text, url }] }
 * @returns {Promise<{ ok: boolean, path: 'cta_url' | 'buttons' | 'text-fallback', error?: string }>}
 */
async function sendCtaUrlButton(Hanz, jid, content) {
    const { text, footer = '', buttons = [] } = content;
    const firstBtn = buttons[0] || { text: 'Buka', url: 'https://nelsen.web.id' };

    // Path 1: modern `interactive` shape — direct sendMessage, no
    // viewOnceMessage wrapper, no biz_bot node. Proven to work in the
    // previous bot (whatsapp-bot/src/baileys/connection.ts:sendWithButton).
    try {
        await Hanz.sendMessage(jid, {
            text,
            footer,
            interactive: {
                buttons: [
                    {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                            display_text: firstBtn.text,
                            url: firstBtn.url,
                        }),
                    },
                ],
            },
        });
        return { ok: true, path: 'cta_url' };
    } catch (err1) {
        // Path 2: legacy `buttons` shape with `type: 1` URL button.
        try {
            await Hanz.sendMessage(jid, {
                text,
                footer,
                buttons: [
                    {
                        buttonId: `url:${firstBtn.url}`,
                        buttonText: { displayText: firstBtn.text },
                        type: 1,
                    },
                ],
            });
            return {
                ok: true,
                path: 'buttons',
                error: `interactive=${err1?.message || String(err1)}`,
            };
        } catch (err2) {
            // Path 3: plain text — always works.
            try {
                await Hanz.sendMessage(jid, { text });
                return {
                    ok: true,
                    path: 'text-fallback',
                    error: `interactive=${err1?.message || String(err1)}; buttons=${err2?.message || String(err2)}`,
                };
            } catch (err3) {
                return {
                    ok: false,
                    path: 'text-fallback',
                    error: `interactive=${err1?.message || String(err1)}; buttons=${err2?.message || String(err2)}; text=${err3?.message || String(err3)}`,
                };
            }
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

module.exports = {
    sendButtons,
    sendListMessage,
    sendInteractiveMessage,
    sendButtonWithImage,
    sendInteractiveWithImage,
    sendCtaUrlButton,
    sendTextFallback,
};