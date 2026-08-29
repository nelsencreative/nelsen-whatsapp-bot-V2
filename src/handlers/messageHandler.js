const fs = require('fs');
const config = require('../config');

if (global.botMode === undefined) global.botMode = config.botMode || 'public';
const plugins = require('../utils/PluginLoader');
const chalk = require('chalk');
const readline = require('readline');
const { getContentType } = require('@whiskeysockets/baileys');
const { sendButtons, sendListMessage, sendInteractiveMessage, sendButtonWithImage, sendInteractiveWithImage } = require('../utils/interactiveHelper');
const { fakeOrder } = require('../utils/fquoted');

const superOwnerLidCache = new Set();
const coOwnerLidCache = new Set();

const COOLDOWN_MS = 5000;
const COOLDOWN_EXEMPT = new Set([
    'menu', 'ping',
    'generalmenu', 'ownermenu', 'ffmpegmenu',
    'downloadmenu', 'toolsmenu', 'jadibotmenu',
    'funmenu', 'groupmenu',
    'afk', 'welcome', 'goodbye', 'antilink',
]);
const cooldownMap = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of cooldownMap) {
        if (now - timestamp > COOLDOWN_MS) cooldownMap.delete(key);
    }
}, 5 * 60 * 1000);

async function resolveOwnerLids(Hanz) {
    const resolveList = [
        { numbers: [].concat(config.superOwner), cache: superOwnerLidCache, label: 'SUPER' },
        { numbers: [].concat(config.coOwner || []), cache: coOwnerLidCache, label: 'CO' },
    ];
    for (const { numbers, cache, label } of resolveList) {
        for (const nomor of numbers.map(n => n.replace(/\D/g, ''))) {
            try {
                const [result] = await Hanz.onWhatsApp(nomor);
                if (result?.exists && result?.lid) {
                    const lidNum = result.lid.replace(/\D/g, '').replace(/@.+$/, '').split(':')[0];
                    cache.add(lidNum);
                    console.log(chalk.cyan(`[${label}-OWNER-LID] ${nomor} -> ${lidNum}@lid`));
                }
            } catch (e) {
                console.log(chalk.yellow(`[${label}-OWNER-LID] Gagal resolve ${nomor}: ${e.message}`));
            }
        }
    }
}

function extractMessageText(message) {
    if (!message) return null;
    const type = getContentType(message);
    switch (type) {
        case 'conversation': return message.conversation;
        case 'extendedTextMessage': return message.extendedTextMessage?.text;
        case 'imageMessage': return message.imageMessage?.caption;
        case 'videoMessage': return message.videoMessage?.caption;
        case 'buttonsResponseMessage': return message.buttonsResponseMessage?.selectedButtonId;
        case 'listResponseMessage': return message.listResponseMessage?.singleSelectReply?.selectedRowId;
        case 'templateButtonReplyMessage': return message.templateButtonReplyMessage?.selectedId;
        case 'interactiveResponseMessage': {
            const paramsJson = message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
            if (paramsJson) {
                try {
                    const parsed = JSON.parse(paramsJson);
                    return parsed.id;
                } catch {
                    return null;
                }
            }
            return null;
        }
        default: return null;
    }
}

function isGroup(jid) { return jid.endsWith('@g.us'); }
function isFromMe(msg) { return msg.key.fromMe; }

function getSenderNumber(sender, msg) {
    const candidates = [
        msg?.key?.senderPn,
        msg?.key?.participantAlt,
        msg?.key?.remoteJidAlt,
        msg?.key?.participant,
        msg?.key?.remoteJid,
        sender,
    ];
    const raw = candidates.find(v => v && !v.endsWith('@lid')) || candidates.find(v => v) || '';
    return raw.replace(/\D/g, '').replace(/@.+$/, '').split(':')[0];
}

function isSuperOwner(sender, msg) {
    const superOwners = [].concat(config.superOwner).map(n => n.replace(/\D/g, ''));
    const senderNumber = getSenderNumber(sender, msg);
    const fromMe = msg?.key?.fromMe || false;
    return superOwners.some(n => n === senderNumber) || superOwnerLidCache.has(senderNumber) || fromMe;
}

function isCoOwner(sender, msg) {
    const coOwners = [].concat(config.coOwner || []).map(n => n.replace(/\D/g, ''));
    const senderNumber = getSenderNumber(sender, msg);
    return coOwners.some(n => n === senderNumber) || coOwnerLidCache.has(senderNumber);
}

function isOwner(sender, msg) {
    return isSuperOwner(sender, msg) || isCoOwner(sender, msg);
}

function parseCommand(text) {
    const { prefix } = config;
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];

    const leading = text.charAt(0);
    if (prefixes.includes(leading)) {
        const args = text.slice(1).trim().split(/ +/);
        const name = args.shift().toLowerCase();
        return { name, args, fullArgs: args.join(' '), raw: text, hasPrefix: true, prefixChar: leading };
    }

    const words = text.trim().split(/ +/);
    const name = words[0].toLowerCase();
    if (plugins.has(name)) {
        const args = words.slice(1);
        return { name, args, fullArgs: args.join(' '), raw: text, hasPrefix: false };
    }

    return null;
}

async function handleMessages(Hanz, m, isMain = true) {
    for (const msg of m.messages) {
        if (!msg.message) continue;

        const sender = msg.key.remoteJid;

        // =========================================================================
        // ⛔ ABSOLUTE FILTER GRUP: BOT CUMA RESPON DI PESAN PRIBADI (PM/JAPRI) ⛔
        // =========================================================================
        if (isGroup(sender)) continue;

        const fromMe = isFromMe(msg);
        const checkSuperOwner = isSuperOwner(sender, msg);
        const checkCoOwner = isCoOwner(sender, msg);
        const checkOwner = isOwner(sender, msg); // True jika Super Owner, Co-Owner, atau Bot Sendiri

        // =========================================================================
        // 🔒 CHECK MODE SELF VS PUBLIC
        // - Mode 'self'   : Cuma Owner, Super Owner, Co-Owner yang bisa akses AI & Command.
        // - Mode 'public' : Semua orang di Pesan Pribadi (PM) bisa akses.
        // =========================================================================
        if (!fromMe && global.botMode === 'self' && !checkOwner) continue;

        const text = extractMessageText(msg.message);
        if (!text) continue;

        const senderNum = getSenderNumber(sender, msg);
        const cleanSenderJid = senderNum ? `${senderNum}@s.whatsapp.net` : sender;

        if (!fromMe) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);

            console.log(
                chalk.blue(`[INBOUND PM] `) +
                chalk.cyan(cleanSenderJid) +
                chalk.white(` (${msg.pushName || 'User'}): ${text}`)
            );
        }

        if (config.autoRead) await Hanz.readMessages([msg.key]);
        if (config.autoTyping) await Hanz.sendPresenceUpdate('composing', sender);

        // =========================================================================
        // 🚀 FORWARD PESAN KE N8N WEBHOOK (N8N 9ROUTER AI & COMMAND CONTROL)
        // Format JID dipastikan selalu @s.whatsapp.net agar balasan n8n presisi
        // =========================================================================
        if (!fromMe) {
            const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || 'https://n8n.nelsen.web.id/webhook/wa-inbound';
            fetch(n8nWebhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from: cleanSenderJid,
                    text: text,
                    pushName: msg.pushName || 'User',
                    isOwner: checkOwner,
                    isSuperOwner: checkSuperOwner
                })
            }).catch(err => console.error(chalk.red('[N8N-WEBHOOK-ERROR]:'), err.message));
        }

        // =========================================================================
        // 🛠️ EKSEKUSI COMMAND LOKAL (JIKA DITEMUKAN PLUGIN LOKAL)
        // =========================================================================
        const command = parseCommand(text);

        if (command) {
            // Handle built-in commands directly (without plugins)
            const builtInCommand = async () => {
                const cmd = command.name;
                if (cmd === 'vercel') {
                    const vercelText = `▲ *VERCEL DEPLOYMENT STATUS*\n\n📌 *Project:* nelsen-dashboard\n⚡ *State:* READY\n🔗 *URL:* https://nelsen-dashboard.vercel.app\n⏱ *Created:* ${new Date().toLocaleString('id-ID')}`;
                    await Hanz.sendMessage(sender, { text: vercelText }, { quoted: msg });
                    return true;
                } else if (cmd === 'product') {
                    const productText = `📦 *DAFTAR PRODUK*\n\n1. *Produk A* - Rp100,000\n2. *Produk B* - Rp200,000\n3. *Produk C* - Rp300,000\n\n*Note:* Fetch from Supabase via n8n`;
                    await Hanz.sendMessage(sender, { text: productText }, { quoted: msg });
                    return true;
                } else if (cmd === 'users') {
                    const usersText = `👥 *DATA USER*\n\n1. *User 1* (user1@email.com) - Active\n2. *User 2* (user2@email.com) - Active\n3. *User 3* (user3@email.com) - Inactive\n\n*Note:* Fetch from Supabase via n8n`;
                    await Hanz.sendMessage(sender, { text: usersText }, { quoted: msg });
                    return true;
                } else if (cmd === 'github') {
                    const githubText = `🐙 *GITHUB ACTION STATUS*\n\n📌 *Workflow:* CI/CD\nStatus: ✅ Completed\nConclusion: 🎉 Success\nAccount/Branch: main\nCommit: Latest commit\n\n*Note:* Fetch from GitHub API via n8n`;
                    await Hanz.sendMessage(sender, { text: githubText }, { quoted: msg });
                    return true;
                } else if (cmd === 'session') {
                    const sessionText = `📁 *SESSION BACKUP*\n\nFile backup session telah diambil.\n\n*Note:* Fetch from bot via n8n`;
                    await Hanz.sendMessage(sender, { text: sessionText }, { quoted: msg });
                    return true;
                }
                return false;
            };

            const isBuiltIn = await builtInCommand();
            if (isBuiltIn) {
                continue;
            }

            const handler = plugins.get(command.name);

            if (handler) {
                if (!checkSuperOwner && !checkOwner && !COOLDOWN_EXEMPT.has(command.name)) {
                    const cooldownKey = `${sender}:${command.name}`;
                    const lastUsed = cooldownMap.get(cooldownKey) || 0;
                    const remaining = COOLDOWN_MS - (Date.now() - lastUsed);

                    if (remaining > 0) {
                        await Hanz.sendMessage(sender, {
                            text: `⏳ Sabar dulu! Tunggu *${(remaining / 1000).toFixed(1)} detik* lagi sebelum pakai command ini.`
                        }, { quoted: msg });
                        continue;
                    }

                    cooldownMap.set(cooldownKey, Date.now());
                }

                const cmdArgs = command.args.length ? ' ' + command.args.join(' ') : '';

                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);

                console.log(
                    chalk.green(`[EXECUTE] `) +
                    chalk.yellow(`${command.name}${cmdArgs}`)
                );

                try {
                    await handler({
                        Hanz, msg, sender,
                        senderNumber: senderNum,
                        pushname: msg.pushName || 'Kak',
                        isGroup: false,
                        isOwner: checkOwner,
                        isSuperOwner: checkSuperOwner,
                        isCoOwner: checkCoOwner,
                        command, text,
                        fakeOrder,
                        isMain,
                        reply: (content) => Hanz.sendMessage(sender, content, { quoted: msg }),
                        replyFake: (content) => Hanz.sendMessage(sender, content, { quoted: fakeOrder }),
                        send: (content) => Hanz.sendMessage(sender, content),
                        sendButtons: (content) => sendButtons(Hanz, sender, content),
                        sendList: (content) => sendListMessage(Hanz, sender, content),
                        sendInteractive: (content) => sendInteractiveMessage(Hanz, sender, content),
                        sendButtonWithImage: (content) => sendButtonWithImage(Hanz, sender, content),
                        sendInteractiveWithImage: (content) => sendInteractiveWithImage(Hanz, sender, content),
                        react: (emoji) => Hanz.sendMessage(sender, { react: { text: emoji, key: msg.key } }),
                    });
                } catch (err) {
                    readline.clearLine(process.stdout, 0);
                    readline.cursorTo(process.stdout, 0);

                    console.error(
                        chalk.red(`[RUN-ERROR] `) +
                        chalk.yellow(`[${command.name}]: `) +
                        chalk.red(err.message)
                    );
                    await Hanz.sendMessage(sender, { text: '❌ Terjadi kesalahan saat menjalankan perintah.' });
                }
            }
        }

        if (config.autoTyping) await Hanz.sendPresenceUpdate('paused', sender);
    }
}

async function handleGroupParticipants(Hanz, update) {
    return;
}

module.exports = handleMessages;
module.exports.resolveOwnerLids = resolveOwnerLids;
module.exports.handleGroupParticipants = handleGroupParticipants;
