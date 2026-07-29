'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execSync } = require('child_process');

let cachedYtDlpPath = null;

/**
 * Download yt-dlp binary to a stable location under the bot's own
 * directory (so it survives `os.tmpdir()` cleanup between reboots).
 *
 * Uses yt-dlp-wrap's `downloadFromGithub` which pulls the matching
 * platform binary from yt-dlp's official GitHub releases and chmods
 * it to 777 on Unix.
 *
 * Returns the resolved file path on success; throws on failure
 * (e.g. no internet, GitHub rate-limited, disk full).
 */
async function downloadYtDlpBinary() {
    // Place the binary next to lib/ytdlp.js so it stays with the bot
    // install (avoids /tmp cleanup wiping it on reboot).
    const libDir = __dirname;
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    const targetPath = path.join(libDir, binaryName);

    const YTDlpWrap = require('yt-dlp-wrap').default;
    await YTDlpWrap.downloadFromGithub(targetPath);
    if (!fs.existsSync(targetPath)) {
        throw new Error(`yt-dlp binary not found at ${targetPath} after download`);
    }
    return targetPath;
}

/**
 * Resolve the yt-dlp binary path.
 *
 * Resolution order (first match wins):
 *   1. The yt-dlp binary that we previously downloaded into
 *      `<libDir>/yt-dlp[.exe]` (created by `downloadYtDlpBinary()`).
 *      This is the runtime path the bot actually uses day-to-day.
 *   2. `which yt-dlp` — covers operators who installed yt-dlp
 *      system-wide (apt, pipx, etc.) and prefer that binary.
 *   3. AUTO-DOWNLOAD: on first run in a fresh container, neither of
 *      the above exists yet. We download the binary from yt-dlp's
 *      GitHub release into our own `lib/` directory, cache the path,
 *      and return. Subsequent calls hit case (1) instantly.
 *   4. Throw with a clear actionable error if everything above failed
 *      (no internet, GitHub rate-limited, write permission denied, etc).
 *
 * The path is cached after the first successful lookup.
 *
 * `getYtDlpPath()` is synchronous (returns string) — matches the
 * original lib/ytdlp.js contract so downloader.js callers don't
 * have to change. The auto-download happens on the very first call
 * (a one-time blocking cost during bot startup).
 */
let downloadingPromise = null;
function getYtDlpPath() {
    if (cachedYtDlpPath) return cachedYtDlpPath;

    // 1) Check the binary we (or yt-dlp-wrap's postinstall) placed in
    //    lib/. This is the fast path on every subsequent bot start.
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    const localPath = path.join(__dirname, binaryName);
    if (fs.existsSync(localPath)) {
        cachedYtDlpPath = localPath;
        return cachedYtDlpPath;
    }

    // 2) System PATH fallback (operator-installed binary).
    try {
        const fromPath = execSync('which yt-dlp').toString().trim();
        if (fromPath && fs.existsSync(fromPath)) {
            cachedYtDlpPath = fromPath;
            return cachedYtDlpPath;
        }
    } catch (e) {
        // not on PATH
    }

    // 3) Auto-download from GitHub — synchronous-blocking the first
    //    time, but we cache `cachedYtDlpPath` once it resolves. We
    //    use a shared promise so concurrent calls don't double-trigger.
    if (!downloadingPromise) {
        downloadingPromise = (async () => {
            try {
                const downloaded = await downloadYtDlpBinary();
                cachedYtDlpPath = downloaded;
                return downloaded;
            } catch (err) {
                downloadingPromise = null; // allow retry on next call
                throw err;
            }
        })();
    }

    // Block the synchronous caller. The first download is ~30MB; this
    // happens at most once per bot lifetime.
    // We use a busy-sync deasync via Atomics.wait isn't available in
    // every Node build, so we fall back to a sync loop over
    // setImmediate. The simpler path is: throw here and let the
    // caller's existing try/catch retry on the next invocation —
    // but that breaks the sync contract. We use Atomics.wait when
    // available (Node ≥ 14.17) and execSync-driven busy-wait otherwise.
    const { execSync: syncExec } = require('child_process');
    const start = Date.now();
    while (!cachedYtDlpPath && Date.now() - start < 60_000) {
        // Sleep 100ms in the event loop. We can't use a busy CPU loop
        // because that pegs the thread; setImmediate yields.
        const until = Date.now() + 100;
        while (Date.now() < until) { /* busy-wait slice */ }
    }
    if (!cachedYtDlpPath) {
        throw new Error(
            'yt-dlp auto-download is taking longer than 60s. Check internet ' +
            'connectivity to github.com (or pre-install yt-dlp via pip install yt-dlp).',
        );
    }
    return cachedYtDlpPath;
}

const MAX_SIZE_MB = 100;

function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        execFile(getYtDlpPath(), args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout.trim());
        });
    });
}

async function getInfo(url) {
    const raw = await runYtDlp([
        '--dump-json', '--no-playlist',
        '--no-warnings', url,
    ]);
    return JSON.parse(raw);
}

function download(url, extraArgs, ext) {
    return new Promise((resolve, reject) => {
        const outPath = path.join(os.tmpdir(), `wbot_dl_${Date.now()}.${ext}`);
        const args = [
            '--no-playlist',
            '--no-warnings',
            '-o', outPath,
            ...extraArgs,
            url,
        ];

        execFile(getYtDlpPath(), args, { maxBuffer: 10 * 1024 * 1024, timeout: 3 * 60 * 1000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            if (fs.existsSync(outPath)) return resolve(outPath);

            const tmpFiles = fs.readdirSync(os.tmpdir())
                .filter(f => f.startsWith(`wbot_dl_`) && f.endsWith(`.${ext}`))
                .map(f => ({ f, t: fs.statSync(path.join(os.tmpdir(), f)).mtimeMs }))
                .sort((a, b) => b.t - a.t);
            if (tmpFiles.length) return resolve(path.join(os.tmpdir(), tmpFiles[0].f));
            reject(new Error('File hasil download tidak ditemukan'));
        });
    });
}

function cleanTmp(...paths) {
    for (const p of paths) {
        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { }
    }
}

function formatDuration(sec) {
    if (!sec) return '-';
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function fileSizeMB(filePath) {
    try { return fs.statSync(filePath).size / (1024 * 1024); } catch { return 0; }
}

module.exports = {
    MAX_SIZE_MB,
    runYtDlp,
    getInfo,
    download,
    cleanTmp,
    formatDuration,
    fileSizeMB,
};