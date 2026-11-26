require('dotenv').config();
const path = require('path');
const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Subjek default notifikasi member Xs-Pedia
const DEFAULT_SUBJECT = 'Notifikasi Web Xs-Pedia';

// Konfigurasi OAuth2 Gmail API
function getGmailClient() {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const redirectUri = process.env.GMAIL_REDIRECT_URI || 'https://developers.google.com/oauthplayground';
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
        return null;
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Encode pesan RFC 2822 ke base64url untuk Gmail API messages.send
function encodeRawEmail({ from, to, subject, text }) {
    const safeSubject = (subject || DEFAULT_SUBJECT).replace(/[\r\n]+/g, ' ').trim();
    const lines = [
        from ? `From: ${from}` : null,
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(safeSubject, 'utf8').toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || ''
    ].filter(Boolean);

    return Buffer.from(lines.join('\r\n'), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

async function sendSingleGmail({ gmail, senderEmail, to, subject, message }) {
    const raw = encodeRawEmail({
        from: senderEmail || undefined,
        to,
        subject: subject || DEFAULT_SUBJECT,
        text: message
    });

    const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw }
    });

    return {
        to,
        messageId: res.data && res.data.id ? res.data.id : null
    };
}

// Halaman admin HTML (5 halaman)
const htmlRoutes = {
    '/admin/dashboard': 'dashboard.html',
    '/admin/users': 'users.html',
    '/admin/deposit': 'deposit.html',
    '/admin/order': 'order.html',
    '/admin/notif-member': 'notif-member.html'
};

Object.entries(htmlRoutes).forEach(([routePath, fileName]) => {
    app.get(routePath, (req, res) => {
        res.sendFile(path.join(__dirname, fileName));
    });
});

// Endpoint pengiriman notifikasi member via Gmail API
app.post('/admin/notif-member/send', async (req, res) => {
    try {
        const { sendToAll, emails, subject, message } = req.body || {};
        const finalSubject = (typeof subject === 'string' && subject.trim())
            ? subject.trim()
            : DEFAULT_SUBJECT;
        const finalMessage = typeof message === 'string' ? message.trim() : '';

        if (!finalMessage) {
            return res.status(400).json({
                success: false,
                message: 'Isi pesan notifikasi wajib diisi.'
            });
        }

        // Ambil daftar target gmail dari body atau sumber data member
        let targetEmails = [];
        if (Array.isArray(emails) && emails.length > 0) {
            targetEmails = emails
                .map((e) => String(e || '').trim())
                .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        }

        if (sendToAll && targetEmails.length === 0 && typeof req.app.locals.getMemberEmails === 'function') {
            const fetched = await req.app.locals.getMemberEmails();
            targetEmails = (Array.isArray(fetched) ? fetched : [])
                .map((e) => String(e || '').trim())
                .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        }

        targetEmails = [...new Set(targetEmails)];

        if (targetEmails.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Tidak ada alamat Gmail tujuan yang valid.'
            });
        }

        const gmail = getGmailClient();
        if (!gmail) {
            return res.status(500).json({
                success: false,
                message: 'Kredensial Gmail API belum dikonfigurasi (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN).'
            });
        }

        const senderEmail = (process.env.GMAIL_SENDER_EMAIL || '').trim();
        const results = [];
        const errors = [];

        for (const recipient of targetEmails) {
            try {
                const sent = await sendSingleGmail({
                    gmail,
                    senderEmail,
                    to: recipient,
                    subject: finalSubject,
                    message: finalMessage
                });
                results.push(sent);
            } catch (err) {
                errors.push({
                    to: recipient,
                    error: err && err.message ? err.message : 'Gagal mengirim email'
                });
            }
        }

        if (results.length === 0) {
            return res.status(502).json({
                success: false,
                message: `Gagal mengirim notifikasi ke seluruh tujuan (${errors.length} gagal).`,
                subject: finalSubject,
                results,
                errors
            });
        }

        return res.json({
            success: true,
            message: `Notifikasi "${finalSubject}" berhasil dikirim ke ${results.length} Gmail${errors.length ? ` (${errors.length} gagal)` : ''}.`,
            subject: finalSubject,
            sentCount: results.length,
            failedCount: errors.length,
            results,
            errors
        });
    } catch (error) {
        console.error('Error /admin/notif-member/send:', error);
        return res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat mengirim notifikasi Gmail.'
        });
    }
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server Xs-Pedia Notification berjalan di port ${PORT} | Subjek default: "${DEFAULT_SUBJECT}"`);
    });
}

module.exports = app;
