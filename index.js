const express = require('express');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 2157; // Sesuai port di panel kamu
const CONTROL_KEY = 'yoxd1005';

// Middleware untuk parsing JSON dan menyajikan file statis
app.use(express.json());
app.use(express.static(__dirname)); // Menyajikan index.html

// Variabel global untuk menyimpan status koneksi
let sock = null;
let connectionState = 'close';
let lastQR = null;
let lastError = null;

// Fungsi untuk memulai koneksi WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // Kita akan kirim QR via API
        logger: pino({ level: 'warn' }),
        browser: ['Web Messenger', 'Chrome', '1.0.0']
    });

    // Simpan kredensial saat ada update
    sock.ev.on('creds.update', saveCreds);

    // Pantau perubahan koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            lastQR = qr; // Simpan string QR
        }

        if (connection) {
            connectionState = connection;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            lastError = lastDisconnect?.error?.message || 'Koneksi terputus';

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Mencoba menghubungkan ulang...');
                connectToWhatsApp(); // Coba hubungkan ulang
            } else {
                console.log('Sesi berakhir. Hapus folder auth_info dan mulai ulang.');
                sock = null;
                connectionState = 'loggedOut';
            }
        } else if (connection === 'open') {
            console.log('Terhubung ke WhatsApp!');
            lastQR = null;
            lastError = null;
        }
    });

    return sock;
}

// --- Middleware untuk memeriksa kunci kontrol ---
function checkAuth(req, res, next) {
    const key = req.headers['x-control-key'];
    if (key !== CONTROL_KEY) {
        return res.status(401).json({ error: 'Kunci panel salah.' });
    }
    next();
}

// --- API Endpoints ---

// 1. Memulai koneksi
app.post('/api/connect', checkAuth, async (req, res) => {
    try {
        if (!sock || connectionState === 'close' || connectionState === 'loggedOut') {
            await connectToWhatsApp();
        }
        res.json({ status: 'Koneksi dimulai. Silakan periksa status.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Memeriksa status
app.get('/api/status', checkAuth, async (req, res) => {
    let qrDataUrl = null;
    if (lastQR) {
        qrDataUrl = await QRCode.toDataURL(lastQR);
    }
    res.json({
        state: connectionState,
        status: connectionState === 'open' ? 'Terhubung' : 'Menunggu koneksi',
        error: lastError,
        qr: qrDataUrl
    });
});

// 3. Meminta kode pasangan (pairing code)
app.post('/api/pair-code', checkAuth, async (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ error: 'Nomor telepon harus diisi.' });
    }

    if (!sock) {
        return res.status(400).json({ error: 'Koneksi belum dimulai. Tekan "Mulai koneksi" dulu.' });
    }

    try {
        const code = await sock.requestPairingCode(phone);
        res.json({ code: code, status: 'Masukkan kode ini di WhatsApp.' });
    } catch (error) {
        res.status(500).json({ error: 'Gagal meminta kode: ' + error.message });
    }
});

// 4. Mengirim pesan
app.post('/api/send', checkAuth, async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: 'Nomor dan pesan harus diisi.' });
    }

    if (!sock || connectionState !== 'open') {
        return res.status(400).json({ error: 'WhatsApp belum terhubung.' });
    }

    try {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ message: 'Pesan berhasil dikirim!' });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengirim pesan: ' + error.message });
    }
});

// 5. Memutuskan sesi
app.post('/api/disconnect', checkAuth, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
            sock = null;
        }
        connectionState = 'close';
        res.json({ status: 'Sesi WhatsApp telah diputuskan.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Jalankan server
app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
    connectToWhatsApp(); // Otomatis coba connect saat server start
});
