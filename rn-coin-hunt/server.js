const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 5000;
app.use(express.json());

// ── Admin credentials file (set via setup, verified for API calls) ──
const ADMIN_CREDS_FILE  = path.join(__dirname, '.admin_creds.json');
const ADMIN_CONFIG_FILE = path.join(__dirname, '.admin_config.json');

function loadAdminCreds() {
    try { return JSON.parse(fs.readFileSync(ADMIN_CREDS_FILE, 'utf8')); } catch { return null; }
}
function saveAdminCreds(u, p) {
    fs.writeFileSync(ADMIN_CREDS_FILE, JSON.stringify({ u, p }), 'utf8');
}
function verifyAdminCreds(u, p) {
    const c = loadAdminCreds();
    return c && c.u === u && c.p === p;
}
function loadAdminConfig() {
    try { return JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveAdminConfig(cfg) {
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(cfg), 'utf8');
}

// ── Check if server has been set up (safe, no secrets exposed) ──
app.get('/api/admin/has-config', (req, res) => {
    const c = loadAdminCreds();
    res.json({ setup: !!(c && c.u && c.p) });
});

// ── Save admin credentials (called from setup step 1) ──
app.post('/api/admin/save-creds', (req, res) => {
    const { u, p } = req.body || {};
    if (!u || !p) return res.status(400).json({ ok: false, error: 'Missing credentials' });
    saveAdminCreds(u, p);
    res.json({ ok: true });
});

// ── Get full panel config (firebase, adminUids, etc.) ──
app.post('/api/admin/get-config', (req, res) => {
    const { u, p } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    const cfg = loadAdminConfig();
    res.json({ ok: true, config: cfg });
});

// ── Save full panel config (firebase, adminUids, etc.) ──
app.post('/api/admin/save-full-config', (req, res) => {
    const { u, p, config } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!config || typeof config !== 'object') return res.status(400).json({ ok: false, error: 'config required' });
    saveAdminConfig(config);
    res.json({ ok: true });
});

// ── Clear panel config (called on reset) ──
app.post('/api/admin/clear-config', (req, res) => {
    const { u, p } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    try { fs.unlinkSync(ADMIN_CREDS_FILE); } catch {}
    try { fs.unlinkSync(ADMIN_CONFIG_FILE); } catch {}
    res.json({ ok: true });
});

// ── Resolve a user input (email or Firestore UID) to a Firestore doc ID ──
async function resolveUserId(botDb, input) {
    if (!input) return null;
    if (input.includes('@')) {
        const snap = await botDb.collection('users').where('email', '==', input.toLowerCase().trim()).limit(1).get();
        if (snap.empty) return null;
        return snap.docs[0].id;
    }
    return input.trim();
}

// ── Adjust a user's coin balance (firebase-admin, bypasses Firestore auth) ──
app.post('/api/admin/adjust-coins', async (req, res) => {
    const { u, p, userId, delta, reason } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!userId || delta === undefined) return res.status(400).json({ ok: false, error: 'userId and delta required' });
    try {
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });
        const { FieldValue } = require('firebase-admin/firestore');
        const resolvedId = await resolveUserId(botDb, userId);
        if (!resolvedId) return res.status(404).json({ ok: false, error: 'No user found with that email or ID' });
        const ref = botDb.collection('users').doc(resolvedId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'User not found' });
        await ref.update({ balance: FieldValue.increment(Number(delta)) });
        const newBalance = (snap.data().balance || 0) + Number(delta);
        res.json({ ok: true, newBalance, name: snap.data().name || resolvedId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Ban / unban a user by ID or email ──
app.post('/api/admin/ban-user', async (req, res) => {
    const { u, p, userId, banned } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    try {
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });
        const resolvedId = await resolveUserId(botDb, userId);
        if (!resolvedId) return res.status(404).json({ ok: false, error: 'No user found with that email or ID' });
        const ref = botDb.collection('users').doc(resolvedId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'User not found' });
        await ref.update({ isBlocked: !!banned });
        res.json({ ok: true, name: snap.data().name || resolvedId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Send Telegram notification to a specific user (called when admin approves/rejects withdrawal from web panel) ──
app.post('/api/admin/notify-user', async (req, res) => {
    const { u, p, userId, message } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!userId || !message) return res.status(400).json({ ok: false, error: 'userId and message required' });
    try {
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });
        const snap = await botDb.collection('users').doc(userId).get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'User not found' });
        const ud = snap.data();
        const telegramId = ud.telegramId;
        if (!telegramId) return res.json({ ok: true, sent: false, reason: 'User has no Telegram ID linked' });
        const botModule = require('./bot/bot.js');
        if (!botModule || !botModule.enabled) return res.json({ ok: true, sent: false, reason: 'Bot not enabled' });
        await botModule.sendMessage(telegramId, message);
        res.json({ ok: true, sent: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── Broadcast notification via firebase-admin (bypasses Firestore auth rules) ──
app.post('/api/admin/broadcast', async (req, res) => {
    const { u, p, title, message } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!title || !message) return res.status(400).json({ ok: false, error: 'Title and message required' });
    try {
        // Use the bot's firebase-admin db (same process)
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });
        const { FieldValue } = require('firebase-admin/firestore');
        await botDb.collection('notifications').add({ title, message, createdAt: FieldValue.serverTimestamp() });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── Permanently delete a user from Firebase Auth + Firestore (admin only) ──
// Deletes both the Auth record (so same email can re-register) and the Firestore doc
// (so device fingerprint is also wiped — same device can re-register too).
app.post('/api/admin/delete-user', async (req, res) => {
    const { u, p, userId } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!userId) return res.status(400).json({ ok: false, error: 'userId (email or UID) required' });
    try {
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });

        const { FieldValue } = require('firebase-admin/firestore');
        const { getAuth: getAdminAuth } = require('firebase-admin/auth');

        // Resolve email → UID
        const resolvedId = await resolveUserId(botDb, userId);
        if (!resolvedId) return res.status(404).json({ ok: false, error: 'No user found with that email or ID' });

        // Get user data for the response
        const userSnap = await botDb.collection('users').doc(resolvedId).get();
        if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'User Firestore doc not found' });
        const userData = userSnap.data();

        // 1. Delete Firestore doc first (so re-registration works even if Auth step fails)
        await botDb.collection('users').doc(resolvedId).delete();

        // 2. Delete from Firebase Auth (allows re-registration with same email)
        let authDeleted = false;
        try {
            await getAdminAuth().deleteUser(resolvedId);
            authDeleted = true;
        } catch (authErr) {
            // auth/user-not-found means already deleted — that's fine
            if (authErr.code !== 'auth/user-not-found') {
                console.error('[delete-user] Auth delete failed (Firestore doc already deleted):', authErr.message);
                // Still return ok:true since Firestore was cleaned; log for manual Auth cleanup if needed
            }
        }

        res.json({
            ok: true,
            name: userData.name || resolvedId,
            email: userData.email || '',
            authDeleted,
            warning: authDeleted ? null : 'Firestore record deleted but Firebase Auth record may still exist. The user may need to contact support to re-register with the same email.'
        });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Check if device fingerprint already has an account (unauthenticated users can't query Firestore) ──
app.post('/api/check-device', async (req, res) => {
    const { fingerprint } = req.body || {};
    if (!fingerprint) return res.status(400).json({ ok: false, error: 'fingerprint required' });
    try {
        let db = null;
        try { db = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!db) return res.status(503).json({ ok: false, exists: false });
        const snap = await db.collection('users').where('deviceFingerprint', '==', fingerprint).limit(1).get();
        const exists = !snap.empty;
        const email = exists ? (snap.docs[0].data().email || '') : '';
        res.json({ ok: true, exists, email });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Apply referral code (server-side, bypasses Firestore auth rules so referrer gets credited) ──
app.post('/api/apply-referral', async (req, res) => {
    const { referralCode, userId, userName, userEmail } = req.body || {};
    if (!referralCode || !userId) return res.status(400).json({ ok: false, error: 'referralCode and userId required' });
    try {
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });
        const { FieldValue } = require('firebase-admin/firestore');

        // Validate current user exists and hasn't already used a code
        const userRef = botDb.collection('users').doc(userId);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'User not found' });
        if (userSnap.data().referredBy) return res.status(400).json({ ok: false, error: 'Already used a referral code' });

        // Find the referrer by code
        const refSnap = await botDb.collection('users').where('referralCode', '==', referralCode).limit(1).get();
        if (refSnap.empty) return res.status(404).json({ ok: false, error: 'Invalid referral code' });
        const referrerId = refSnap.docs[0].id;
        const referrerData = refSnap.docs[0].data();
        if (referrerId === userId) return res.status(400).json({ ok: false, error: 'Cannot use your own code' });

        // Read bonus/commission from config
        const cfgSnap = await botDb.collection('config').doc('main').get();
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        const bonus = cfg.referralBonus || 100;
        const signupBonusEnabled = cfg.signupBonusEnabled !== false;
        const referredName = userName || userEmail || 'A new user';

        if (signupBonusEnabled) {
            // Credit referrer (sign-up bonus only; withdrawal commission is handled separately on approval)
            await botDb.collection('users').doc(referrerId).update({ balance: FieldValue.increment(bonus) });
            // Credit current user (bonus) and mark referredBy
            await userRef.update({ balance: FieldValue.increment(bonus), referredBy: referralCode });
            // Earn history for referrer
            await botDb.collection('earn_history').add({
                userId: referrerId,
                type: 'referral_earned',
                amount: bonus,
                label: `Referral: ${referredName} joined`,
                fromUserId: userId,
                fromUserName: userName || '',
                createdAt: FieldValue.serverTimestamp()
            });
            // Earn history for referred user
            await botDb.collection('earn_history').add({
                userId,
                type: 'signup_bonus',
                amount: bonus,
                label: 'Referral sign-up bonus',
                createdAt: FieldValue.serverTimestamp()
            });
        } else {
            // Bonus disabled — just mark referredBy so commission still tracks later
            await userRef.update({ referredBy: referralCode });
        }

        // Referrals tracking doc (always record the referral relationship)
        await botDb.collection('referrals').add({
            referrerId,
            referralCode,
            referredId: userId,
            referredName: userName || '',
            referredEmail: userEmail || '',
            bonusGiven: signupBonusEnabled ? bonus : 0,
            createdAt: FieldValue.serverTimestamp()
        });

        res.json({ ok: true, bonus: signupBonusEnabled ? bonus : 0, referrerId, referrerName: referrerData.name || '' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── QR Code proxy — serves Telegram-hosted QR images via file_id ──
// This survives redeploys because images are fetched live from Telegram's
// servers using the stored file_id rather than the local uploads directory.
app.get('/api/qr-proxy', async (req, res) => {
    const fileId = req.query.fileId;
    const botToken = process.env.BOT_TOKEN;
    if (!fileId) return res.status(400).send('Missing fileId');
    if (!botToken) return res.status(503).send('Bot not configured');
    try {
        const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const fileInfo = await new Promise((resolve, reject) => {
            https.get(getFileUrl, r => {
                let data = '';
                r.on('data', chunk => data += chunk);
                r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
            }).on('error', reject);
        });
        if (!fileInfo.ok || !fileInfo.result?.file_path) return res.status(404).send('File not found');
        const imgUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
        https.get(imgUrl, imgRes => {
            res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            imgRes.pipe(res);
        }).on('error', err => res.status(500).send('Proxy error'));
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// Config endpoint — reads from Render environment variables
// User-app loads this to get Firebase config without hardcoding
app.get('/config.js', (req, res) => {
    res.type('application/javascript');
    res.send(`window.APP_CONFIG = ${JSON.stringify({
        firebase: {
            apiKey:            process.env.FIREBASE_API_KEY            || '',
            authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || '',
            projectId:         process.env.FIREBASE_PROJECT_ID         || '',
            storageBucket:     process.env.FIREBASE_STORAGE_BUCKET     || '',
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
            appId:             process.env.FIREBASE_APP_ID             || ''
        },
        botUsername: process.env.BOT_USERNAME  || '',
        miniAppUrl:  process.env.MINI_APP_URL  || '',
        serverUrl:   process.env.SERVER_URL    || ''
    })};`);
});

// Static file serving
app.use('/user-app',    express.static(path.join(__dirname, 'user-app')));
app.use('/admin-panel', express.static(path.join(__dirname, 'admin-panel')));
app.use('/uploads',     express.static(path.join(__dirname, 'bot', 'uploads')));

// Root page
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>RN Coin Hunt</title>
    <style>
        body { font-family: sans-serif; background: #09090f; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 1rem; margin: 0; }
        a { color: #f59e0b; font-size: 1.1rem; text-decoration: none; padding: 0.6rem 1.5rem; border: 1px solid #f59e0b44; border-radius: 0.5rem; transition: background 0.2s; }
        a:hover { background: #f59e0b22; }
    </style>
</head>
<body>
    <span style="font-size:3rem">🪙</span>
    <h2 style="margin:0">RN Coin Hunt</h2>
    <a href="/user-app/">Open User App</a>
    <a href="/admin-panel/">Open Admin Panel</a>
</body>
</html>`);
});

// ── IST date helper (Indian Standard Time = UTC+5:30) ──
function getISTDateString() {
    const now = new Date();
    const istMs = now.getTime() + (5 * 60 + 30) * 60 * 1000;
    return new Date(istMs).toISOString().split('T')[0];
}

// ── Today's Workers count (IST) ──
// A user "worked today" if any of their daily task date fields equals today's IST date.
app.get('/api/admin/today-workers', async (req, res) => {
    try {
        let db = null;
        try { db = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!db) return res.status(503).json({ ok: false, error: 'Firebase not configured' });

        const today = getISTDateString();
        const usersRef = db.collection('users');

        // Three separate queries (Firestore doesn't support OR across different fields)
        const [adSnap, mathSnap, checkinSnap] = await Promise.all([
            usersRef.where('lastAdWatchDate', '==', today).get(),
            usersRef.where('lastMathDate', '==', today).get(),
            usersRef.where('lastCheckInDate', '==', today).get(),
        ]);

        // Union by UID (deduplicate)
        const workerIds = new Set();
        adSnap.forEach(d => workerIds.add(d.id));
        mathSnap.forEach(d => workerIds.add(d.id));
        checkinSnap.forEach(d => workerIds.add(d.id));

        res.json({ ok: true, count: workerIds.size, date: today });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Eligibility Settings ──
// Config stored in Firestore: config/eligibility
// Structure: { withdrawal: [{taskId, label, required},...], coupon: [...], checkIn: [...] }

app.get('/api/eligibility', async (req, res) => {
    try {
        let db = null;
        try { db = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!db) return res.json({ ok: true, config: { withdrawal: [], coupon: [], checkIn: [] } });
        const snap = await db.collection('config').doc('eligibility').get();
        const config = snap.exists ? snap.data() : { withdrawal: [], coupon: [], checkIn: [] };
        res.json({ ok: true, config });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/eligibility', express.json(), async (req, res) => {
    try {
        let db = null;
        try { db = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!db) return res.status(503).json({ ok: false, error: 'Firebase not configured' });
        const { withdrawal, coupon, checkIn } = req.body;
        await db.collection('config').doc('eligibility').set({ withdrawal: withdrawal || [], coupon: coupon || [], checkIn: checkIn || [] });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Nightly 11:59 PM IST report to Telegram admins ──
function scheduleNightlyReport(botModule) {
    // 23:59 IST = 18:29 UTC (IST is UTC+5:30)
    function msUntilNext2359IST() {
        const now = new Date();
        const target = new Date(now);
        target.setUTCHours(18, 29, 0, 0); // 18:29 UTC = 23:59 IST
        if (now.getTime() >= target.getTime()) {
            target.setUTCDate(target.getUTCDate() + 1);
        }
        return target.getTime() - now.getTime();
    }

    async function sendNightlyReport() {
        try {
            let db = null;
            try { db = require('firebase-admin/firestore').getFirestore(); } catch {}
            if (!db || !botModule || !botModule.enabled) return;

            const today = getISTDateString();
            const usersRef = db.collection('users');
            const [adSnap, mathSnap, checkinSnap] = await Promise.all([
                usersRef.where('lastAdWatchDate', '==', today).get(),
                usersRef.where('lastMathDate', '==', today).get(),
                usersRef.where('lastCheckInDate', '==', today).get(),
            ]);
            const workerIds = new Set();
            adSnap.forEach(d => workerIds.add(d.id));
            mathSnap.forEach(d => workerIds.add(d.id));
            checkinSnap.forEach(d => workerIds.add(d.id));

            const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_TELEGRAM_IDS || '')
                .split(',').map(s => s.trim()).filter(Boolean);

            const msg = `📊 *Daily Worker Report*\n📅 Date: ${today}\n👷 Workers Today: *${workerIds.size}*\n_(Users who did at least one task)_`;
            for (const adminId of ADMIN_IDS) {
                await botModule.sendMessage(adminId, msg).catch(() => {});
            }
            console.log(`[Nightly Report] Sent for ${today}: ${workerIds.size} workers`);
        } catch (e) {
            console.error('[Nightly Report] Error:', e.message);
        }
        // Schedule next day's report (re-compute delay so it's always exactly on time)
        setTimeout(sendNightlyReport, msUntilNext2359IST());
    }

    const delay = msUntilNext2359IST();
    console.log(`[Nightly Report] Scheduled in ${Math.round(delay / 60000)} min (next 23:59 IST)`);
    setTimeout(sendNightlyReport, delay);
}

app.listen(PORT, () => {
    console.log(`RN Coin Hunt server running on port ${PORT}`);

    // Start the Telegram bot in the same process.
    // It uses long-polling, so it doesn't need its own port.
    // Main server traffic keeps the whole process awake on Render free tier.
    let botModule = null;
    try {
        botModule = require('./bot/bot.js');
    } catch (e) {
        console.error('Failed to start bot:', e.message);
    }

    // Schedule nightly 11:59 PM IST worker report to admins
    if (botModule) {
        scheduleNightlyReport(botModule);
    }
});
