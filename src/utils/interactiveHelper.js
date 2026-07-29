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
 * On Baileys' `nativeFlowMessage` reliability:
 *   - The `cta_url` button type is the modern way to attach a link
 *     button. `buttonParamsJson` is JSON-stringified with `display_text`
 *     and `url`. We also include `merchant_url` because some Baileys
 *     versions require both fields to render the button correctly.
 *   - The TEXT body ALWAYS contains the raw URL too — WhatsApp auto-
 *     links bare URLs, so the recipient can ALWAYS tap the link even
 *     if the native button fails to render.
 *   - This function returns a structured result so the caller can log
 *     which path succeeded.
 *
 * @param {WASocket} Hanz — the active Baileys socket.
 * @param {string} jid    — destination JID (e.g. `62857...@s.whatsapp.net`).
 * @param {object} content — { text, footer?, buttons: [{ text, url }] }
 * @returns {Promise<{ ok: boolean, path: 'cta_url' | 'text-fallback', error?: string }>}
 */
async function sendCtaUrlButton(Hanz, jid, content) {
    const { text, footer = '', buttons = [] } = content;

    try {
        const interactiveMsg = proto.Message.InteractiveMessage.fromObject({
            body: { text },
            footer: { text: footer },
            header: { hasMediaAttachment: false },
            nativeFlowMessage: {
                buttons: buttons.map(btn => ({
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.text,
                        url: btn.url,
                        merchant_url: btn.url,
                    })
                })),
                messageParamsJson: ''
            }
        });

        await relayInteractive(Hanz, jid, buildMessage(jid, interactiveMsg), 'cta_url');
        return { ok: true, path: 'cta_url' };
    } catch (err) {
        // Native button failed to render — fall back to plain text.
        // The text body contains the URL as plain text, so WhatsApp
        // auto-links it and the recipient can still tap.
        try {
            await Hanz.sendMessage(jid, { text });
            return { ok: true, path: 'text-fallback', error: err?.message || String(err) };
        } catch (err2) {
            return {
                ok: false,
                path: 'text-fallback',
                error: `cta_url=${err?.message || String(err)}; text=${err2?.message || String(err2)}`,
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

module.exports = {
    sendButtons,
    sendListMessage,
    sendInteractiveMessage,
    sendButtonWithImage,
    sendInteractiveWithImage,
    sendCtaUrlButton,
    sendTextFallback,
};