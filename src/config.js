module.exports = {
    //Nama owner
    ownerName: 'Nelsen Creative',

    // Nama bot
    botName: 'Nelsen Studio Bot',

    footerTxt: 'Powered by nelsen.web.id',

    // Prefix command (contoh: ! . /)\
    prefix: ['!','.','/','#','?'],

    // Super Owner — hanya 1 nomor, akses penuh termasuk manage co-owner
    superOwner: '6285733370411',

    // Co-Owner — bisa lebih dari satu, akses owner biasa
    coOwner: [
        // '6289999999999',
    ],

    // Mode bot: 'public' → semua orang | 'self' → hanya owner
    botMode: 'self',

    // Otomatis centang biru pesan yang masuk
    autoRead: true,

    // Tampilkan indikator "mengetik..." saat membalas
    autoTyping: true,

    // Folder penyimpanan sesi login
    authFolder: './src/database/session',

    // Format: '120363xxxxxxxxx@newsletter'  — kosongkan jika tidak dipakai
    channelId: '120363185570235320@newsletter',
    
    // ═══════════════════════════════════════════════════════
    // LICENSE CONFIG (TAMBAH INI)
    // ═══════════════════════════════════════════════════════
    licenseKey: 'OTP-xxxxx',                    // ← Kode dari kamu
    botNumber: '6287811007088',                         // ← Nomor WA bot ini

    // ═══════════════════════════════════════════════════════
    // URL UNTUK BUTTON `!send`
    // ═══════════════════════════════════════════════════════
    //
    // Dipakai oleh command `!send {nomor}|{pesan}` di nelsen-studio.js
    // — tombol CTA_URL pada pesan yang bot kirim ke nomor tujuan
    // mengarah ke URL ini. Default mengikuti konvensi brand bot yang
    // lain: halaman utama Nelsen Studio. Ganti ke halaman internal
    // (mis. /inbox) kalau audience-nya user webapp — biarkan default
    // untuk audience umum.
    //
    // Contoh pesan yang dihasilkan:
    //   body:        "{pesan}"
    //   button text: "Buka Nelsen Studio"
    //   button url:  urlButtonSend
    //
    // Perubahan nilai ini langsung生效 tanpa restart karena command
    // baca `config.urlButtonSend` setiap kali dipanggil (bukan cache).
    urlButtonSend: 'https://nelsen.web.id',
};