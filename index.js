/*
Powered By Hanz Ofc

Created 6,6,2026


Support Team

|Wong Hore Team
|TDR Group
|Pancuran Group

Thank To
........


*/
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const chalk = require('chalk');
const figlet = require('figlet');
const Spinnies = require('spinnies');

const config = require('./src/config.js');
const plugins = require('./src/utils/PluginLoader');
const { startHttpServer, stopHttpServer } = require('./src/http/server');
const { startRealtimeListener, stopRealtimeListener } = require('./src/baileys/realtime-listener');
const logger = P({ level: 'silent' });

const _origConsoleLog = console.log;
console.log = function (...args) {
    const str = args[0];
    if (str && typeof str === 'string' && str.startsWith('Closing session')) return;
    if (str && typeof str === 'object' && str?._chains !== undefined) return;
    _origConsoleLog.apply(console, args);
};
const spinnies = new Spinnies({
    color: "blue",
    succeedColor: "green",
    spinner: {
        interval: 120,
        frames: [
            "M", "Me", "Men", "Menu", "Menun", "Menungg", "Menunggu ",
            "Menunggu P", "Menunggu Pes", "Menunggu Pesa", "Menunggu Pesan",
            "Menunggu Pesan.", "Menunggu Pesan..", "Menunggu Pesan...",
            "Menunggu Pesan..", "Menunggu Pesan.", "Menunggu Pesan",
            "Menunggu Pesa", "Menunggu Pes", "Menunggu Pe", "Menunggu P",
            "Menunggu", "Menungg", "Menung", "Menun", "Menu", "Men", "Me", "M"
        ]
    }
});

function question(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

function printBanner() {
    console.clear();
    console.log(
        chalk.cyan(
            figlet.textSync("Hanz Ofc", {
                font: "Standard",
                horizontalLayout: "default",
                verticalLayout: "default",
                width: 80,
                whitespaceBreak: false,
            })
        )
    );
    console.log(chalk.cyan("================================================="));
    console.log(chalk.cyan(" • Powered By Haris Sfx"));
    console.log(chalk.cyan(" • Thanks To Wong Hore Team & O.R.B Group"));
    console.log(chalk.cyan(" • Info Script: https://github.com/harissfx/basebot-wa"));
    console.log(chalk.cyan("================================================="));
    console.log(chalk.yellow("INFO:"), chalk.green("Jika code pairing tidak muncul tekan enter 1-2x lagi\n"));
}

plugins.init();

let phoneNumber = null;
let isFirstConnect = true;

global.conns = global.conns || {};

let pairingRequests = {};

async function startBot(authFolder = config.authFolder, isMain = true, customPhone = null) {
    if (isFirstConnect && isMain) {
        printBanner();
        isFirstConnect = false;
    }

    if (process.env.RESET_SESSION === 'true') {
        console.log(chalk.red('🧹 Menghapus session lama dari Volume...'));
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) { }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
    } catch {
        version = [2, 3000, 1015901307];
    }

    const Hanz = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 120000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
    });

    const instanceKey = path.basename(authFolder);
    global.conns[instanceKey] = Hanz;

    Hanz.ev.on('creds.update', saveCreds);

    const messageHandler = require('./src/handlers/messageHandler');
    Hanz.ev.on('messages.upsert', (m) => {
        messageHandler(Hanz, m, isMain);
    });
    Hanz.ev.on('group-participants.update', (update) => {
        messageHandler.handleGroupParticipants(Hanz, update);
    });

    let pairingReady = null;
    let pairingReadyResolve = null;

    if (!Hanz.authState.creds.registered && isMain) {
        pairingReady = new Promise(resolve => { pairingReadyResolve = resolve; });
    }

    Hanz.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (connection === 'connecting' && pairingReadyResolve) {
            setTimeout(() => {
                if (pairingReadyResolve) {
                    const fn = pairingReadyResolve;
                    pairingReadyResolve = null;
                    fn();
                }
            }, 5000);
        }

        if (connection === 'close') {
            if (isMain) {
                try { spinnies.remove("waiting"); } catch (e) { }
            }

            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode
                : null;

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(chalk.red(`\n[!] Sesi ${instanceKey} keluar/logged out. Hapus folder session...`));
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) { }
                delete global.conns[instanceKey];

                if (isMain) {
                    await delay(3000);
                    return startBot(authFolder, isMain, customPhone);
                }
                return;
            }

            const isNormalRestart = statusCode === 515 || statusCode === 408;
            if (!isNormalRestart && isMain) {
                console.log(chalk.yellow(`[!] Koneksi utama terputus (${statusCode}), mencoba menghubungkan kembali...`));
            }

            await delay(3000);
            startBot(authFolder, isMain, customPhone);

        } else if (connection === 'open') {
            const name = Hanz.user?.name || Hanz.user?.id?.split(':')[0] || 'Unknown';

            if (isMain) {
                console.log(chalk.green(`\nSTATUS: Bot Utama Berhasil Terhubung!`));
                console.log(chalk.white(` • ID/No   : ${name}`));
                console.log(chalk.white(` • Prefix  : ${config.prefix}`));
                console.log(chalk.white(` • Commands: ${plugins.commandList().length} fitur aktif`));

                try { spinnies.remove("waiting"); } catch (e) { }
                spinnies.add("waiting", { text: "." });

                autoLoadJadibot();

                messageHandler.resolveOwnerLids(Hanz).catch(() => { });

                if (config.channelId) {
                    try {
                        await Hanz.newsletterFollow(config.channelId);
                    } catch (e) { }
                }

                try {
                    startHttpServer(Hanz);
                } catch (e) {
                    console.error(chalk.red('[notify] HTTP server failed to start:'), e.message);
                }

                try {
                    const { loadEnv: _loadEnv } = require('./src/lib/env');
                    if (_loadEnv().realtimeEnabled) {
                        startRealtimeListener(Hanz);
                    } else {
                        console.log(chalk.yellow('[notify] BOT_REALTIME_ENABLED=false — skipping Realtime listener'));
                    }
                } catch (e) {
                    console.error(chalk.red('[notify] Realtime listener failed to start:'), e.message);
                }
            } else {
                console.log(chalk.green(`\n[JADIBOT] Clone Bot +${instanceKey} Berhasil Terhubung!`));

                if (config.channelId) {
                    try {
                        await Hanz.newsletterFollow(config.channelId);
                    } catch (e) { }
                }
            }
        }
    });

    if (!Hanz.authState.creds.registered) {
        if (isMain) {
            if (!phoneNumber) {
                const envPhone = process.env.PHONE_NUMBER;
                
                if (envPhone) {
                    phoneNumber = envPhone.replace(/\D/g, '');
                } else {
                    console.log(chalk.cyan('=== WHATSAPP BOT PAIRING ==='));
                    console.log(chalk.white('Format nomor gunakan kode negara, contoh: 6212345xxxxx\n'));

                    const input = await question(chalk.green('📱 Masukkan Nomor WhatsApp: '));
                    phoneNumber = input.replace(/\D/g, '');
                }

                if (!phoneNumber.match(/^\d{10,15}$/)) {
                    console.log(chalk.red('❌ Nomor tidak valid! Aplikasi dihentikan.'));
                    process.exit(1);
                }
            }
            
            console.log(chalk.gray('⏳ Menunggu koneksi ke server WhatsApp...'));
            await pairingReady;
            await delay(3000);

            try {
                const pairingCode = await Hanz.requestPairingCode(phoneNumber);
                console.log(chalk.magenta(`\n[➔] PAIRING CODE ANDA: `) + chalk.white.bold(pairingCode));
                console.log(chalk.gray('Silakan masukkan kode di atas pada menu: Linked Devices -> Link with phone number\n'));
            } catch (err) {
                console.log(chalk.yellow(`[!] Gagal minta pairing code: ${err.message}`));
            }
        } else if (customPhone) {
            setTimeout(async () => {
                try {
                    await delay(3000);
                    const code = await Hanz.requestPairingCode(customPhone);
                    if (pairingRequests[customPhone]?.resolve) {
                        const cb = pairingRequests[customPhone];
                        delete pairingRequests[customPhone];
                        cb.resolve(code);
                    }
                } catch (err) {
                    if (pairingRequests[customPhone]?.reject) {
                        const cb = pairingRequests[customPhone];
                        delete pairingRequests[customPhone];
                        cb.reject(err);
                    }
                }
            }, 1000);
        }
    }

    return Hanz;
}

global.createNewBotInstance = async (targetPhone) => {
    const sessionPath = path.join(__dirname, 'src', 'database', 'jadibot', targetPhone);

    if (fs.existsSync(path.join(sessionPath, 'creds.json'))) {
        const creds = JSON.parse(fs.readFileSync(path.join(sessionPath, 'creds.json'), 'utf-8'));
        if (creds.registered) {

            if (global.conns[targetPhone]) {
                throw new Error("Bot dengan nomor tersebut sudah aktif dan terhubung.");
            }
            await startBot(sessionPath, false, targetPhone);
            throw new Error("Session lama ditemukan dan otomatis dihubungkan kembali tanpa pairing ulang.");
        }
    }

    return new Promise((resolve, reject) => {

        pairingRequests[targetPhone] = { resolve, reject };

        startBot(sessionPath, false, targetPhone).catch(err => {
            delete pairingRequests[targetPhone];
            reject(err);
        });
    });
};

function autoLoadJadibot() {
    const sessionsDir = path.join(__dirname, 'src', 'database', 'jadibot');

    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const folders = fs.readdirSync(sessionsDir);
    folders.forEach(folder => {
        const fullPath = path.join(sessionsDir, folder);
        if (fs.statSync(fullPath).isDirectory()) {

            if (fs.existsSync(path.join(fullPath, 'creds.json'))) {
                console.log(chalk.blue(`[AUTOLOAD] Menghidupkan kembali clone bot: +${folder}`));
                startBot(fullPath, false, folder).catch(() => { });
            }
        }
    });
}

process.on('uncaughtException', (err) => console.error(chalk.red('[Error Uncaught]:'), err.message));
process.on('unhandledRejection', (reason) => console.error(chalk.red('[Error Rejection]:'), reason));

process.on('SIGTERM', async () => {
    console.log(chalk.yellow('\n[shutdown] SIGTERM received — closing notifier…'));
    await stopRealtimeListener().catch(() => {});
    stopHttpServer();
    setTimeout(() => process.exit(0), 500).unref();
});
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n[shutdown] SIGINT received — closing notifier…'));
    await stopRealtimeListener().catch(() => {});
    stopHttpServer();
    setTimeout(() => process.exit(0), 500).unref();
});

startBot().catch((err) => {
    console.error(chalk.red('[Fatal Error]:'), err);
    process.exit(1);
});
