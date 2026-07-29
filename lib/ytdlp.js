'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execSync } = require('child_process');

let cachedYtDlpPath = null;

/**
 * Resolve the yt-dlp binary path.
 *
 * Resolution order (first match wins):
 *   1. The `yt-dlp-wrap` npm package's bundled binary
 *      (`node_modules/yt-dlp-wrap/bin/yt-dlp` or
 *      `node_modules/yt-dlp-wrap/bin/yt-dlp.exe`).
 *      The binary is downloaded automatically when the package is
 *      installed (`npm install`), so the bot can run in a clean
 *      container without a separate `apt install yt-dlp` step.
 *   2. `which yt-dlp` — covers the case where the operator has
 *      installed yt-dlp system-wide (e.g. via pipx or apt) and
 *      prefers that binary.
 *   3. Throw with a clear actionable error.
 *
 * The path is cached after the first successful lookup — repeated
 * downloads don't pay the file-system stat cost.
 */
function getYtDlpPath() {
    if (cachedYtDlpPath) return cachedYtDlpPath;

    // 1) npm-bundled binary via yt-dlp-wrap.
    try {
        const { execPath } = require('yt-dlp-wrap');
        if (execPath && fs.existsSync(execPath)) {
            cachedYtDlpPath = execPath;
            return cachedYtDlpPath;
        }
    } catch (e) {
        // yt-dlp-wrap not installed — fall through to system PATH lookup.
    }

    // 2) System PATH fallback.
    try {
        const fromPath = execSync('which yt-dlp').toString().trim();
        if (fromPath && fs.existsSync(fromPath)) {
            cachedYtDlpPath = fromPath;
            return cachedYtDlpPath;
        }
    } catch (e) {
        // not on PATH either
    }

    // 3) Nothing found — throw a clear actionable message.
    throw new Error(
        'yt-dlp tidak ditemukan. Install dependency `yt-dlp-wrap` ' +
        '(binary akan otomatis terdownload via npm install), atau ' +
        'install yt-dlp di system (mis. pip install yt-dlp / pipx install yt-dlp).',
    );
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